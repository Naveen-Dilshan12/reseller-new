import { Request } from 'express'
import { Prisma, type SubscriptionEventSource } from '@prisma/client'
import { prisma } from '../../config/database'
import { conflict, notFoundError } from '../../middleware/error.middleware'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { createEarning, reverseEntry } from './commission-ledger.service'
import { recalculateResellerLevel } from './level.service'
import type { RecordSubscriptionEventInput } from './commission.schema'

export interface EventContext {
  source: SubscriptionEventSource
  req?: Request
  /** For SAAS_WEBHOOK events. */
  productCode?: string
}

/**
 * Applies a verified subscription outcome from the SaaS.
 *
 * Business rules:
 * - PAYMENT_VERIFIED: customer becomes ACTIVE, level is recalculated, and one
 *   EARNING commission is created for that month at the resulting level's rate.
 * - CANCELLED: customer stops counting as active; earned commission is kept.
 * - REFUNDED: that month's commission is reversed (clawed back if already paid)
 *   and, unless `endSubscription` is false, the customer is deactivated.
 */
export async function applySubscriptionEvent(tx: Prisma.TransactionClient, input: RecordSubscriptionEventInput, ctx: EventContext) {
  const userId = ctx.req?.user?.userId ?? null

  const account = await tx.customerAccount.findUnique({ where: { id: input.customerAccountId }, include: { product: true, customer: { select: { displayName: true } } } })
  if (!account) throw notFoundError('Customer account')

  let event
  try {
    event = await tx.subscriptionEvent.create({
      data: {
        customerAccountId: account.id,
        type: input.type,
        periodMonth: input.periodMonth,
        externalRef: input.externalRef,
        note: input.note,
        source: ctx.source,
        recordedById: userId,
      },
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict(`A ${input.type} event for ${input.periodMonth} is already recorded for this customer`)
    }
    throw err
  }

  const now = new Date()
  let commission = null
  let reversals: Awaited<ReturnType<typeof reverseEntry>>[] = []
  const deactivate = input.type === 'CANCELLED' || (input.type === 'REFUNDED' && input.endSubscription !== false)

  if (input.type === 'PAYMENT_VERIFIED') {
    await tx.customerAccount.update({
      where: { id: account.id },
      data: { status: 'ACTIVE', activatedAt: account.activatedAt ?? now, deactivatedAt: null },
    })
  } else if (deactivate && account.status !== 'CANCELLED') {
    await tx.customerAccount.update({
      where: { id: account.id },
      data: { status: 'CANCELLED', deactivatedAt: now },
    })
  }

  const level = await recalculateResellerLevel(tx, account.resellerId)

  // Below the first configured tier the rate is 0, so no commission entry is created.
  if (input.type === 'PAYMENT_VERIFIED' && level.level !== null) {
    commission = await createEarning(tx, {
      resellerId: account.resellerId,
      productId: account.productId,
      customerAccountId: account.id,
      subscriptionEventId: event.id,
      periodMonth: input.periodMonth,
      level: level.level,
      ratePercent: level.ratePercent,
      baseAmount: account.product.monthlyPrice,
      currency: account.product.currency,
    })
  }

  if (input.type === 'REFUNDED') {
    const earnings = await tx.commission.findMany({
      where: {
        customerAccountId: account.id,
        periodMonth: input.periodMonth,
        entryType: 'EARNING',
        status: { not: 'REVERSED' },
        reversedAt: null,
      },
    })
    const reason = `Subscription refunded for ${input.periodMonth}${input.externalRef ? ` (${input.externalRef})` : ''}`
    reversals = []
    for (const earning of earnings) reversals.push(await reverseEntry(tx, earning, reason, userId))
  }

  const audit = {
    action: `SUBSCRIPTION_${input.type}`,
    entityType: 'CustomerAccount',
    entityId: account.id,
    resellerId: account.resellerId,
    metadata: {
      eventId: event.id,
      periodMonth: input.periodMonth,
      externalRef: input.externalRef ?? null,
      commissionId: commission?.id ?? null,
      commissionAmount: commission?.amount.toString() ?? null,
      reversedIds: reversals.map((r) => r.reversed.id),
      level: level.level,
      activeCustomerCount: level.activeCustomerCount,
    },
  }
  if (ctx.req) await auditService.fromRequest(ctx.req, audit, tx)
  else if (ctx.productCode) await auditService.saas(ctx.productCode, audit, tx)
  else await auditService.system(audit, tx)

  return { account, event, commission, reversals, level }
}

export type AppliedSubscriptionEvent = Awaited<ReturnType<typeof applySubscriptionEvent>>

/** Sends reseller notifications for an applied event; call after the transaction commits. */
export async function notifySubscriptionEvent(result: AppliedSubscriptionEvent, input: RecordSubscriptionEventInput) {
  const { account, commission, reversals, level } = result
  if (commission) {
    await notificationService.notifyReseller(account.resellerId, {
      type: 'COMMISSION_EARNED',
      title: 'Commission earned',
      body: `${account.customer.displayName}: ${commission.currency} ${commission.amount.toFixed(2)} for ${commission.periodMonth} (pending approval).`,
      link: '/commissions',
    })
  }
  if (reversals.length > 0) {
    await notificationService.notifyReseller(account.resellerId, {
      type: 'COMMISSION_REVERSED',
      title: 'Commission reversed',
      body: `${account.customer.displayName}: commission for ${input.periodMonth} was reversed due to a refund.`,
      link: '/commissions',
    })
  }
  if (level.changed) {
    const up = (level.level ?? 0) > (level.fromLevel ?? 0)
    await notificationService.notifyReseller(account.resellerId, {
      type: 'RESELLER_LEVEL_CHANGED',
      title: up ? 'You moved up a level!' : 'Your level changed',
      body: level.level
        ? `You are now ${level.name} (${level.ratePercent.toString()}%) with ${level.activeCustomerCount} active customers.`
        : 'You currently have no active customers.',
      link: '/dashboard',
    })
  }
}

export function summariseSubscriptionEvent(result: AppliedSubscriptionEvent) {
  const { commission, reversals, level } = result
  return {
    event: result.event,
    commission,
    reversed: reversals.map((r) => ({ id: r.reversed.id, clawbackId: r.clawback?.id ?? null })),
    level: { level: level.level, ratePercent: level.ratePercent, activeCustomerCount: level.activeCustomerCount, changed: level.changed },
  }
}

export async function recordSubscriptionEvent(input: RecordSubscriptionEventInput, ctx: EventContext) {
  const result = await prisma.$transaction((tx) => applySubscriptionEvent(tx, input, ctx))
  await notifySubscriptionEvent(result, input)
  return summariseSubscriptionEvent(result)
}
