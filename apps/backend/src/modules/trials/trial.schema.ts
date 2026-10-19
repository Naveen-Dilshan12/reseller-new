import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination'
import { email, mobile, text } from '../resellers/reseller.schema'

/** Forwarded to the SaaS to create the tenant owner; never stored by the platform. */
export const trialOwnerSchema = z
  .object({
    businessName: z.string().trim().min(2, 'Shop / Business name must be at least 2 characters').max(150).optional(),
    shopName: z.string().trim().min(2, 'Shop name must be at least 2 characters').max(150).optional(),
    contactName: z.string().trim().min(2, 'Owner / Contact name must be at least 2 characters').max(150).optional(),
    ownerName: z.string().trim().min(2, 'Owner name must be at least 2 characters').max(150).optional(),
    contactEmail: email.optional(),
    email: email.optional(),
    contactPhone: mobile.optional(),
    phone: mobile.optional(),
    password: z.string().trim().min(6, 'Password must be at least 6 characters').max(100).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.businessName || v.shopName), {
    message: 'Shop name is required (at least 2 characters)',
    path: ['shopName'],
  })
  .refine((v) => Boolean(v.contactName || v.ownerName), {
    message: 'Owner name is required (at least 2 characters)',
    path: ['ownerName'],
  })
  .refine((v) => Boolean(v.contactEmail || v.email), {
    message: 'Valid email is required',
    path: ['email'],
  })
  .refine((v) => Boolean(v.contactPhone || v.phone), {
    message: 'Valid phone number is required (e.g. 0771234567 or +94771234567)',
    path: ['phone'],
  })

export interface CanonicalTrialOwner {
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
  password?: string
}

export function normalizeTrialOwner(raw: z.infer<typeof trialOwnerSchema>): CanonicalTrialOwner {
  return {
    businessName: (raw.shopName || raw.businessName)!.trim(),
    contactName: (raw.ownerName || raw.contactName)!.trim(),
    contactEmail: (raw.email || raw.contactEmail)!.trim().toLowerCase(),
    contactPhone: (raw.phone || raw.contactPhone)!.trim(),
    password: raw.password?.trim() || undefined,
  }
}

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
