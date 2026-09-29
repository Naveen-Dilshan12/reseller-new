import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { authenticate, requirePermission, resolveResellerId } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { paginationSchema, toSkipTake } from '../../utils/pagination'
import { sendPaginated } from '../../utils/response'

const listSchema = paginationSchema.extend({
  status: z.string().regex(/^[A-Z_]+(,[A-Z_]+)*$/).optional(),
  resellerId: z.string().max(40).optional(),
  search: z.string().trim().max(100).optional(),
  duplicatesOnly: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

/**
 * `/bank-slips`: register of uploaded slips (metadata only). Opening a slip goes
 * through `/activation-requests/:id/bank-slips/:slipId`, which audits every view.
 */
const router = Router()
router.use(authenticate)

router.get(
  '/',
  requirePermission('bankslips:read'),
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>
    const duplicateHashes =
      q.duplicatesOnly === 'true'
        ? (await prisma.bankSlip.groupBy({ by: ['sha256'], having: { sha256: { _count: { gt: 1 } } } })).map((g) => g.sha256)
        : undefined

    const where: Prisma.BankSlipWhereInput = {
      resellerId: resolveResellerId(req, q.resellerId),
      ...(duplicateHashes ? { sha256: { in: duplicateHashes } } : {}),
      ...(q.from || q.to ? { createdAt: { gte: q.from, lte: q.to } } : {}),
      activationRequest: {
        ...(q.status ? { status: { in: q.status.split(',') as Prisma.EnumActivationRequestStatusFilter['in'] } } : {}),
        ...(q.search
          ? {
              OR: [
                { reference: { contains: q.search, mode: 'insensitive' } },
                { transactionRef: { contains: q.search, mode: 'insensitive' } },
                { customerAccount: { customer: { displayName: { contains: q.search, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
    }

    const [rows, total] = await Promise.all([
      prisma.bankSlip.findMany({
        where,
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          createdAt: true,
          reseller: { select: { id: true, code: true, businessName: true } },
          activationRequest: {
            select: {
              id: true,
              reference: true,
              status: true,
              amount: true,
              currency: true,
              transactionRef: true,
              periodMonth: true,
              paymentVerifiedAt: true,
              product: { select: { name: true } },
              customerAccount: { select: { customer: { select: { displayName: true } } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
      }),
      prisma.bankSlip.count({ where }),
    ])
    const counts = await prisma.bankSlip.groupBy({
      by: ['sha256'],
      where: { sha256: { in: rows.map((r) => r.sha256) } },
      _count: { _all: true },
    })
    const countMap = new Map(counts.map((c) => [c.sha256, c._count._all]))
    const items = rows.map(({ sha256, ...r }) => ({ ...r, uploadedTimes: countMap.get(sha256) ?? 1 }))
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

export default router
