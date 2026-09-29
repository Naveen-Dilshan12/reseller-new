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
import { badRequest, notFoundError } from '../../middleware/error.middleware'
import { hasPermission } from '../../rbac/permissions'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { paginationSchema, toSkipTake } from '../../utils/pagination'
import { sendPaginated, sendSuccess } from '../../utils/response'
import { auditService } from '../audit-logs/audit.service'
import { integrationService } from '../integrations/integration.service'
import { resellerAccessService } from '../products/reseller-access.service'

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

const customersQuery = paginationSchema.extend({
  resellerId: z.string().max(40).optional(),
  search: z.string().trim().max(100).optional(),
})

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
    if (!reseller) throw notFoundError('Reseller')
    if (reseller.status !== 'ACTIVE') throw badRequest('Reseller is not active')
    await resellerAccessService.assertCanSell(input.resellerId, input.productId)

    const account = await prisma.$transaction(async (tx) => {
      let customerId = input.customerId
      if (customerId) {
        const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { resellerId: true } })
        if (!customer || customer.resellerId !== input.resellerId) throw badRequest('Customer does not belong to this reseller')
      } else {
        customerId = (await tx.customer.create({ data: { resellerId: input.resellerId, displayName: input.customerName! } })).id
      }
      const created = await tx.customerAccount.create({
        data: {
          resellerId: input.resellerId,
          customerId,
          productId: input.productId,
          externalTenantId: input.externalTenantId,
          externalAccountId: input.externalAccountId,
          status: input.status,
        },
        include: accountInclude,
      })
      await auditService.fromRequest(
        req,
        {
          action: 'CUSTOMER_ACCOUNT_LINKED',
          entityType: 'CustomerAccount',
          entityId: created.id,
          resellerId: created.resellerId,
          metadata: {
            customerId,
            productId: input.productId,
            externalTenantId: input.externalTenantId,
            externalAccountId: input.externalAccountId ?? null,
          },
        },
        tx,
      )
      return created
    })
    sendSuccess(res, account, 'Customer account linked', 201)
  }),
)

export const customersRouter = Router()
customersRouter.use(authenticate)

customersRouter.get(
  '/',
  requirePermission('accounts:read'),
  validate(customersQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof customersQuery>
    const where: Prisma.CustomerWhereInput = {
      resellerId: resolveResellerId(req, q.resellerId),
      ...(q.search ? { displayName: { contains: q.search, mode: 'insensitive' } } : {}),
    }
    const [items, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: {
          accounts: {
            select: {
              id: true,
              status: true,
              externalTenantId: true,
              product: { select: { id: true, code: true, name: true, monthlyPrice: true, currency: true } },
            },
          },
        },
        orderBy: { displayName: 'asc' },
        ...toSkipTake(q),
      }),
      prisma.customer.count({ where }),
    ])
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)
