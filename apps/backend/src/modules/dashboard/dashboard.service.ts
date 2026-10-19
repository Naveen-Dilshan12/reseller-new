import { Prisma } from '@prisma/client'
import type { Request } from 'express'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { currentUser, resolveResellerId } from '../../middleware/auth.middleware'
import { badRequest, notFoundError } from '../../middleware/error.middleware'
import { hasPermission } from '../../rbac/permissions'
import { periodMonthOf, recentPeriods } from '../../utils/period'
import { promotePayable } from '../commissions/commission-ledger.service'
import { getLevels, levelFor } from '../commissions/level.service'
import type { ResellerDashboardQuery } from './dashboard.schema'

const ZERO = new Prisma.Decimal(0)
const RECENT = 6
const OPEN_ACTIVATIONS = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'] as const
const UNPAID_COMMISSIONS = ['PENDING', 'APPROVED', 'PAYABLE'] as const

/** Start of a calendar day (YYYY-MM-DD) in the business timezone, as a UTC instant. */
function dayStart(value: string, addDays = 0): Date {
  const [y, m, d] = value.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d + addDays)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: env.BUSINESS_TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  )
  const asZoned = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return new Date(guess - (asZoned - guess))
}

function dateRange(q: ResellerDashboardQuery): Prisma.DateTimeFilter | undefined {
  if (!q.from && !q.to) return undefined
  return { ...(q.from ? { gte: dayStart(q.from) } : {}), ...(q.to ? { lt: dayStart(q.to, 1) } : {}) }
}

