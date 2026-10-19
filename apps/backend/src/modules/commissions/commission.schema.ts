import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination'
import { businessDateOf, periodMonthSchema } from '../../utils/period'

const id = z.string().min(1).max(40)

export const listCommissionsSchema = paginationSchema.extend({
  resellerId: id.optional(),
  customerAccountId: id.optional(),
  status: z.enum(['PENDING', 'APPROVED', 'PAYABLE', 'PAID', 'REVERSED']).optional(),
  entryType: z.enum(['EARNING', 'CLAWBACK']).optional(),
  periodMonth: periodMonthSchema.optional(),
})

export const resellerQuerySchema = z.object({
  resellerId: id.optional(),
})

export const byCustomerSchema = resellerQuerySchema.extend({
  periodMonth: periodMonthSchema.optional(),
})

export const monthlyReportSchema = resellerQuerySchema.extend({
  month: periodMonthSchema.optional(),
})

export const approveCommissionsSchema = z.object({
  ids: z.array(id).min(1).max(500),
})

export const reverseCommissionSchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(500),
})

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The day the reseller was paid: today (business time) or earlier. A date typed as YYYY-MM-DD is judged as that calendar
 * day, so "today" is accepted whatever the UTC date is; a full timestamp is judged by its business-time day.
 */
const paidAtSchema = z
  .custom<string | number>((v) => typeof v === 'string' || typeof v === 'number', 'Enter a valid payment date (YYYY-MM-DD)')
  .transform((raw, ctx) => {
    const value = typeof raw === 'string' ? raw.trim() : raw
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (value === '') return refuse('Enter the payment date (YYYY-MM-DD)')
    const date = new Date(value)
    const typedDay = typeof value === 'string' && DATE_ONLY.test(value)
    // `new Date('2026-02-31')` quietly becomes 3 March, so a typed date must read back as itself.
    if (Number.isNaN(date.getTime()) || (typedDay && date.toISOString().slice(0, 10) !== value)) return refuse('Enter a valid payment date (YYYY-MM-DD)')
    const day = typedDay ? (value as string) : businessDateOf(date)
    if (day > businessDateOf()) return refuse('Payment date cannot be in the future')
    return date
  })

export const createPayoutSchema = z.object({
  resellerId: id,
  /** Settle only these PAYABLE rows; omit to settle everything payable. */
  commissionIds: z.array(id).min(1).max(1000).optional(),
  paymentReference: z.string().trim().min(3, 'Payment reference is required').max(100),
  paidAt: paidAtSchema.optional(),
  note: z.string().trim().max(500).optional(),
})

export const listPayoutsSchema = paginationSchema.extend({
  resellerId: id.optional(),
})

export const recordSubscriptionEventSchema = z.object({
  customerAccountId: id,
  type: z.enum(['PAYMENT_VERIFIED', 'CANCELLED', 'REFUNDED']),
  periodMonth: periodMonthSchema,
  /** SaaS payment / invoice / activation reference. */
  externalRef: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
  /** REFUNDED only: whether the refund also ends the subscription (default true). */
  endSubscription: z.boolean().optional(),
})

export type ListCommissionsQuery = z.infer<typeof listCommissionsSchema>
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>
export type RecordSubscriptionEventInput = z.infer<typeof recordSubscriptionEventSchema>
