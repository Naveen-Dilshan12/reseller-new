import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { authenticate, currentUser } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { paginationSchema, toSkipTake } from '../../utils/pagination'
import { sendPaginated, sendSuccess } from '../../utils/response'
import { notFoundError } from '../../middleware/error.middleware'

const listSchema = paginationSchema.extend({
  unread: z.enum(['true', 'false']).optional(),
})

const router = Router()
router.use(authenticate)

router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>
    const where = { userId: currentUser(req).userId, ...(q.unread === 'true' ? { readAt: null } : {}) }
    const [items, total] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
      prisma.notification.count({ where }),
    ])
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const count = await prisma.notification.count({ where: { userId: currentUser(req).userId, readAt: null } })
    sendSuccess(res, { count })
  }),
)

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { userId: currentUser(req).userId, readAt: null },
      data: { readAt: new Date() },
    })
    sendSuccess(res, { updated: result.count })
  }),
)

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: currentUser(req).userId },
      data: { readAt: new Date() },
    })
    if (result.count === 0) throw notFoundError('Notification')
    sendSuccess(res, null, 'Marked as read')
  }),
)

export default router
