import { z } from 'zod'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const optionalId = z.string().trim().min(1).max(40).optional()

export const resellerDashboardSchema = z
  .object({
    resellerId: optionalId,
    from: day.optional(),
    to: day.optional(),
    productId: optionalId,
    customerStatus: z.enum(['PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED']).optional(),
    trialStatus: z.enum(['PENDING', 'SUBMITTED', 'PROVISIONED', 'FAILED', 'CANCELLED']).optional(),
    activationStatus: z
      .enum(['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED'])
      .optional(),
    commissionStatus: z.enum(['PENDING', 'APPROVED', 'PAYABLE', 'PAID', 'REVERSED']).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'Start date must be before end date', path: ['from'] })

export type ResellerDashboardQuery = z.infer<typeof resellerDashboardSchema>
