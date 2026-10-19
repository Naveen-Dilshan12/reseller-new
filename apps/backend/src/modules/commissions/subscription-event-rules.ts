import type { CustomerAccountStatus, Prisma } from '@prisma/client'
import { env } from '../../config/env'
import { badRequest, conflict } from '../../middleware/error.middleware'
import { billingWindow, periodMonthOf } from '../../utils/period'
import type { RecordSubscriptionEventInput } from './commission.schema'

type Tx = Prisma.TransactionClient

/** Activation requests that are still being worked on (the same set as OPEN_STATUSES in the activation service). */
const OPEN_ACTIVATION_STATUSES = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'] as const

/** Latest trial request states that mean provisioning has not finished successfully. */
const UNFINISHED_TRIAL_STATUSES = ['PENDING', 'SUBMITTED', 'FAILED']

export interface EventAccount {
  id: string
  status: CustomerAccountStatus
  externalTenantId: string | null
}

/**
 * Rules for a subscription event recorded by hand by an admin (source ADMIN). The activation flow records its own
 * PAYMENT_VERIFIED through the same service without these checks: it has already validated the account, month and request.
 *
 * - The billing month is inside the activation window (last month … two months ahead) in business time.
 * - PAYMENT_VERIFIED needs a tenant and finished trial provisioning; it activates TRIAL / PENDING accounts and records ACTIVE
 *   renewals, but does not reactivate a CANCELLED account (that goes through a paid activation request).
 * - CANCELLED applies to a paid subscription only; an unpaid TRIAL / PENDING account is never ended by it.
 * - REFUNDED needs the PAYMENT_VERIFIED event of the same month. It ends the subscription (unless told not to) only when it
 *   refunds the current month and nothing later is still paid; refunding any other month only reverses that month's commission.
 * - An open activation request blocks any event that would change the account's state.
 * - A month that has a PAYMENT_VERIFIED or REFUNDED event keeps it: history is never edited, so it cannot be recorded again.
 *
 * SUSPENDED has no rule of its own (nothing in the code puts an account there): it is treated as before.
 *
 * Returns whether this event ends the subscription (account → CANCELLED).
 */
export async function assertManualEventAllowed(
  tx: Tx,
  account: EventAccount,
  input: RecordSubscriptionEventInput,
): Promise<{ endsSubscription: boolean }> {
  const current = periodMonthOf()
  const { from, to } = billingWindow(current)
  if (input.periodMonth < from || input.periodMonth > to) {
    throw badRequest(`Billing month must be between ${from} and ${to} (last month to two months ahead, ${env.BUSINESS_TIMEZONE} time)`)
  }

  const sameMonth = await tx.subscriptionEvent.findMany({
    where: { customerAccountId: account.id, periodMonth: input.periodMonth },
    select: { type: true },
  })
  const recorded = new Set<string>(sameMonth.map((e) => e.type))
  let endsSubscription = false

  switch (input.type) {
    case 'PAYMENT_VERIFIED': {
      // A refunded month has both events; the refund is the more useful thing to tell the admin.
      if (recorded.has('REFUNDED')) {
        throw conflict(`The payment for ${input.periodMonth} was refunded. Its history is kept, so that month cannot be recorded as paid again.`)
      }
      if (recorded.has('PAYMENT_VERIFIED')) {
        throw conflict(`A PAYMENT_VERIFIED event for ${input.periodMonth} is already recorded for this customer`)
      }
      if (account.status === 'CANCELLED') {
        throw conflict(
          'This customer account is cancelled. A manual payment event cannot reactivate it; submit a paid activation request for it instead.',
        )
      }
      if (!account.externalTenantId?.trim()) {
        throw conflict('This customer account has no SaaS tenant. A payment can only be verified for an account whose tenant is linked.')
      }
      if (account.status !== 'ACTIVE') {
        const latest = await tx.trialRequest.findFirst({
          where: { customerAccountId: account.id },
          orderBy: { createdAt: 'desc' },
          select: { status: true },
        })
        if (latest && UNFINISHED_TRIAL_STATUSES.includes(latest.status)) {
          throw conflict(
            `Trial provisioning for this account has not completed successfully (latest trial request: ${latest.status}). Finish or retry the trial request first.`,
          )
        }
      }
      break
    }

    case 'CANCELLED': {
      if (account.status === 'TRIAL' || account.status === 'PENDING') {
        throw conflict(
          `This account is an unpaid ${account.status.toLowerCase()} with no paid subscription to cancel. A Cancelled event does not end a trial.`,
        )
      }
      if (account.status === 'CANCELLED') throw conflict('This subscription is already cancelled')
      endsSubscription = true
      break
    }

    case 'REFUNDED': {
      if (recorded.has('REFUNDED')) {
        throw conflict(`A REFUNDED event for ${input.periodMonth} is already recorded for this customer`)
      }
      if (!recorded.has('PAYMENT_VERIFIED')) {
        throw conflict(`No PAYMENT_VERIFIED event is recorded for ${input.periodMonth} on this account, so there is no payment to refund.`)
      }
      const couldEnd =
        input.endSubscription !== false &&
        (account.status === 'ACTIVE' || account.status === 'SUSPENDED') &&
        input.periodMonth === current
      if (couldEnd) {
        const later = await tx.subscriptionEvent.findMany({
          where: { customerAccountId: account.id, periodMonth: { gt: input.periodMonth }, type: { in: ['PAYMENT_VERIFIED', 'REFUNDED'] } },
          select: { type: true, periodMonth: true },
        })
        const refunded = new Set(later.filter((e) => e.type === 'REFUNDED').map((e) => e.periodMonth))
        const paidLater = later.some((e) => e.type === 'PAYMENT_VERIFIED' && !refunded.has(e.periodMonth))
        endsSubscription = !paidLater
      }
      break
    }
  }

  if (input.type === 'PAYMENT_VERIFIED' || endsSubscription) {
    const open = await tx.activationRequest.findFirst({
      where: { customerAccountId: account.id, status: { in: [...OPEN_ACTIVATION_STATUSES] } },
      select: { reference: true },
    })
    if (open) {
      throw conflict(
        `An activation request (${open.reference}) is already pending review for this customer account. Complete or reject it before recording a subscription event.`,
      )
    }
  }

  return { endsSubscription }
}
