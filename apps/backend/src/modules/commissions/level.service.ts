import { Prisma, type CommissionLevel } from '@prisma/client'
import { prisma } from '../../config/database'

type Db = Prisma.TransactionClient | typeof prisma

export interface LevelInfo {
  level: number | null
  name: string | null
  ratePercent: Prisma.Decimal
  activeCustomerCount: number
  nextLevel: { level: number; name: string; ratePercent: Prisma.Decimal; customersNeeded: number } | null
}

export async function getLevels(db: Db = prisma): Promise<CommissionLevel[]> {
  return db.commissionLevel.findMany({ orderBy: { minActiveCustomers: 'asc' } })
}

/** Pure tier lookup. Below the first tier there is no level and the rate is 0. */
export function levelFor(activeCustomerCount: number, levels: CommissionLevel[]): LevelInfo {
  const current = levels.find(
    (l) => activeCustomerCount >= l.minActiveCustomers && (l.maxActiveCustomers === null || activeCustomerCount <= l.maxActiveCustomers),
  )
  const next = levels.find((l) => l.minActiveCustomers > activeCustomerCount)
  return {
    level: current?.level ?? null,
    name: current?.name ?? null,
    ratePercent: current?.ratePercent ?? new Prisma.Decimal(0),
    activeCustomerCount,
    nextLevel: next
      ? { level: next.level, name: next.name, ratePercent: next.ratePercent, customersNeeded: next.minActiveCustomers - activeCustomerCount }
      : null,
  }
}

/**
 * Recounts the reseller's ACTIVE customers and stores the resulting level.
 * Must run inside the same transaction that changed a customer's status.
 */
export async function recalculateResellerLevel(db: Prisma.TransactionClient, resellerId: string) {
  // Serialises concurrent status changes for one reseller so the count below sees the others' committed changes.
  await db.$queryRaw`SELECT id FROM resellers WHERE id = ${resellerId} FOR UPDATE`
  const [activeCustomerCount, levels, reseller] = await Promise.all([
    db.customerAccount.count({ where: { resellerId, status: 'ACTIVE' } }),
    getLevels(db),
    db.reseller.findUniqueOrThrow({ where: { id: resellerId }, select: { currentLevel: true } }),
  ])
  const info = levelFor(activeCustomerCount, levels)
  const changed = info.level !== reseller.currentLevel

  await db.reseller.update({
    where: { id: resellerId },
    data: { activeCustomerCount, currentLevel: info.level, ...(changed ? { levelUpdatedAt: new Date() } : {}) },
  })
  if (changed) {
    await db.resellerLevelChange.create({
      data: { resellerId, fromLevel: reseller.currentLevel, toLevel: info.level, activeCustomerCount },
    })
  }
  return { ...info, changed, fromLevel: reseller.currentLevel }
}

export function calculateCommissionAmount(baseAmount: Prisma.Decimal, ratePercent: Prisma.Decimal): Prisma.Decimal {
  return baseAmount.mul(ratePercent).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}
