import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination'
import { periodMonthSchema } from '../../utils/period'

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

export const createPayoutSchema = z.object({
  resellerId: id,
  /** Settle only these PAYABLE rows; omit to settle everything payable. */
  commissionIds: z.array(id).min(1).max(1000).optional(),
  paymentReference: z.string().trim().min(3, 'Payment reference is required').max(100),
  paidAt: z.coerce.date().optional(),
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
