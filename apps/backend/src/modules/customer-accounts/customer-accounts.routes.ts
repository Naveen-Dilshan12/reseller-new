import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import {
  assertResellerAccess,
  authenticate,
  requirePermission,
  resolveResellerId,
} from '../../middleware/auth.middleware'
import { badRequest, forbidden, notFoundError } from '../../middleware/error.middleware'
import { hasPermission } from '../../rbac/permissions'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { paginationSchema, toSkipTake } from '../../utils/pagination'
import { sendPaginated, sendSuccess } from '../../utils/response'
import { auditService } from '../audit-logs/audit.service'
import { integrationService } from '../integrations/integration.service'
import { resellerAccessService } from '../products/reseller-access.service'
import { findOrCreateCustomer, linkTrialAccount } from './customer-linking'

const ACCOUNT_STATUSES = ['PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'] as const
const externalId = z.string().trim().min(1).max(100)

const listSchema = paginationSchema.extend({
  resellerId: z.string().max(40).optional(),
  productId: z.string().max(40).optional(),
  customerId: z.string().max(40).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
})

/**
 * Links a tenant that already exists in a SaaS product to a reseller's
 * customer. Only identifiers are stored. ACTIVE is reached through a
 * PAYMENT_VERIFIED subscription event so that commission is generated.
 * A tenant ID is always required, and PENDING means "no tenant yet", so the
 * account is always linked as TRIAL.
 */
const linkSchema = z
  .object({
    resellerId: z.string().min(1).max(40),
    productId: z.string().min(1).max(40),
    customerId: z.string().min(1).max(40).optional(),
    customerName: z.string().trim().min(2).max(150).optional(),
    externalTenantId: externalId,
    externalAccountId: externalId.optional(),
    status: z.enum(['PENDING', 'TRIAL']).default('TRIAL'),
  })
  .strict()
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customerName), {
    message: 'Choose an existing customer or enter a new customer name',
    path: ['customerName'],
  })
  .refine((v) => !(v.status === 'PENDING' && v.externalTenantId), {
    message: 'A PENDING account cannot have a tenant ID. Link an existing tenant as TRIAL.',
    path: ['status'],
  })

/** Display states a reseller can filter their customers by (mirrors the Customers page badges). */
const CUSTOMER_STATES = ['ACTIVE', 'TRIAL', 'ACTIVATION_REVIEW', 'PENDING_SETUP', 'TRIAL_FAILED'] as const
type CustomerState = (typeof CUSTOMER_STATES)[number]

const customersQuery = paginationSchema.extend({
  resellerId: z.string().max(40).optional(),
  search: z.string().trim().max(100).optional(),
  productId: z.string().max(40).optional(),
  status: z.enum(CUSTOMER_STATES).optional(),
})

const OPEN_ACTIVATION = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'] as const

/**
 * Account-level `where` for one display state. Order of precedence matches the UI:
 * ACTIVE, then an open activation request, then TRIAL, then pending-account sub-states.
 * (An account can have at most one open activation request, so "has an open one" is the
 * same as "its latest one is open".)
 */
function accountStateWhere(state: CustomerState): Prisma.CustomerAccountWhereInput {
  const openActivation: Prisma.CustomerAccountWhereInput = { activationRequests: { some: { status: { in: [...OPEN_ACTIVATION] } } } }
  const noOpenActivation: Prisma.CustomerAccountWhereInput = { activationRequests: { none: { status: { in: [...OPEN_ACTIVATION] } } } }
  const inProgressTrial: Prisma.CustomerAccountWhereInput = { trialRequests: { some: { status: { in: ['PENDING', 'SUBMITTED'] } } } }
  const failedTrial: Prisma.CustomerAccountWhereInput = { trialRequests: { some: { status: 'FAILED' } } }
  switch (state) {
    case 'ACTIVE':
      return { status: 'ACTIVE' }
    case 'ACTIVATION_REVIEW':
      return { status: { not: 'ACTIVE' }, ...openActivation }
    case 'TRIAL':
      // "Trial pipeline": active trials plus trials still being provisioned
      return { AND: [noOpenActivation, { OR: [{ status: 'TRIAL' }, { status: 'PENDING', ...inProgressTrial }] }] }
    case 'TRIAL_FAILED':
      return { AND: [noOpenActivation, { status: 'PENDING', NOT: inProgressTrial }, failedTrial] }
    case 'PENDING_SETUP':
      return { AND: [noOpenActivation, { status: 'PENDING', NOT: inProgressTrial }, { NOT: failedTrial }] }
  }
}

