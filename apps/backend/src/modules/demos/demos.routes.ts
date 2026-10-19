import { Router } from 'express'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendPaginated, sendSuccess } from '../../utils/response'
import {
  approveDemoSchema,
  confirmDemoSchema,
  createDemoRequestSchema,
  listDemoRequestsSchema,
  rejectDemoSchema,
  saveWelcomeMessageSchema,
  type ListDemoRequestsQuery,
} from './demo.schema'
import { demoService } from './demo.service'

const router = Router()
router.use(authenticate)

router.get(
  '/',
  requirePermission('demos:read'),
  validate(listDemoRequestsSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListDemoRequestsQuery
    const { items, total, pipelineCounts } = await demoService.list(q, req)
    sendPaginated(res, items, total, q.page, q.limit, { pipelineCounts })
  }),
)

router.get(
  '/:id',
  requirePermission('demos:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await demoService.get(req.params.id, req))),
)

router.post(
  '/',
  requirePermission('demos:create'),
  validate(createDemoRequestSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await demoService.create(req.body, req), 'Demo request submitted', 201)),
)

router.post(
  '/:id/approve',
  requirePermission('demos:review'),
  validate(approveDemoSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await demoService.approve(req.params.id, req.body.note, req), 'Demo request approved')),
)

router.post(
  '/:id/reject',
  requirePermission('demos:review'),
  validate(rejectDemoSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await demoService.reject(req.params.id, req.body.reason, req), 'Demo request rejected')),
)

router.post(
  '/:id/welcome-message',
  requirePermission('demos:review'),
  validate(saveWelcomeMessageSchema),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await demoService.saveWelcomeMessage(req.params.id, req.body.welcomeMessage, req), 'Welcome message saved'),
  ),
)

router.post(
  '/:id/confirm',
  requirePermission('demos:review'),
  validate(confirmDemoSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await demoService.confirm(req.params.id, req.body, req), 'Demo request confirmed')),
)

export default router
