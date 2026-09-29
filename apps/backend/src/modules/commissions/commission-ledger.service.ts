import { Prisma, type Commission } from '@prisma/client'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { conflict, notFoundError } from '../../middleware/error.middleware'
import { toSkipTake } from '../../utils/pagination'
import { periodMonthOf, recentPeriods } from '../../utils/period'
import { calculateCommissionAmount, getLevels, levelFor } from './level.service'
import type { ListCommissionsQuery } from './commission.schema'

type Tx = Prisma.TransactionClient

const ZERO = new Prisma.Decimal(0)

export interface EarningInput {
  resellerId: string
  productId: string
  customerAccountId: string
  subscriptionEventId: string
  periodMonth: string
  level: number
  ratePercent: Prisma.Decimal
  baseAmount: Prisma.Decimal
  currency: string
}

export function holdUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.COMMISSION_HOLD_DAYS * 24 * 60 * 60 * 1000)
}

export async function createEarning(tx: Tx, input: EarningInput): Promise<Commission> {
  const existing = await tx.commission.findFirst({
    where: {
      customerAccountId: input.customerAccountId,
      periodMonth: input.periodMonth,
      entryType: 'EARNING',
      status: { not: 'REVERSED' },
      reversedAt: null,
    },
    select: { id: true },
  })
  if (existing) throw conflict(`Commission for ${input.periodMonth} already exists for this customer`)

  return tx.commission.create({
    data: {
      resellerId: input.resellerId,
      productId: input.productId,
      customerAccountId: input.customerAccountId,
      subscriptionEventId: input.subscriptionEventId,
      entryType: 'EARNING',
      periodMonth: input.periodMonth,
      level: input.level,
      baseAmount: input.baseAmount,
      rate: input.ratePercent,
      amount: calculateCommissionAmount(input.baseAmount, input.ratePercent),
      currency: input.currency,
      status: 'PENDING',
      payableAt: holdUntil(),
    },
  })
}

/**
 * Reverses an EARNING row. Unpaid rows are marked REVERSED; paid rows keep
 * their PAID status and a negative CLAWBACK row is added to the next payout.
 */
export async function reverseEntry(tx: Tx, commission: Commission, reason: string, userId: string | null) {
  if (commission.entryType !== 'EARNING') throw conflict('Only earning entries can be reversed')
  if (commission.status === 'REVERSED' || commission.reversedAt) throw conflict('Commission is already reversed')

  const now = new Date()
  if (commission.status !== 'PAID') {
    const updated = await tx.commission.update({
      where: { id: commission.id },
      data: { status: 'REVERSED', reversedAt: now, reversedById: userId, reversalReason: reason },
    })
    return { reversed: updated, clawback: null }
  }

  const reversed = await tx.commission.update({
    where: { id: commission.id },
    data: { reversedAt: now, reversedById: userId, reversalReason: reason },
  })
  const clawback = await tx.commission.create({
    data: {
      resellerId: commission.resellerId,
      productId: commission.productId,
      customerAccountId: commission.customerAccountId,
      subscriptionEventId: commission.subscriptionEventId,
      entryType: 'CLAWBACK',
      periodMonth: periodMonthOf(now),
      level: commission.level,
      baseAmount: commission.baseAmount,
      rate: commission.rate,
      amount: commission.amount.neg(),
      currency: commission.currency,
      status: 'PAYABLE',
      payableAt: now,
      approvedAt: now,
      approvedById: userId,
      reversalOfId: commission.id,
      reversalReason: reason,
    },
  })
  return { reversed, clawback }
}

/** APPROVED rows whose hold period has ended become PAYABLE. */
export async function promotePayable(db: Tx | typeof prisma = prisma): Promise<number> {
  const result = await db.commission.updateMany({
    where: { status: 'APPROVED', payableAt: { lte: new Date() } },
    data: { status: 'PAYABLE' },
  })
  return result.count
}

const listInclude = {
  customerAccount: { select: { id: true, status: true, customer: { select: { id: true, displayName: true } } } },
  product: { select: { code: true, name: true } },
  reseller: { select: { id: true, code: true, businessName: true } },
  payout: { select: { id: true, paymentReference: true, paidAt: true } },
} satisfies Prisma.CommissionInclude