const accountInclude = {
  customer: { select: { id: true, displayName: true } },
  product: { select: { id: true, code: true, name: true } },
  reseller: { select: { id: true, code: true, businessName: true } },
} satisfies Prisma.CustomerAccountInclude

export const customerAccountsRouter = Router()
customerAccountsRouter.use(authenticate)

customerAccountsRouter.get(
  '/',
  requirePermission('accounts:read'),
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>
    const where: Prisma.CustomerAccountWhereInput = {
      resellerId: resolveResellerId(req, q.resellerId),
      productId: q.productId,
      customerId: q.customerId,
      status: q.status,
      ...(q.search
        ? {
            OR: [
              { customer: { displayName: { contains: q.search, mode: 'insensitive' } } },
              { externalTenantId: { contains: q.search, mode: 'insensitive' } },
              { externalAccountId: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
    const [items, total] = await Promise.all([
      prisma.customerAccount.findMany({ where, include: accountInclude, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
      prisma.customerAccount.count({ where }),
    ])
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

customerAccountsRouter.get(
  '/:id',
  requirePermission('accounts:read'),
  asyncHandler(async (req, res) => {
    const account = await prisma.customerAccount.findUnique({
      where: { id: req.params.id },
      include: {
        ...accountInclude,
        product: { select: { id: true, code: true, name: true, monthlyPrice: true, currency: true } },
        subscriptionEvents: { orderBy: { createdAt: 'desc' }, take: 24 },
        ...(hasPermission(req.user!.role, 'commissions:read')
          ? { commissions: { orderBy: { createdAt: 'desc' as const }, take: 24 } }
          : {}),
      },
    })
    if (!account) throw notFoundError('Customer account')
    assertResellerAccess(req, account.resellerId)
    sendSuccess(res, account)
  }),
)

/** Live tenant status straight from the SaaS; shown to the user, not stored. */
customerAccountsRouter.get(
  '/:id/live-status',
  requirePermission('accounts:sync'),
  asyncHandler(async (req, res) => {
    const account = await prisma.customerAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true, resellerId: true, productId: true, externalTenantId: true },
    })
    if (!account) throw notFoundError('Customer account')
    assertResellerAccess(req, account.resellerId)
    sendSuccess(res, await integrationService.liveAccountStatus(account))
  }),
)

customerAccountsRouter.post(
  '/',
  requirePermission('accounts:manage'),
  validate(linkSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof linkSchema>
    const reseller = await prisma.reseller.findUnique({ where: { id: input.resellerId }, select: { status: true } })
    if (!reseller) throw notFoundError('Partner')
    if (reseller.status !== 'ACTIVE') throw badRequest('Partner is not active')
    const product = await resellerAccessService.assertCanSell(input.resellerId, input.productId)

    const { account, outcome } = await prisma.$transaction(async (tx) => {
      let customerId = input.customerId
      if (customerId) {
        const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { resellerId: true } })
        if (!customer || customer.resellerId !== input.resellerId) throw badRequest('Customer does not belong to this partner')
      } else {
        // Same matching and customer-code rules as the trial and demo flows, so no duplicate customer is created.
        customerId = await findOrCreateCustomer(tx, input.resellerId, input.customerName!)
      }
      // The shared linking guards: one account per customer + product, one tenant per account, never over a paid one.
      const link = await linkTrialAccount(tx, {
        resellerId: input.resellerId,
        customerId,
        productId: input.productId,
        productName: product.name,
        externalTenantId: input.externalTenantId,
        externalAccountId: input.externalAccountId,
      })
      const linked = await tx.customerAccount.findUniqueOrThrow({ where: { id: link.accountId }, include: accountInclude })
      if (link.outcome !== 'UNCHANGED') {
        await auditService.fromRequest(
          req,
          {
            action: 'CUSTOMER_ACCOUNT_LINKED',
            entityType: 'CustomerAccount',
            entityId: linked.id,
            resellerId: linked.resellerId,
            metadata: {
              customerId,
              productId: input.productId,
              externalTenantId: input.externalTenantId,
              externalAccountId: input.externalAccountId ?? null,
              outcome: link.outcome,
            },
          },
          tx,
        )
      }
      return { account: linked, outcome: link.outcome }
    })
    if (outcome === 'CREATED') return sendSuccess(res, account, 'Customer account linked', 201)
    sendSuccess(res, account, outcome === 'ATTACHED' ? 'SaaS tenant linked to the existing customer account' : 'Customer account was already linked')
  }),
)

export const customersRouter = Router()
customersRouter.use(authenticate)

const customerAccountItemSelect = {
  id: true,
  status: true,
  externalTenantId: true,
  product: { select: { id: true, code: true, name: true, monthlyPrice: true, currency: true } },
  trialRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, errorMessage: true, errorRetryable: true, attempts: true, createdAt: true },
  },
  activationRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, reference: true, status: true, submittedAt: true },
  },
} satisfies Prisma.CustomerAccountSelect