export const dashboardService = {
  async reseller(q: ResellerDashboardQuery, req: Request) {
    const resellerId = resolveResellerId(req, q.resellerId)
    if (!resellerId) throw badRequest('resellerId is required')
    const { role } = currentUser(req)
    const can = {
      trials: hasPermission(role, 'trials:read'),
      activations: hasPermission(role, 'activations:read'),
      commissions: hasPermission(role, 'commissions:read'),
    }

    const range = dateRange(q)
    const productId = q.productId
    const accountScope: Prisma.CustomerAccountWhereInput = { resellerId, productId }
    const customerScope: Prisma.CustomerWhereInput = { resellerId, ...(productId ? { accounts: { some: { productId } } } : {}) }
    const commissionScope: Prisma.CommissionWhereInput = { resellerId, productId }

    if (can.commissions) await promotePayable()

    const [
      reseller,
      products,
      levels,
      levelActiveCount,
      accountsByStatus,
      totalCustomers,
      activeCustomers,
      pendingActivationRequests,
      newCustomers,
      trialsCreated,
      activationsSubmitted,
    ] = await Promise.all([
      prisma.reseller.findUnique({ where: { id: resellerId }, select: { id: true, code: true, businessName: true } }),
      prisma.saasProduct.findMany({
        where: {
          OR: [{ resellerAccess: { some: { resellerId, status: 'ACTIVE' } } }, { accounts: { some: { resellerId } } }],
        },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      getLevels(),
      prisma.customerAccount.count({ where: { resellerId, status: 'ACTIVE' } }),
      prisma.customerAccount.groupBy({ by: ['status'], where: accountScope, _count: { _all: true } }),
      prisma.customer.count({ where: customerScope }),
      prisma.customer.count({ where: { resellerId, accounts: { some: { status: 'ACTIVE', productId } } } }),
      can.activations
        ? prisma.activationRequest.count({ where: { resellerId, productId, status: { in: [...OPEN_ACTIVATIONS] } } })
        : null,
      prisma.customer.count({ where: { ...customerScope, createdAt: range } }),
      can.trials ? prisma.trialRequest.count({ where: { resellerId, productId, createdAt: range } }) : null,
      can.activations ? prisma.activationRequest.count({ where: { resellerId, productId, submittedAt: range } }) : null,
    ])
    if (!reseller) throw notFoundError('Partner')

    const accounts = Object.fromEntries(accountsByStatus.map((r) => [r.status, r._count._all])) as Record<string, number>
    const level = levelFor(levelActiveCount, levels)

    const commission = can.commissions ? await commissionFigures(commissionScope, range) : null

    // ── Analytics: customer growth (last 6 months) ──────────────────────────
    const periods = recentPeriods(6, periodMonthOf())
    const sixMonthsAgo = dayStart(`${periods[0]}-01`)

    const customersByMonth = await prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT TO_CHAR("createdAt", 'YYYY-MM') as month, COUNT(*)::bigint as count
      FROM customers
      WHERE "resellerId" = ${resellerId}
      AND "createdAt" >= ${sixMonthsAgo}
      GROUP BY TO_CHAR("createdAt", 'YYYY-MM')
      ORDER BY month ASC
    `
    const customerMap = new Map(customersByMonth.map((r) => [r.month, Number(r.count)]))
    const customerGrowth = periods.map((m) => ({ month: m, count: customerMap.get(m) ?? 0 }))

    // ── Analytics: commission earnings (last 6 months) ──────────────────────
    let commissionEarnings: { month: string; earned: string; paid: string }[] | null = null
    if (can.commissions) {
      const [earnedRows, paidRows] = await Promise.all([
        prisma.commission.groupBy({
          by: ['periodMonth'],
          where: {
            resellerId,
            entryType: 'EARNING',
            status: { not: 'REVERSED' },
            periodMonth: { in: periods },
          },
          _sum: { amount: true },
        }),
        prisma.commission.groupBy({
          by: ['periodMonth'],
          where: {
            resellerId,
            status: 'PAID',
            periodMonth: { in: periods },
          },
          _sum: { amount: true },
        }),
      ])
      const earnedMap = new Map(earnedRows.map((r) => [r.periodMonth, r._sum.amount ?? ZERO]))
      const paidMap = new Map(paidRows.map((r) => [r.periodMonth, r._sum.amount ?? ZERO]))
      commissionEarnings = periods.map((m) => ({
        month: m,
        earned: (earnedMap.get(m) ?? ZERO).toString(),
        paid: (paidMap.get(m) ?? ZERO).toString(),
      }))
    }

    const [recentCustomers, recentTrials, recentActivations, recentCommissions] = await Promise.all([
      prisma.customer.findMany({
        where: {
          ...customerScope,
          createdAt: range,
          ...(q.customerStatus ? { accounts: { some: { status: q.customerStatus, productId } } } : {}),
        },
        select: {
          id: true,
          displayName: true,
          createdAt: true,
          accounts: {
            where: { productId },
            select: { id: true, status: true, activatedAt: true, product: { select: { id: true, code: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: RECENT,
      }),
      can.trials
        ? prisma.trialRequest.findMany({
            where: { resellerId, productId, status: q.trialStatus, createdAt: range },
            select: {
              id: true,
              status: true,
              errorMessage: true,
              createdAt: true,
              product: { select: { code: true, name: true } },
              customerAccount: { select: { customer: { select: { id: true, displayName: true } } } },
            },
            orderBy: { createdAt: 'desc' },
            take: RECENT,
          })
        : null,
      can.activations
        ? prisma.activationRequest.findMany({
            where: { resellerId, productId, status: q.activationStatus, submittedAt: range },
            select: {
              id: true,
              reference: true,
              status: true,
              periodMonth: true,
              amount: true,
              currency: true,
              submittedAt: true,
              product: { select: { code: true, name: true } },
              customerAccount: { select: { customer: { select: { id: true, displayName: true } } } },
            },
            orderBy: { submittedAt: 'desc' },
            take: RECENT,
          })
        : null,
      can.commissions
        ? prisma.commission.findMany({
            where: { ...commissionScope, status: q.commissionStatus, createdAt: range },
            select: {
              id: true,
              entryType: true,
              periodMonth: true,
              rate: true,
              amount: true,
              currency: true,
              status: true,
              createdAt: true,
              paidAt: true,
              product: { select: { code: true, name: true } },
              customerAccount: { select: { customer: { select: { id: true, displayName: true } } } },
            },
            orderBy: { createdAt: 'desc' },
            take: RECENT,
          })
        : null,
    ])

    return {
      reseller,
      products,
      filters: { from: q.from ?? null, to: q.to ?? null, productId: productId ?? null },
      kpis: {
        level: {
          level: level.level,
          name: level.name,
          activeCount: levelActiveCount,
          nextLevel: level.nextLevel && { name: level.nextLevel.name, customersNeeded: level.nextLevel.customersNeeded },
          // With no level yet, show the rate the first activated customer will earn.
          ratePercent: can.commissions ? (level.level ? level.ratePercent : (levels[0]?.ratePercent ?? ZERO)) : null,
        },
        activeCustomers,
        totalCustomers,
        trialCustomers: accounts.TRIAL ?? 0,
        activeSubscriptions: accounts.ACTIVE ?? 0,
        pendingActivationRequests,
        commission: commission && {
          currency: 'LKR',
          thisMonth: commission.thisMonth,
          pending: commission.pending,
          paid: commission.paid,
        },
      },
      period: {
        newCustomers,
        trialsCreated,
        activationsSubmitted,
        commissionEarned: commission?.earnedInRange ?? null,
        commissionPaid: commission?.paidInRange ?? null,
      },
      recent: {
        customers: recentCustomers,
        trials: recentTrials,
        activations: recentActivations,
        commissions: recentCommissions,
      },
      analytics: {
        customerGrowth,
        commissionEarnings,
      },
    }
  },
}

/** Platform-wide overview for Hexalyte staff. Sections are omitted when the user lacks the permission. */
export async function adminDashboard(req: Request) {
  const { role, userId } = currentUser(req)
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(role, p)
  const period = periodMonthOf()
  const periods = recentPeriods(6, period)
  const monthStart = dayStart(`${period}-01`)
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000)

  const [
    resellersByStatus,
    activeCustomers,
    accountsByStatus,
    activationsByStatus,
    activationsByMonth,
    totalCustomers,
    productCount,
    trialCount,
    bankSlipCount,
    unreadNotifications,
    pendingDemoRequests,
  ] = await Promise.all([
    prisma.reseller.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.customer.count({ where: { accounts: { some: { status: 'ACTIVE' } } } }),
    prisma.customerAccount.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.activationRequest.groupBy({ by: ['status'], where: { status: { in: [...OPEN_ACTIVATIONS] } }, _count: { _all: true } }),
    prisma.subscriptionEvent.groupBy({
      by: ['periodMonth'],
      where: { type: 'PAYMENT_VERIFIED', periodMonth: { in: periods } },
      _count: { _all: true },
    }),
    prisma.customer.count(),
    prisma.saasProduct.count(),
    prisma.trialRequest.count(),
    can('bankslips:read') ? prisma.bankSlip.count() : null,
    prisma.notification.count({ where: { userId, readAt: null } }),
    can('demos:read') ? prisma.demoRequest.count({ where: { status: 'PENDING' } }) : null,
  ])

  const resellers = Object.fromEntries(resellersByStatus.map((r) => [r.status, r._count._all])) as Record<string, number>
  const accounts = Object.fromEntries(accountsByStatus.map((r) => [r.status, r._count._all])) as Record<string, number>
  const open = Object.fromEntries(activationsByStatus.map((r) => [r.status, r._count._all])) as Record<string, number>
  const monthly = new Map(activationsByMonth.map((m) => [m.periodMonth, m._count._all]))

  const sumCommission = (where: Prisma.CommissionWhereInput) =>
    prisma.commission.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }).then((r) => ({ amount: r._sum.amount ?? ZERO, count: r._count._all }))

  if (can('commissions:read')) await promotePayable()
  const [commission, queue, attention, recentAudit] = await Promise.all([
    can('commissions:read')
      ? Promise.all([
          sumCommission({ status: { in: [...UNPAID_COMMISSIONS] } }),
          sumCommission({ status: 'PAYABLE' }),
          sumCommission({ status: 'PENDING' }),
          sumCommission({ status: 'PAID' }),
          sumCommission({ status: 'PAID', paidAt: { gte: monthStart } }),
        ]).then(([pending, payable, awaitingApproval, paid, paidThisMonth]) => ({
          currency: 'LKR',
          pending: pending.amount,
          payable: payable.amount,
          awaitingApprovalCount: awaitingApproval.count,
          paid: paid.amount,
          paidThisMonth: paidThisMonth.amount,
        }))
      : null,
    Promise.all([
      can('resellers:read')
        ? prisma.reseller.findMany({
            where: { status: 'PENDING' },
            select: { id: true, code: true, businessName: true, fullName: true, submittedAt: true },
            orderBy: { submittedAt: 'asc' },
            take: 5,
          })
        : null,
      can('activations:read')
        ? prisma.activationRequest.findMany({
            where: { status: { in: [...OPEN_ACTIVATIONS] } },
            select: {
              id: true,
              reference: true,
              status: true,
              amount: true,
              currency: true,
              submittedAt: true,
              paymentVerifiedAt: true,
              product: { select: { name: true } },
              reseller: { select: { code: true, businessName: true } },
              customerAccount: { select: { customer: { select: { displayName: true } } } },
            },
            orderBy: { submittedAt: 'asc' },
            take: 6,
          })
        : null,
    ]).then(([applications, activations]) => ({ applications, activations })),
    Promise.all([
      prisma.trialRequest.count({ where: { status: 'FAILED', updatedAt: { gte: weekAgo } } }),
      prisma.saasProduct.findMany({ where: { integrationStatus: 'ERROR' }, select: { id: true, name: true } }),
      prisma.activationRequest.count({ where: { status: 'APPROVED', activationError: { not: null } } }),
    ]).then(([failedTrials7d, integrationErrors, failedActivations]) => ({ failedTrials7d, integrationErrors, failedActivations })),
    can('audit:read')
      ? prisma.auditLog.findMany({
          select: { id: true, action: true, actorEmail: true, actorType: true, entityType: true, entityId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 8,
        })
      : null,
  ])

  return {
    period,
    kpis: {
      totalResellers: resellers.ACTIVE ?? 0,
      suspendedResellers: resellers.SUSPENDED ?? 0,
      pendingApprovals: resellers.PENDING ?? 0,
      activeCustomers,
      activeSubscriptions: accounts.ACTIVE ?? 0,
      trialAccounts: accounts.TRIAL ?? 0,
      pendingActivations: {
        total: (open.PENDING_REVIEW ?? 0) + (open.UNDER_REVIEW ?? 0) + (open.APPROVED ?? 0),
        pendingReview: open.PENDING_REVIEW ?? 0,
        underReview: open.UNDER_REVIEW ?? 0,
        awaitingActivation: open.APPROVED ?? 0,
      },
      monthlyActivations: monthly.get(period) ?? 0,
      commission,
    },
    activationTrend: periods.map((p) => ({ periodMonth: p, count: monthly.get(p) ?? 0 })),
    queue,
    attention,
    recentAudit,
    sections: {
      resellers: (resellers.ACTIVE ?? 0) + (resellers.SUSPENDED ?? 0),
      pendingApplications: resellers.PENDING ?? 0,
      products: productCount,
      customers: totalCustomers,
      trials: trialCount,
      openActivations: (open.PENDING_REVIEW ?? 0) + (open.UNDER_REVIEW ?? 0) + (open.APPROVED ?? 0),
      bankSlips: bankSlipCount,
      unreadNotifications,
      pendingDemoRequests,
    },
  }
}

async function commissionFigures(scope: Prisma.CommissionWhereInput, range: Prisma.DateTimeFilter | undefined) {
  const sum = (where: Prisma.CommissionWhereInput) =>
    prisma.commission.aggregate({ where: { ...scope, ...where }, _sum: { amount: true } }).then((r) => r._sum.amount ?? ZERO)
  const [thisMonth, pending, paid, earnedInRange, paidInRange] = await Promise.all([
    sum({ periodMonth: periodMonthOf(), status: { not: 'REVERSED' } }),
    sum({ status: { in: [...UNPAID_COMMISSIONS] } }),
    sum({ status: 'PAID' }),
    sum({ entryType: 'EARNING', status: { not: 'REVERSED' }, createdAt: range }),
    sum({ status: 'PAID', paidAt: range }),
  ])
  return { thisMonth, pending, paid, earnedInRange, paidInRange }
}
