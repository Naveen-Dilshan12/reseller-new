import { Router } from 'express'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendPaginated, sendSuccess } from '../../utils/response'
import { createTrialSchema, listTrialsSchema, retryTrialSchema, type ListTrialsQuery } from './trial.schema'
import { trialService } from './trial.service'

const router = Router()
router.use(authenticate)

router.get(
  '/',
  requirePermission('trials:read'),
  validate(listTrialsSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListTrialsQuery
    const { items, total } = await trialService.list(q, req)
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

router.get(
  '/:id',
  requirePermission('trials:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await trialService.get(req.params.id, req))),
)

router.post(
  '/',
  requirePermission('trials:create'),
  validate(createTrialSchema),
  asyncHandler(async (req, res) => {
    const result = await trialService.create(req.body, req)
    sendSuccess(res, result, result.message, 201)
  }),
)

router.post(
  '/:id/retry',
  requirePermission('trials:create'),
  validate(retryTrialSchema),
  asyncHandler(async (req, res) => {
    const result = await trialService.retry(req.params.id, req.body.owner, req)
    sendSuccess(res, result, result.message)
  }),
)

router.post(
  '/:id/sync',
  requirePermission('trials:read'),
  asyncHandler(async (req, res) => {
    const result = await trialService.sync(req.params.id, req)
    sendSuccess(res, result, result.message)
  }),
)

router.post(
  '/:id/cancel',
  requirePermission('trials:create'),
  asyncHandler(async (req, res) => sendSuccess(res, await trialService.cancel(req.params.id, req), 'Trial request cancelled')),
)

export default router
