import { z } from 'zod'

const reason = z.string().trim().min(5, 'Give a reason for the change (at least 5 characters)').max(300)

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

export type UpdateLevelsInput = z.infer<typeof updateLevelsSchema>
