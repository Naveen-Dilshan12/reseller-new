import { z } from 'zod'

export const reason = z.string().trim().min(5, 'Give a reason for the change (at least 5 characters)').max(300)

export const updateBankDetailsSchema = z
  .object({
    value: z.string().trim().min(10, 'Enter the full bank details').max(1000),
    reason,
  })
  .strict()

const levelSchema = z
  .object({
    level: z.number().int().min(1).max(20),
    name: z.string().trim().min(2).max(40),
    minActiveCustomers: z.number().int().min(0).max(100000),
    maxActiveCustomers: z.number().int().min(0).max(100000).nullable(),
    ratePercent: z.number().min(0).max(100).multipleOf(0.01),
  })
  .strict()

/** Tiers must start at level 1, be contiguous (no gaps or overlaps) and end open-ended. */
export const updateLevelsSchema = z
  .object({ levels: z.array(levelSchema).min(1).max(20), reason })
  .strict()
  .superRefine(({ levels }, ctx) => {
    const sorted = [...levels].sort((a, b) => a.level - b.level)
    sorted.forEach((l, i) => {
      const path = ['levels', i]
      if (l.level !== i + 1) ctx.addIssue({ code: 'custom', path: [...path, 'level'], message: 'Levels must be numbered 1, 2, 3… without gaps' })
      if (l.maxActiveCustomers !== null && l.maxActiveCustomers < l.minActiveCustomers) {
        ctx.addIssue({ code: 'custom', path: [...path, 'maxActiveCustomers'], message: 'Maximum must be at least the minimum' })
      }
      const next = sorted[i + 1]
      if (next) {
        if (l.maxActiveCustomers === null) {
          ctx.addIssue({ code: 'custom', path: [...path, 'maxActiveCustomers'], message: 'Only the last level can be open-ended' })
        } else if (next.minActiveCustomers !== l.maxActiveCustomers + 1) {
          ctx.addIssue({ code: 'custom', path: ['levels', i + 1, 'minActiveCustomers'], message: `Must start at ${l.maxActiveCustomers + 1}` })
        }
      } else if (l.maxActiveCustomers !== null) {
        ctx.addIssue({ code: 'custom', path: [...path, 'maxActiveCustomers'], message: 'The last level must have no maximum' })
      }
    })
  })

import { normalizeSmsPhone, SMS_PHONE_MESSAGE } from '../../utils/phone'

export const smsPhoneField = z
  .string({ required_error: 'Phone number is required' })
  .max(40, SMS_PHONE_MESSAGE)
  .transform((value, ctx) => {
    const normalized = normalizeSmsPhone(value)
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SMS_PHONE_MESSAGE })
      return z.NEVER
    }
    return normalized
  })

/** `apiKey` is accepted only together with `updateApiKey: true`; otherwise the stored key is kept as it is. */
export const updateSmsGatewaySchema = z
  .object({
    provider: z.literal('SMSLENZ').default('SMSLENZ'),
    userId: z.string().trim().min(1, 'User ID is required').max(40).regex(/^[A-Za-z0-9_-]+$/, 'User ID may only contain letters, digits, - and _'),
    senderId: z.string().trim().min(1, 'Sender ID is required').max(20).regex(/^[A-Za-z0-9 _.-]+$/, 'Sender ID may only contain letters, digits, spaces, . - and _'),
    enabled: z.boolean(),
    dailyLimit: z.number().int().min(1, 'Daily limit must be at least 1').max(100000).default(500),
    updateApiKey: z.boolean().default(false),
    apiKey: z.string().trim().min(8, 'API key looks too short').max(200).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.updateApiKey && !d.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'Enter the new API key' })
    if (!d.updateApiKey && d.apiKey) ctx.addIssue({ code: 'custom', path: ['updateApiKey'], message: 'Choose "update API key" to replace the stored key' })
  })

export const smsTestSchema = z.object({ phone: smsPhoneField }).strict()

export type UpdateSmsGatewayInput = z.infer<typeof updateSmsGatewaySchema>

export type UpdateLevelsInput = z.infer<typeof updateLevelsSchema>
