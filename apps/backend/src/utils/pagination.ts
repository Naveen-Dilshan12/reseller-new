import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type Pagination = z.infer<typeof paginationSchema>

export function toSkipTake({ page, limit }: Pagination) {
  return { skip: (page - 1) * limit, take: limit }
}