customersRouter.get(
  '/',
  requirePermission('accounts:read'),
  validate(customersQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof customersQuery>
    const resellerId = resolveResellerId(req, q.resellerId)
    const searchWhere: Prisma.CustomerWhereInput = q.search
      ? {
          OR: [
            { displayName: { contains: q.search, mode: 'insensitive' } },
            { customerCode: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}

    // Filters are applied in the database so pagination and totals stay correct on every page.
    const accountWhere: Prisma.CustomerAccountWhereInput = {
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.status ? accountStateWhere(q.status) : {}),
    }
    const filteringAccounts = Boolean(q.productId || q.status)
    const where: Prisma.CustomerWhereInput = {
      resellerId,
      ...searchWhere,
      ...(filteringAccounts ? { accounts: { some: accountWhere } } : {}),
    }

    // KPI counts: accounts per state for the same reseller/search/product scope, ignoring the status filter.
    const kpiScope: Prisma.CustomerAccountWhereInput = {
      resellerId,
      ...(q.productId ? { productId: q.productId } : {}),
      customer: searchWhere,
    }
    const [items, total, active, trial, inReview] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: {
          accounts: {
            // When filtering, only return the accounts that match so every row shown matches the filter.
            ...(filteringAccounts ? { where: accountWhere } : {}),
            select: customerAccountItemSelect,
          },
        },
        orderBy: { displayName: 'asc' },
        ...toSkipTake(q),
      }),
      prisma.customer.count({ where }),
      prisma.customerAccount.count({ where: { ...kpiScope, ...accountStateWhere('ACTIVE') } }),
      prisma.customerAccount.count({ where: { AND: [kpiScope, accountStateWhere('TRIAL')] } }),
      prisma.customerAccount.count({ where: { AND: [kpiScope, accountStateWhere('ACTIVATION_REVIEW')] } }),
    ])
    sendPaginated(res, items, total, q.page, q.limit, { pipelineCounts: { active, trial, inReview } })
  }),
)

customersRouter.post(
  '/',
  requirePermission('accounts:read'),
  asyncHandler(async () => {
    throw forbidden(
      'Standalone customer creation is disabled. Customer records must be created automatically through the Free Trial creation workflow.'
    )
  }),
)

customersRouter.get(
  '/:id',
  requirePermission('accounts:read'),
  asyncHandler(async (req, res) => {
    const isCode = req.params.id.startsWith('CUS-')
    const customer = await prisma.customer.findFirst({
      where: isCode ? { customerCode: req.params.id } : { id: req.params.id },
      include: {
        accounts: {
          select: customerAccountItemSelect,
        },
      },
    })
    if (!customer) throw notFoundError('Customer')
    assertResellerAccess(req, customer.resellerId)
    sendSuccess(res, customer)
  }),
)
