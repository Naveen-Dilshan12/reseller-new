import type { Request } from 'express'
import { Prisma, type ResellerStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { conflict, notFoundError } from '../../middleware/error.middleware'
import { logger } from '../../utils/logger'
import { paginationSchema, toSkipTake } from '../../utils/pagination'
import { auditService } from '../audit-logs/audit.service'
import { getLevels } from '../commissions/level.service'
import { notificationService } from '../notifications/notification.service'

const ZERO = new Prisma.Decimal(0)

export const listResellersSchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'TERMINATED']).optional(),
  search: z.string().trim().max(100).optional(),
})
export const suspendSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500) }).strict()
export const reactivateSchema = z.object({ note: z.string().trim().max(500).optional() }).strict()

export type ListResellersQuery = z.infer<typeof listResellersSchema>

/** Guarded status change: only moves a reseller that is currently `from`, so concurrent requests cannot both win. */
async function changeStatus(db: Prisma.TransactionClient, id: string, from: ResellerStatus, to: ResellerStatus, data: Prisma.ResellerUpdateManyMutationInput) {
  const result = await db.reseller.updateMany({ where: { id, status: from }, data: { ...data, status: to } })
  if (result.count === 0) {
    const existing = await db.reseller.findUnique({ where: { id }, select: { status: true } })
    if (!existing) throw notFoundError('Partner')
    throw conflict(`This action is not allowed while the partner is ${existing.status}`)
  }
  return db.reseller.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, businessName: true, status: true } })
}

/**
 * Mobiles are stored as +947XXXXXXXX, but people type 0771234567 or 077 123 4567. For a number-like search
 * also look for the digits as stored: without separators, and without the national leading 0.
 */
function mobileSearchTerms(search: string): string[] {
  const compact = search.replace(/[\s\-()]/g, '')
  if (!/^\+?\d+$/.test(compact)) return [search]
  const terms = new Set([search, compact])
  if (compact.startsWith('0') && compact.length > 1) terms.add(compact.slice(1))
  return [...terms]
}

const contains = (field: 'code' | 'businessName' | 'fullName' | 'email' | 'mobile', term: string): Prisma.ResellerWhereInput => ({
  [field]: { contains: term, mode: 'insensitive' },
})

export const adminResellersService = {
  async list(q: ListResellersQuery) {
    const where: Prisma.ResellerWhereInput = {
      status: q.status ?? { notIn: ['PENDING', 'REJECTED'] },
      ...(q.search
        ? {
            OR: [
              ...(['code', 'businessName', 'fullName', 'email'] as const).map((f) => contains(f, q.search!)),
              ...mobileSearchTerms(q.search).map((t) => contains('mobile', t)),
            ],
          }
        : {}),
    }
    const [rows, total, levels, byStatus] = await Promise.all([
      prisma.reseller.findMany({
        where,
        select: {
          id: true,
          code: true,
          businessName: true,
          fullName: true,
          email: true,
          mobile: true,
          status: true,
          currentLevel: true,
          activeCustomerCount: true,
          approvedAt: true,
          suspendedAt: true,
          suspensionReason: true,
          _count: { select: { customers: true, users: true, accounts: true } },
        },
        // `id` makes the order total, so offset pages never repeat or skip rows that tie on the dates.
        orderBy: [{ approvedAt: 'desc' }, { submittedAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(q),
      }),
      prisma.reseller.count({ where }),
      getLevels(),
      prisma.reseller.groupBy({ by: ['status'], _count: { _all: true } }),
    ])
    const ids = rows.map((r) => r.id)
    const [openActivations, unpaid] = await Promise.all([
      prisma.activationRequest.groupBy({
        by: ['resellerId'],
        where: { resellerId: { in: ids }, status: { in: ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'] } },
        _count: { _all: true },
      }),
      prisma.commission.groupBy({
        by: ['resellerId'],
        where: { resellerId: { in: ids }, status: { in: ['PENDING', 'APPROVED', 'PAYABLE'] } },
        _sum: { amount: true },
      }),
    ])
    const openMap = new Map(openActivations.map((a) => [a.resellerId, a._count._all]))
    const unpaidMap = new Map(unpaid.map((u) => [u.resellerId, u._sum.amount ?? ZERO]))
    const levelNames = new Map(levels.map((l) => [l.level, l.name]))

    return {
      items: rows.map(({ _count, ...r }) => ({
        ...r,
        levelName: r.currentLevel ? (levelNames.get(r.currentLevel) ?? `Level ${r.currentLevel}`) : null,
        customers: _count.customers,
        // `activeCustomerCount` counts ACTIVE customer accounts (one per customer × product), so the matching
        // total is accounts, not customer records.
        customerAccounts: _count.accounts,
        users: _count.users,
        openActivationRequests: openMap.get(r.id) ?? 0,
        unpaidCommission: unpaidMap.get(r.id) ?? ZERO,
      })),
      total,
      statusCounts: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    }
  },

  /**
   * Identity for page headers (e.g. product access, commissions). Deliberately excludes contact, identity
   * and bank data, and unlike the application profile it is not audited as a "view".
   */
  async summary(id: string) {
    const reseller = await prisma.reseller.findUnique({ where: { id }, select: { id: true, code: true, businessName: true, status: true } })
    if (!reseller) throw notFoundError('Partner')
    return reseller
  },

  /**
   * Blocks login and API access for all reseller users immediately; SaaS tenants are not touched.
   * The status change, the session revocation and the audit entry commit together or not at all, so a
   * failure leaves the reseller ACTIVE and the request can simply be retried.
   */
  async suspend(req: Request, id: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const reseller = await changeStatus(tx, id, 'ACTIVE', 'SUSPENDED', { suspendedAt: new Date(), suspensionReason: reason })
      const sessions = await tx.refreshToken.updateMany({
        where: { user: { resellerId: id }, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await auditService.fromRequest(
        req,
        {
          action: 'RESELLER_SUSPENDED',
          entityType: 'Reseller',
          entityId: id,
          resellerId: id,
          metadata: { reason, sessionsRevoked: sessions.count },
        },
        tx,
      )
      return reseller
    })
  },

  /**
   * The status change and its audit entry commit together. The notification is sent afterwards and is
   * best effort: the reseller is already active, so a notification problem is logged, not returned as a failure.
   */
  async reactivate(req: Request, id: string, note?: string) {
    const reseller = await prisma.$transaction(async (tx) => {
      const previous = await tx.reseller.findUnique({ where: { id }, select: { suspensionReason: true } })
      const reseller = await changeStatus(tx, id, 'SUSPENDED', 'ACTIVE', { suspendedAt: null, suspensionReason: null })
      await auditService.fromRequest(
        req,
        {
          action: 'RESELLER_REACTIVATED',
          entityType: 'Reseller',
          entityId: id,
          resellerId: id,
          metadata: { note: note ?? null, previousSuspensionReason: previous?.suspensionReason ?? null },
        },
        tx,
      )
      return reseller
    })

    try {
      await notificationService.notifyReseller(id, {
        type: 'RESELLER_REACTIVATED',
        title: 'Account reactivated',
        body: 'Your partner account is active again.',
        link: '/dashboard',
      })
    } catch (err) {
      logger.error('[reseller] reactivation notification failed', err as Error, { resellerId: id })
    }
    return reseller
  },
}
