import type { Request } from 'express'
import { Prisma, type ResellerStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { conflict, notFoundError } from '../../middleware/error.middleware'
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

async function changeStatus(req: Request, id: string, from: ResellerStatus, to: ResellerStatus, data: Prisma.ResellerUpdateManyMutationInput) {
  const result = await prisma.reseller.updateMany({ where: { id, status: from }, data: { ...data, status: to } })
  if (result.count === 0) {
    const existing = await prisma.reseller.findUnique({ where: { id }, select: { status: true } })
    if (!existing) throw notFoundError('Reseller')
    throw conflict(`This action is not allowed while the reseller is ${existing.status}`)
  }
  return prisma.reseller.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, businessName: true, status: true } })
}

export const adminResellersService = {
  async list(q: ListResellersQuery) {
    const where: Prisma.ResellerWhereInput = {
      status: q.status ?? { notIn: ['PENDING', 'REJECTED'] },
      ...(q.search
        ? { OR: ['code', 'businessName', 'fullName', 'email', 'mobile'].map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' } })) }
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
          _count: { select: { customers: true, users: true } },
        },
        orderBy: [{ approvedAt: 'desc' }, { submittedAt: 'desc' }],
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
        users: _count.users,
        openActivationRequests: openMap.get(r.id) ?? 0,
        unpaidCommission: unpaidMap.get(r.id) ?? ZERO,
      })),
      total,
      statusCounts: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    }
  },

  /** Blocks login and API access for all reseller users immediately; SaaS tenants are not touched. */
  async suspend(req: Request, id: string, reason: string) {
    const reseller = await changeStatus(req, id, 'ACTIVE', 'SUSPENDED', { suspendedAt: new Date(), suspensionReason: reason })
    const sessions = await prisma.refreshToken.updateMany({
      where: { user: { resellerId: id }, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await auditService.fromRequest(req, {
      action: 'RESELLER_SUSPENDED',
      entityType: 'Reseller',
      entityId: id,
      resellerId: id,
      metadata: { reason, sessionsRevoked: sessions.count },
    })
    return reseller
  },

  async reactivate(req: Request, id: string, note?: string) {
    const previous = await prisma.reseller.findUnique({ where: { id }, select: { suspensionReason: true } })
    const reseller = await changeStatus(req, id, 'SUSPENDED', 'ACTIVE', { suspendedAt: null, suspensionReason: null })
    await auditService.fromRequest(req, {
      action: 'RESELLER_REACTIVATED',
      entityType: 'Reseller',
      entityId: id,
      resellerId: id,
      metadata: { note: note ?? null, previousSuspensionReason: previous?.suspensionReason ?? null },
    })
    await notificationService.notifyReseller(id, {
      type: 'RESELLER_REACTIVATED',
      title: 'Account reactivated',
      body: 'Your reseller account is active again.',
      link: '/dashboard',
    })
    return reseller
  },
}
