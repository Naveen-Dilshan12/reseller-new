import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { paginationSchema, toSkipTake } from '../../utils/pagination'
import { sendPaginated, sendSuccess } from '../../utils/response'

const listSchema = paginationSchema.extend({
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  resellerId: z.string().max(40).optional(),
  actorUserId: z.string().max(40).optional(),
  actorType: z.enum(['USER', 'SYSTEM', 'SAAS']).optional(),
  action: z.string().max(80).optional(),
  /** Matches action, actor email or entity ID. */
  search: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

/** Read-only: the audit log has no update or delete endpoints (and is append-only in the database). */
const router = Router()
router.use(authenticate, requirePermission('audit:read'))

router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>
    const where: Prisma.AuditLogWhereInput = {
      entityType: q.entityType,
      entityId: q.entityId,
      resellerId: q.resellerId,
      actorUserId: q.actorUserId,
      actorType: q.actorType,
      action: q.action,
      createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
      ...(q.search
        ? {
            OR: [
              { action: { contains: q.search, mode: 'insensitive' } },
              { actorEmail: { contains: q.search, mode: 'insensitive' } },
              { entityId: { contains: q.search } },
            ],
          }
        : {}),
    }
    const [items, total] = await Promise.all([
      // `id` breaks ties between entries written in the same instant, so paging never repeats or skips one.
      prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...toSkipTake(q) }),
      prisma.auditLog.count({ where }),
    ])
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

/** Distinct actions and entity types, for filter dropdowns. */
router.get(
  '/facets',
  asyncHandler(async (_req, res) => {
    const [actions, entityTypes] = await Promise.all([
      prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { action: 'asc' } }),
      prisma.auditLog.groupBy({ by: ['entityType'], _count: { _all: true }, orderBy: { entityType: 'asc' } }),
    ])
    sendSuccess(res, {
      actions: actions.map((a) => ({ value: a.action, count: a._count._all })),
      entityTypes: entityTypes.map((e) => ({ value: e.entityType, count: e._count._all })),
    })
  }),
)

export default router