function sumByStatus(rows: { status: string; entryType: string; _sum: { amount: Prisma.Decimal | null } }[]) {
  const totals = { pending: ZERO, approved: ZERO, payable: ZERO, paid: ZERO, reversed: ZERO }
  for (const row of rows) {
    const amount = row._sum.amount ?? ZERO
    if (row.entryType === 'CLAWBACK') totals.reversed = totals.reversed.add(amount.abs())
    switch (row.status) {
      case 'PENDING':
        totals.pending = totals.pending.add(amount)
        break
      case 'APPROVED':
        totals.approved = totals.approved.add(amount)
        break
      case 'PAYABLE':
        totals.payable = totals.payable.add(amount)
        break
      case 'PAID':
        totals.paid = totals.paid.add(amount)
        break
      case 'REVERSED':
        totals.reversed = totals.reversed.add(amount)
        break
    }
  }
  return totals
}

export const commissionLedgerService = {
  async list(query: ListCommissionsQuery, resellerId?: string) {
    await promotePayable()
    const where: Prisma.CommissionWhereInput = {
      resellerId,
      customerAccountId: query.customerAccountId,
      status: query.status,
      entryType: query.entryType,
      periodMonth: query.periodMonth,
    }
    const [items, total, sum] = await Promise.all([
      prisma.commission.findMany({ where, include: listInclude, orderBy: [{ createdAt: 'desc' }], ...toSkipTake(query) }),
      prisma.commission.count({ where }),
      prisma.commission.aggregate({ where: { ...where, status: query.status ?? { not: 'REVERSED' } }, _sum: { amount: true } }),
    ])
    return { items, total, netAmount: sum._sum.amount ?? ZERO }
  },

  async summary(resellerId: string) {
    await promotePayable()
    const period = periodMonthOf()
    const periods = recentPeriods(12, period)

    const [reseller, activeCustomerCount, levels, byStatus, byMonth, products, levelHistory] = await Promise.all([
      prisma.reseller.findUnique({
        where: { id: resellerId },
        select: { id: true, code: true, businessName: true, status: true, currentLevel: true, levelUpdatedAt: true },
      }),
      prisma.customerAccount.count({ where: { resellerId, status: 'ACTIVE' } }),
      getLevels(),
      prisma.commission.groupBy({ by: ['status', 'entryType'], where: { resellerId }, _sum: { amount: true } }),
      prisma.commission.groupBy({
        by: ['periodMonth'],
        where: { resellerId, periodMonth: { in: periods }, status: { not: 'REVERSED' } },
        _sum: { amount: true },
      }),
      prisma.saasProduct.findMany({
        where: { status: 'ACTIVE', resellerAccess: { some: { resellerId, status: 'ACTIVE' } } },
        select: { code: true, name: true, monthlyPrice: true, currency: true },
        orderBy: { name: 'asc' },
      }),
      prisma.resellerLevelChange.findMany({ where: { resellerId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ])
    if (!reseller) throw notFoundError('Reseller')

    const level = levelFor(activeCustomerCount, levels)
    // With no active customers yet, show what the first customer would earn.
    const effectiveRate = level.level ? level.ratePercent : (levels[0]?.ratePercent ?? ZERO)
    const monthly = new Map(byMonth.map((m) => [m.periodMonth, m._sum.amount ?? ZERO]))

    return {
      reseller,
      level: { ...level, effectiveRatePercent: effectiveRate },
      levels,
      commissionPerCustomer: products.map((p) => ({
        product: p.name,
        productCode: p.code,
        baseAmount: p.monthlyPrice,
        currency: p.currency,
        amount: calculateCommissionAmount(p.monthlyPrice, effectiveRate),
      })),
      totals: sumByStatus(byStatus),
      currentMonth: { periodMonth: period, earnings: monthly.get(period) ?? ZERO },
      monthlyEarnings: periods.map((p) => ({ periodMonth: p, earnings: monthly.get(p) ?? ZERO })),
      levelHistory,
    }
  },

  async byCustomer(resellerId?: string, periodMonth?: string) {
    const where: Prisma.CommissionWhereInput = { resellerId, periodMonth, status: { not: 'REVERSED' } }
    const [earned, paid, reversed] = await Promise.all([
      prisma.commission.groupBy({
        by: ['customerAccountId'],
        where,
        _sum: { amount: true },
        _count: { _all: true },
        _max: { periodMonth: true },
      }),
      prisma.commission.groupBy({ by: ['customerAccountId'], where: { ...where, status: 'PAID' }, _sum: { amount: true } }),
      prisma.commission.groupBy({
        by: ['customerAccountId'],
        where: { resellerId, periodMonth, OR: [{ status: 'REVERSED' }, { entryType: 'CLAWBACK' }] },
        _sum: { amount: true },
      }),
    ])
    const ids = [...new Set([...earned, ...reversed].map((r) => r.customerAccountId))]
    const accounts = await prisma.customerAccount.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        customer: { select: { id: true, displayName: true } },
        activatedAt: true,
        product: { select: { name: true } },
        reseller: { select: { code: true, businessName: true } },
      },
    })
    const paidMap = new Map(paid.map((p) => [p.customerAccountId, p._sum.amount ?? ZERO]))
    const reversedMap = new Map(reversed.map((r) => [r.customerAccountId, (r._sum.amount ?? ZERO).abs()]))
    const earnedMap = new Map(earned.map((e) => [e.customerAccountId, e]))

    return accounts
      .map((a) => {
        const e = earnedMap.get(a.id)
        return {
          customerAccount: a,
          entries: e?._count._all ?? 0,
          lastPeriod: e?._max.periodMonth ?? null,
          netEarned: e?._sum.amount ?? ZERO,
          paid: paidMap.get(a.id) ?? ZERO,
          reversed: reversedMap.get(a.id) ?? ZERO,
        }
      })
      .sort((x, y) => y.netEarned.comparedTo(x.netEarned))
  },

  /** Per-reseller totals for a month (admin), or per-customer lines for one reseller. */
  async monthlyReport(month: string, resellerId?: string) {
    await promotePayable()
    if (resellerId) {
      const entries = await prisma.commission.findMany({
        where: { resellerId, periodMonth: month },
        include: listInclude,
        orderBy: [{ customerAccount: { customer: { displayName: 'asc' } } }, { createdAt: 'asc' }],
      })
      const byStatus = await prisma.commission.groupBy({
        by: ['status', 'entryType'],
        where: { resellerId, periodMonth: month },
        _sum: { amount: true },
      })
      const net = entries.filter((e) => e.status !== 'REVERSED').reduce((s, e) => s.add(e.amount), ZERO)
      return { month, resellerId, entries, totals: { ...sumByStatus(byStatus), net } }
    }

    const grouped = await prisma.commission.groupBy({
      by: ['resellerId', 'status', 'entryType'],
      where: { periodMonth: month },
      _sum: { amount: true },
      _count: { _all: true },
    })
    const customers = await prisma.commission.groupBy({
      by: ['resellerId'],
      where: { periodMonth: month, entryType: 'EARNING', status: { not: 'REVERSED' } },
      _count: { customerAccountId: true },
    })
    const resellerIds = [...new Set(grouped.map((g) => g.resellerId))]
    const resellers = await prisma.reseller.findMany({
      where: { id: { in: resellerIds } },
      select: { id: true, code: true, businessName: true, currentLevel: true, activeCustomerCount: true },
    })
    const customerMap = new Map(customers.map((c) => [c.resellerId, c._count.customerAccountId]))

    const rows = resellers
      .map((r) => {
        const own = grouped.filter((g) => g.resellerId === r.id)
        const totals = sumByStatus(own)
        const net = own.filter((g) => g.status !== 'REVERSED').reduce((s, g) => s.add(g._sum.amount ?? ZERO), ZERO)
        return { reseller: r, paidCustomers: customerMap.get(r.id) ?? 0, totals: { ...totals, net } }
      })
      .sort((a, b) => b.totals.net.comparedTo(a.totals.net))

    const overall = sumByStatus(grouped)
    const net = rows.reduce((s, r) => s.add(r.totals.net), ZERO)
    return { month, rows, totals: { ...overall, net } }
  },
}
