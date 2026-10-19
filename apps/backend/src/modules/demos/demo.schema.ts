import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination'
import { email, mobile, text } from '../resellers/reseller.schema'

const DEMO_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DEMO_CREATED', 'CONFIRMED'] as const

export const createDemoRequestSchema = z
  .object({
    productId: z.string().min(1, 'Select a product').max(40),
    businessName: text('Business / customer name', 2, 150),
    contactName: text('Contact name', 2, 150),
    contactEmail: email,
    contactPhone: mobile,
    notes: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => v || undefined),
  })
  .strict()

export const listDemoRequestsSchema = paginationSchema.extend({
  resellerId: z.string().max(40).optional(),
  productId: z.string().max(40).optional(),
  status: z.enum(DEMO_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
})

export const approveDemoSchema = z.object({ note: z.string().trim().max(500).optional() }).strict()

export const rejectDemoSchema = z
  .object({ reason: z.string().trim().min(10, 'Rejection reason must be at least 10 characters').max(1000) })
  .strict()

/**
 * The complete, already-prepared message an admin pastes in for the customer.
 * It is stored and shown to the seller exactly as pasted (no trimming or
 * rewriting), so it is only checked for being non-blank and for a length that
 * still fits in a wa.me link.
 */
export const saveWelcomeMessageSchema = z
  .object({
    welcomeMessage: z
      .string({ required_error: 'Customer Welcome Message is required' })
      .max(4000, 'Customer Welcome Message must be 4000 characters or fewer')
      .refine((v) => v.trim().length > 0, 'Customer Welcome Message is required'),
  })
  .strict()

/**
 * Confirming a demo links the demo shop to a customer + trial account, so the admin supplies the
 * SaaS tenant ID of the shop they created. Paid Activation only works on an account with a tenant.
 */
export const confirmDemoSchema = z
  .object({
    externalTenantId: z
      .string({ required_error: 'SaaS tenant ID is required' })
      .trim()
      .min(1, 'SaaS tenant ID is required')
      .max(100),
    note: z.string().trim().max(500).optional(),
  })
  .strict()

export type DemoRequestStatusValue = (typeof DEMO_STATUSES)[number]
export type ConfirmDemoInput = z.infer<typeof confirmDemoSchema>
export type CreateDemoRequestInput = z.infer<typeof createDemoRequestSchema>
export type ListDemoRequestsQuery = z.infer<typeof listDemoRequestsSchema>
export type SaveWelcomeMessageInput = z.infer<typeof saveWelcomeMessageSchema>
