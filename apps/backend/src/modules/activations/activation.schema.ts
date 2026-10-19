import { z } from 'zod'
import type { ActivationRequestStatus } from '@prisma/client'
import { paginationSchema } from '../../utils/pagination'
import { periodMonthSchema } from '../../utils/period'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const ACTIVATION_STATUSES = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED'] as const satisfies readonly ActivationRequestStatus[]
// Fails to compile if the Prisma enum gains a status this list does not know about.
const _allStatusesListed: [Exclude<ActivationRequestStatus, (typeof ACTIVATION_STATUSES)[number]>] extends [never] ? true : never = true
void _allStatusesListed

/** Multipart text fields of the activation request form; the bank slip is the `slip` file. */
export const createActivationSchema = z
  .object({
    customerId: z.string().min(1, 'Select a customer').max(40),
    productId: z.string().min(1, 'Select a product').max(40),
    periodMonth: periodMonthSchema,
    amount: z.coerce.number({ invalid_type_error: 'Enter the amount paid' }).positive().multipleOf(0.01),
    payerName: z.string().trim().min(2, 'Enter the name on the bank transfer').max(150),
    payerBank: z.string().trim().max(100).optional().transform((v) => v || undefined),
    transactionRef: z.string().trim().min(3, 'Enter the bank transaction / reference number').max(100),
    transferDate: isoDate,
    notes: z.string().trim().max(500).optional().transform((v) => v || undefined),
  })
  .strict()

/** `status` query filter: one or more activation request statuses, comma-separated (also used by the bank slips register). */
export const activationStatusFilter = z
  .string()
  .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
  .refine((v) => v.split(',').every((s) => (ACTIVATION_STATUSES as readonly string[]).includes(s)), {
    message: `Use one or more of ${ACTIVATION_STATUSES.join(', ')}, separated by commas`,
  })

export const listActivationsSchema = paginationSchema.extend({
  resellerId: z.string().max(40).optional(),
  productId: z.string().max(40).optional(),
  customerAccountId: z.string().max(40).optional(),
  status: activationStatusFilter.optional(),
  search: z.string().trim().max(100).optional(),
})

export const verifyPaymentSchema = z
  .object({
    confirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm the payment was received in the company account' }) }),
    note: z.string().trim().min(5, 'Describe how the payment was verified (e.g. bank statement line)').max(500),
  })
  .strict()

export const approveSchema = z.object({ note: z.string().trim().max(500).optional() }).strict()

export const rejectSchema = z
  .object({ reason: z.string().trim().min(10, 'Rejection reason must be at least 10 characters').max(1000) })
  .strict()

export const completeManualSchema = z
  .object({
    activationReference: z.string().trim().min(2, 'Enter the subscription / invoice reference from the SaaS').max(100),
    externalTenantId: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()

export type CreateActivationInput = z.infer<typeof createActivationSchema>
export type ListActivationsQuery = z.infer<typeof listActivationsSchema>
