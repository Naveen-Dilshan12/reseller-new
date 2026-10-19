import type { Request } from 'express'
import { Prisma } from '@prisma/client'
import type { ActivationRequestStatus, CommissionStatus, DemoRequestStatus, SaasProductStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { AppError, notFoundError } from '../../middleware/error.middleware'
import { auditService } from '../audit-logs/audit.service'
import type { ComingSoonProductInput, LaunchProductInput, RestoreProductInput, RetireProductInput } from './product.schema'
import { productService } from './product.service'

type Db = Prisma.TransactionClient | typeof prisma

/** Requests still being worked on (the same definitions the activation and demo modules use). */
const OPEN_ACTIVATION_STATUSES: ActivationRequestStatus[] = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED']
const OPEN_DEMO_STATUSES: DemoRequestStatus[] = ['PENDING', 'APPROVED', 'DEMO_CREATED']
const UNPAID_COMMISSION_STATUSES: CommissionStatus[] = ['PENDING', 'APPROVED', 'PAYABLE']

const RETIRABLE: SaasProductStatus[] = ['ACTIVE', 'COMING_SOON']
const RESTORABLE: SaasProductStatus[] = ['INACTIVE']
const COMING_SOON_SETTABLE: SaasProductStatus[] = ['ACTIVE', 'INACTIVE']
const LAUNCHABLE: SaasProductStatus[] = ['COMING_SOON']
const STATUS_WORDS: Record<SaasProductStatus, string> = { ACTIVE: 'active', INACTIVE: 'inactive', COMING_SOON: 'coming soon' }
const MISSING_ACCESS_LIMIT = 200

/** What retiring or restoring touches, as counts only (never names or contact details). Also the audit snapshot. */
export type ProductImpact = {
  customerAccounts: { active: number; trial: number; pending: number }
  openActivationRequests: number
  openDemoRequests: { total: number; awaitingConfirmation: number }
  unpaidCommissions: { count: number; totals: Array<{ currency: string; amount: string }> }
  resellers: { withAccess: number; approvedWithoutAccess: number }
}

/**
 * Approved resellers with no access record at all for the product: for example resellers approved while it was
 * inactive, or before it was added. Suspended or revoked records are deliberate decisions and are not "missing".
 */
const withoutAccess = (productId: string): Prisma.ResellerWhereInput => ({ status: 'ACTIVE', productAccess: { none: { productId } } })

export async function productImpact(db: Db, productId: string): Promise<ProductImpact> {
  const [accounts, openActivationRequests, demos, commissions, withAccess, approvedWithoutAccess] = await Promise.all([
    db.customerAccount.groupBy({ by: ['status'], where: { productId }, _count: { _all: true } }),
    db.activationRequest.count({ where: { productId, status: { in: OPEN_ACTIVATION_STATUSES } } }),
    db.demoRequest.groupBy({ by: ['status'], where: { productId, status: { in: OPEN_DEMO_STATUSES } }, _count: { _all: true } }),
    db.commission.groupBy({
      by: ['currency'],
      where: { productId, status: { in: UNPAID_COMMISSION_STATUSES } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    db.resellerProductAccess.count({ where: { productId, status: 'ACTIVE' } }),
    db.reseller.count({ where: withoutAccess(productId) }),
  ])
  const accountsIn = (status: string) => accounts.find((a) => a.status === status)?._count._all ?? 0
  return {
    customerAccounts: { active: accountsIn('ACTIVE'), trial: accountsIn('TRIAL'), pending: accountsIn('PENDING') },
    openActivationRequests,
    openDemoRequests: {
      total: demos.reduce((sum, d) => sum + d._count._all, 0),
      awaitingConfirmation: demos.find((d) => d.status === 'DEMO_CREATED')?._count._all ?? 0,
    },
    unpaidCommissions: {
      count: commissions.reduce((sum, c) => sum + c._count._all, 0),
      totals: commissions
        .map((c) => ({ currency: c.currency, amount: (c._sum.amount ?? new Prisma.Decimal(0)).toFixed(2) }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    },
    resellers: { withAccess, approvedWithoutAccess },
  }
}

const lifecycleConflict = (message: string) => new AppError(message, 409, undefined, 'PRODUCT_LIFECYCLE_CONFLICT')
const productChanged = (message: string) => new AppError(message, 409, undefined, 'PRODUCT_CHANGED')

interface LifecycleChange {
  from: SaasProductStatus[]
  to: SaasProductStatus
  expectedUpdatedAt: Date
  action: 'SAAS_PRODUCT_RETIRED' | 'SAAS_PRODUCT_RESTORED' | 'SAAS_PRODUCT_SET_COMING_SOON' | 'SAAS_PRODUCT_LAUNCHED'
  refusal: (current: SaasProductStatus) => string
  details: Record<string, string | null>
}

/**
 * Moves a product between lifecycle states. The status change and its audit entry (with an impact snapshot) commit
 * together. Only the status changes: nothing is deleted, and reseller access, the integration and every customer,
 * request and commission record stay exactly as they are.
 */
async function changeLifecycle(req: Request, id: string, change: LifecycleChange) {
  await prisma.$transaction(async (tx) => {
    const before = await tx.saasProduct.findUnique({ where: { id }, select: { status: true, updatedAt: true } })
    if (!before) throw notFoundError('SaaS product')
    if (!change.from.includes(before.status)) throw lifecycleConflict(change.refusal(before.status))
    if (before.updatedAt.getTime() !== change.expectedUpdatedAt.getTime()) {
      throw productChanged('This product has been changed since you opened it. Reload it to see the latest version; nothing was changed.')
    }
    // The UPDATE re-checks status and version itself, so of two simultaneous requests only one can succeed.
    const result = await tx.saasProduct.updateMany({
      where: { id, status: before.status, updatedAt: change.expectedUpdatedAt },
      data: { status: change.to },
    })
    if (result.count === 0) {
      throw productChanged('This product was changed by someone else at the same time. Reload it and try again; nothing was changed.')
    }
    const impact = await productImpact(tx, id)
    await auditService.fromRequest(
      req,
      { action: change.action, entityType: 'SaasProduct', entityId: id, metadata: { ...change.details, from: before.status, to: change.to, impact } },
      tx,
    )
  })
  return productService.get(id)
}

export const productLifecycleService = {
  /** What retiring or restoring the product would touch. Read-only. */
  async impact(id: string) {
    const product = await prisma.saasProduct.findUnique({ where: { id }, select: { id: true, status: true } })
    if (!product) throw notFoundError('SaaS product')
    return { productId: product.id, status: product.status, ...(await productImpact(prisma, id)) }
  },

  /** Takes an active or coming-soon product off sale (INACTIVE). The reason is required and recorded. */
  retire(id: string, input: RetireProductInput, req: Request) {
    return changeLifecycle(req, id, {
      from: RETIRABLE,
      to: 'INACTIVE',
      expectedUpdatedAt: input.expectedUpdatedAt,
      action: 'SAAS_PRODUCT_RETIRED',
      refusal: (status) => `This product is ${STATUS_WORDS[status]}; only active or coming-soon products can be retired.`,
      details: { reason: input.reason },
    })
  },

  /**
   * Puts an inactive product back on sale (ACTIVE) for the resellers who still have active access. Nobody else is given
   * access: resellers approved while it was inactive have to be granted access explicitly, one reseller at a time.
   */
  restore(id: string, input: RestoreProductInput, req: Request) {
    return changeLifecycle(req, id, {
      from: RESTORABLE,
      to: 'ACTIVE',
      expectedUpdatedAt: input.expectedUpdatedAt,
      action: 'SAAS_PRODUCT_RESTORED',
      refusal: (status) => `This product is ${STATUS_WORDS[status]}; only inactive products can be restored.`,
      details: { note: input.note || null },
    })
  },

  /**
   * Marks an active or inactive product as not launched yet (COMING_SOON). Only ACTIVE sells, so from ACTIVE this takes
   * the product off sale like Retire does, and the reason is required and recorded in the same way; from INACTIVE nothing
   * changes for resellers or customers.
   */
  comingSoon(id: string, input: ComingSoonProductInput, req: Request) {
    return changeLifecycle(req, id, {
      from: COMING_SOON_SETTABLE,
      to: 'COMING_SOON',
      expectedUpdatedAt: input.expectedUpdatedAt,
      action: 'SAAS_PRODUCT_SET_COMING_SOON',
      refusal: (status) => `This product is ${STATUS_WORDS[status]}; only active or inactive products can be set to coming soon.`,
      details: { reason: input.reason },
    })
  },

  /**
   * Puts a coming-soon product on sale (ACTIVE) for the resellers who already have active access. As with Restore, nobody
   * else is given access: resellers approved while it was coming soon have to be granted access one reseller at a time.
   */
  launch(id: string, input: LaunchProductInput, req: Request) {
    return changeLifecycle(req, id, {
      from: LAUNCHABLE,
      to: 'ACTIVE',
      expectedUpdatedAt: input.expectedUpdatedAt,
      action: 'SAAS_PRODUCT_LAUNCHED',
      refusal: (status) => `This product is ${STATUS_WORDS[status]}; only coming-soon products can be launched.`,
      details: { note: input.note || null },
    })
  },

  /** Approved resellers without any access record for the product, for an admin to review one by one. Read-only. */
  async resellersWithoutAccess(id: string) {
    const product = await prisma.saasProduct.findUnique({ where: { id }, select: { id: true } })
    if (!product) throw notFoundError('SaaS product')
    const where = withoutAccess(id)
    const [total, items] = await Promise.all([
      prisma.reseller.count({ where }),
      prisma.reseller.findMany({
        where,
        select: { id: true, code: true, businessName: true, approvedAt: true },
        orderBy: [{ businessName: 'asc' }, { id: 'asc' }],
        take: MISSING_ACCESS_LIMIT,
      }),
    ])
    return { total, limit: MISSING_ACCESS_LIMIT, items }
  },
}
