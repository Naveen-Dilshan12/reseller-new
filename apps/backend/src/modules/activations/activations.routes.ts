import { Router } from 'express'
import multer from 'multer'
import { env } from '../../config/env'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendPaginated, sendSuccess } from '../../utils/response'
import {
  approveSchema,
  completeManualSchema,
  createActivationSchema,
  listActivationsSchema,
  rejectSchema,
  verifyPaymentSchema,
  type ListActivationsQuery,
} from './activation.schema'
import { activationService } from './activation.service'

/** Kept in memory until the content is verified, then written encrypted to private storage. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20, fieldSize: 2048 },
})

const router = Router()
router.use(authenticate)

router.get(
  '/payment-info',
  requirePermission('activations:read'),
  asyncHandler(async (_req, res) => sendSuccess(res, await activationService.paymentInfo())),
)

router.get(
  '/',
  requirePermission('activations:read'),
  validate(listActivationsSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListActivationsQuery
    const { items, total } = await activationService.list(q, req)
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

router.get(
  '/:id',
  requirePermission('activations:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await activationService.get(req.params.id, req))),
)

router.get(
  '/:id/bank-slips/:slipId',
  requirePermission('bankslips:read'),
  asyncHandler(async (req, res) => {
    const slip = await activationService.readSlip(req.params.id, req.params.slipId, req)
    res.set({
      'Content-Type': slip.mimeType,
      'Content-Length': String(slip.content.length),
      'Content-Disposition': `inline; filename="${slip.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    res.send(slip.content)
  }),
)

router.post(
  '/',
  requirePermission('activations:create', 'bankslips:upload'),
  upload.single('slip'),
  validate(createActivationSchema),
  asyncHandler(async (req, res) => {
    const created = await activationService.create(req.body, req.file, req)
    sendSuccess(res, created, `Activation request ${created.reference} submitted`, 201)
  }),
)

router.post(
  '/:id/cancel',
  requirePermission('activations:create'),
  asyncHandler(async (req, res) => sendSuccess(res, await activationService.cancel(req.params.id, req), 'Request cancelled')),
)

router.post(
  '/:id/start-review',
  requirePermission('activations:review'),
  asyncHandler(async (req, res) => sendSuccess(res, await activationService.startReview(req.params.id, req), 'Review started')),
)

router.post(
  '/:id/verify-payment',
  requirePermission('activations:review'),
  validate(verifyPaymentSchema),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await activationService.verifyPayment(req.params.id, req.body.note, req), 'Payment verified'),
  ),
)

router.post(
  '/:id/approve',
  requirePermission('activations:review'),
  validate(approveSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await activationService.approve(req.params.id, req.body.note, req), 'Request approved')),
)

router.post(
  '/:id/reject',
  requirePermission('activations:review'),
  validate(rejectSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await activationService.reject(req.params.id, req.body.reason, req), 'Request rejected')),
)

router.post(
  '/:id/activate',
  requirePermission('activations:activate'),
  asyncHandler(async (req, res) => {
    const result = await activationService.activate(req.params.id, req)
    sendSuccess(res, result, result.message)
  }),
)

router.post(
  '/:id/sync',
  requirePermission('activations:activate'),
  asyncHandler(async (req, res) => {
    const result = await activationService.sync(req.params.id, req)
    sendSuccess(res, result, result.message)
  }),
)

router.post(
  '/:id/complete',
  requirePermission('activations:activate'),
  validate(completeManualSchema),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await activationService.completeManually(req.params.id, req.body, req), 'Activation completed'),
  ),
)

export default router
