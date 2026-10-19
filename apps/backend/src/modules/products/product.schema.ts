import { z } from 'zod'
import { env } from '../../config/env'
import { paginationSchema } from '../../utils/pagination'
import { integrationRegistry } from '../integrations/integration-registry'

const productFields = {
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'COMING_SOON']),
  monthlyPrice: z.coerce.number().positive().max(10_000_000).multipleOf(0.01),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  trialAvailable: z.boolean(),
  trialDays: z.coerce.number().int().min(1).max(90).nullable().optional(),
}

/**
 * Only the request itself is visible here. A partial update such as `{ trialDays: 30 }` depends on whether the stored
 * product has a trial, so `productService.update` enforces the same rule against the stored product.
 */
const trialRule = (v: { trialAvailable?: boolean; trialDays?: number | null }) => !(v.trialAvailable === false && v.trialDays)
export const trialRuleMessage = { message: 'Trial days can only be set when a trial is available', path: ['trialDays'] }

export const createProductSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use capital letters, digits and underscores, e.g. MOBILE_SHOP'),
    ...productFields,
    status: productFields.status.default('INACTIVE'),
    currency: productFields.currency.default('LKR'),
    trialAvailable: productFields.trialAvailable.default(false),
  })
  .strict()
  .refine(trialRule, trialRuleMessage)

/**
 * The product's `updatedAt` as the client last saw it (an ISO timestamp, as the API returns it). Not a product field:
 * `productService.update` uses it to refuse an edit based on an older copy than the one now stored.
 */
const expectedUpdatedAt = z.string().datetime({ offset: true }).transform((s) => new Date(s))

/**
 * Status moves only through the lifecycle actions (Retire, Restore, Set coming soon, Launch), which snapshot the impact and
 * write their own audit entry (taking a product off sale also requires a reason). A general edit may still carry `status` (older forms send the whole product), but only as the value
 * the product already has: `productService.update` compares it with the stored product, refuses a different one with this
 * message and never writes it.
 */
export const statusRuleMessage = {
  message:
    'Status cannot be changed by editing a product. Use a lifecycle action: Retire (POST /:id/retire), Restore (POST /:id/restore), Set coming soon (POST /:id/coming-soon) or Launch (POST /:id/launch). Each reviews the impact first and is recorded in the audit log.',
  path: ['status'],
}

/** `code` is immutable: audit entries and SaaS webhooks refer to it. */
export const updateProductSchema = z
  .object({ ...productFields, expectedUpdatedAt })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).some((key) => key !== 'expectedUpdatedAt'), 'Nothing to update')
  .refine(trialRule, trialRuleMessage)

/** The reason an admin gives for a lifecycle change that takes a product off sale; it is recorded in the audit log. */
const lifecycleReason = (missing: string) => z.string({ required_error: missing }).trim().min(10, 'Give a reason of at least 10 characters').max(500)

/** Retire takes a product off sale. The reason is recorded in the audit log; the version is required. */
export const retireProductSchema = z
  .object({
    reason: lifecycleReason('Give a reason for retiring this product'),
    expectedUpdatedAt,
  })
  .strict()

/** Restore puts an inactive product back on sale. The note is optional; the version is required. */
export const restoreProductSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
    expectedUpdatedAt,
  })
  .strict()

/** Set coming soon marks an active or inactive product as not launched yet. Like Retire, it needs a reason and the version. */
export const comingSoonProductSchema = z
  .object({
    reason: lifecycleReason('Give a reason for setting this product to coming soon'),
    expectedUpdatedAt,
  })
  .strict()

/** Launch puts a coming-soon product on sale. Like Restore, the note is optional and the version is required. */
export const launchProductSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
    expectedUpdatedAt,
  })
  .strict()

const secret = (label: string, min: number) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(500)
    .regex(/^\S+$/, `${label} must not contain spaces`)

/**
 * Only connection settings for the partner API are accepted (strict): no
 * database or internal service credentials can be stored. Secrets are
 * write-only; omit them to keep the stored value.
 */
export const updateIntegrationSchema = z
  .object({
    provider: z.enum(integrationRegistry.keys),
    enabled: z.boolean().default(true),
    baseUrl: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((u) => env.NODE_ENV !== 'production' || u.startsWith('https://'), 'Base URL must use https')
      .nullable()
      .optional(),
    apiKey: secret('API key', 16).optional(),
    signingSecret: secret('Signing secret', 32).optional(),
    clearCredentials: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.clearCredentials && (v.apiKey || v.signingSecret)), 'Cannot set and clear credentials together')

export const integrationLogsSchema = paginationSchema.extend({
  success: z.enum(['true', 'false']).optional(),
})

export const setAccessSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
    note: z.string().trim().max(300).optional(),
  })
  .strict()

export type CreateProductInput = z.infer<typeof createProductSchema>
export type UpdateProductInput = z.infer<typeof updateProductSchema>
export type RetireProductInput = z.infer<typeof retireProductSchema>
export type RestoreProductInput = z.infer<typeof restoreProductSchema>
export type ComingSoonProductInput = z.infer<typeof comingSoonProductSchema>
export type LaunchProductInput = z.infer<typeof launchProductSchema>
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>
export type SetAccessInput = z.infer<typeof setAccessSchema>
