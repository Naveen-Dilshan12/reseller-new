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

const trialRule = (v: { trialAvailable?: boolean; trialDays?: number | null }) => !(v.trialAvailable === false && v.trialDays)
const trialRuleMessage = { message: 'Trial days can only be set when a trial is available', path: ['trialDays'] }

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

/** `code` is immutable: audit entries and SaaS webhooks refer to it. */
export const updateProductSchema = z
  .object(productFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine(trialRule, trialRuleMessage)

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
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>
export type SetAccessInput = z.infer<typeof setAccessSchema>
