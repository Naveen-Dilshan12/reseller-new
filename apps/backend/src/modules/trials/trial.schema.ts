import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination'
import { email, mobile, text } from '../resellers/reseller.schema'

/** Forwarded to the SaaS to create the tenant owner; never stored by the platform. */
export const trialOwnerSchema = z
  .object({
    businessName: text('Business name', 2, 150),
    contactName: text('Contact name', 3, 150),
    contactEmail: email,
    contactPhone: mobile,
  })
  .strict()

export const createTrialSchema = z
  .object({
    /** Platform users creating a trial on behalf of a reseller; ignored for reseller users. */
    resellerId: z.string().max(40).optional(),
    productId: z.string().min(1, 'Select a product').max(40),
    /** Existing customer of the reseller; omit to create a new one named after the business. */
    customerId: z.string().max(40).optional(),
    owner: trialOwnerSchema,
    notes: z.string().trim().max(500).optional(),
  })
  .strict()

export const retryTrialSchema = z.object({ owner: trialOwnerSchema }).strict()

export const listTrialsSchema = paginationSchema.extend({
  resellerId: z.string().max(40).optional(),
  productId: z.string().max(40).optional(),
  status: z.enum(['PENDING', 'SUBMITTED', 'PROVISIONED', 'FAILED', 'CANCELLED']).optional(),
  search: z.string().trim().max(100).optional(),
})

export type TrialOwner = z.infer<typeof trialOwnerSchema>
export type CreateTrialInput = z.infer<typeof createTrialSchema>
export type ListTrialsQuery = z.infer<typeof listTrialsSchema>
