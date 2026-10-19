import type { Request } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { badRequest, notFoundError } from '../../middleware/error.middleware'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import type { SetAccessInput } from './product.schema'
import { PUBLIC_PRODUCT_SELECT } from './product.service'

type Db = Prisma.TransactionClient | typeof prisma

export const resellerAccessService = {
  /** Every product with this reseller's access status (null when never granted). */
  async list(resellerId: string) {
    const reseller = await prisma.reseller.findUnique({ where: { id: resellerId }, select: { id: true } })
    if (!reseller) throw notFoundError('Partner')
    const products = await prisma.saasProduct.findMany({
      select: {
        ...PUBLIC_PRODUCT_SELECT,
        integrationStatus: true,
        resellerAccess: { where: { resellerId }, select: { status: true, note: true, statusChangedAt: true } },
        _count: { select: { accounts: { where: { resellerId } } } },
      },
      orderBy: { name: 'asc' },
    })
    return products.map(({ resellerAccess, _count, ...product }) => ({
      product,
      access: resellerAccess[0] ?? null,
      customerAccounts: _count.accounts,
    }))
  },

  async set(resellerId: string, productId: string, input: SetAccessInput, req: Request) {
    const [reseller, product] = await Promise.all([
      prisma.reseller.findUnique({ where: { id: resellerId }, select: { id: true } }),
      prisma.saasProduct.findUnique({ where: { id: productId }, select: { name: true } }),
    ])
    if (!reseller) throw notFoundError('Partner')
    if (!product) throw notFoundError('SaaS product')

    const now = new Date()
    // An omitted note keeps the stored one (the admin UI leaves it out when the field is blank);
    // an explicit empty string clears it.
    const note = input.note === undefined ? undefined : input.note || null
    const access = await prisma.$transaction(async (tx) => {
      const previous = await tx.resellerProductAccess.findUnique({
        where: { resellerId_productId: { resellerId, productId } },
        select: { status: true },
      })
      const saved = await tx.resellerProductAccess.upsert({
        where: { resellerId_productId: { resellerId, productId } },
        create: { resellerId, productId, status: input.status, note, grantedById: req.user!.userId, statusChangedAt: now },
        update: {
          status: input.status,
          ...(note !== undefined ? { note } : {}),
          ...(previous?.status !== input.status ? { statusChangedAt: now } : {}),
        },
      })
      await auditService.fromRequest(
        req,
        {
          action: 'RESELLER_PRODUCT_ACCESS_CHANGED',
          entityType: 'ResellerProductAccess',
          entityId: saved.id,
          resellerId,
          metadata: { productId, from: previous?.status ?? null, to: input.status, note: input.note ?? null },
        },
        tx,
      )
      return { saved, previous: previous?.status ?? null }
    })

    if (access.previous !== input.status) {
      const verb = { ACTIVE: 'enabled', SUSPENDED: 'suspended', REVOKED: 'revoked' }[input.status]
      await notificationService.notifyReseller(resellerId, {
        type: 'PRODUCT_ACCESS_CHANGED',
        title: `${product.name} access ${verb}`,
        body: input.note ? `${product.name}: ${input.note}` : `Your access to ${product.name} was ${verb}.`,
        link: '/dashboard',
      })
    }
    return access.saved
  },

  /** Grants every ACTIVE product to a newly approved reseller; admins can adjust afterwards. */
  async grantDefaults(db: Db, resellerId: string, grantedById: string) {
    const products = await db.saasProduct.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
    if (products.length === 0) return 0
    const result = await db.resellerProductAccess.createMany({
      data: products.map((p) => ({ resellerId, productId: p.id, grantedById })),
      skipDuplicates: true,
    })
    return result.count
  },

  /** Throws unless the reseller may sell this product right now; returns the product's name for messages. */
  async assertCanSell(resellerId: string, productId: string, db: Db = prisma) {
    const product = await db.saasProduct.findUnique({
      where: { id: productId },
      select: { name: true, status: true, resellerAccess: { where: { resellerId }, select: { status: true } } },
    })
    if (!product) throw notFoundError('SaaS product')
    if (product.status !== 'ACTIVE') throw badRequest('This product is not available')
    if (product.resellerAccess[0]?.status !== 'ACTIVE') {
      throw badRequest('Partner does not have active access to this product')
    }
    return { name: product.name }
  },
}
