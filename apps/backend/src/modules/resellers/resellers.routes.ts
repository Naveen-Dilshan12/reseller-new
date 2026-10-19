import { Router } from 'express'
import { registrationLimiter } from '../../config/rate-limit'
import { authenticate, optionalAuthenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { resellersController } from './resellers.controller'
import {
  adminResellersService,
  listResellersSchema,
  reactivateSchema,
  suspendSchema,
  type ListResellersQuery,
} from './admin-resellers.service'
import {
  approveApplicationSchema,
  listApplicationsSchema,
  registerResellerSchema,
  rejectApplicationSchema,
} from './reseller.schema'

/**
 * Public: `/reseller-registration`. Reachable without a session (a genuinely
 * new applicant), but `optionalAuthenticate` picks up a Bearer token when one
 * is sent so the service can link the application to the caller's own
 * account instead of resolving a target user from the request body.
 */
export const registrationRouter = Router()
registrationRouter.post(
  '/',
  registrationLimiter,
  optionalAuthenticate,
  validate(registerResellerSchema),
  resellersController.register,
)

/** Platform staff: `/admin/reseller-applications` */
export const applicationsRouter = Router()
applicationsRouter.use(authenticate)
applicationsRouter.get(
  '/',
  requirePermission('resellers:read'),
  validate(listApplicationsSchema, 'query'),
  resellersController.listApplications,
)
applicationsRouter.get('/:id', requirePermission('resellers:read'), resellersController.getApplication)
applicationsRouter.post(
  '/:id/bank-account/reveal',
  requirePermission('resellers:bank-reveal'),
  resellersController.revealBankAccount,
)
applicationsRouter.post(
  '/:id/approve',
  requirePermission('resellers:manage'),
  validate(approveApplicationSchema),
  resellersController.approve,
)
applicationsRouter.post(
  '/:id/reject',
  requirePermission('resellers:manage'),
  validate(rejectApplicationSchema),
  resellersController.reject,
)

/** Platform staff: `/admin/resellers` (approved reseller management). */
export const resellersAdminRouter = Router()
resellersAdminRouter.use(authenticate)
resellersAdminRouter.get(
  '/',
  requirePermission('resellers:read'),
  validate(listResellersSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ListResellersQuery
    const { items, total, statusCounts } = await adminResellersService.list(q)
    res.json({ success: true, data: items, meta: { total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit), statusCounts } })
  }),
)
resellersAdminRouter.get(
  '/:id',
  requirePermission('resellers:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await adminResellersService.summary(req.params.id))),
)
resellersAdminRouter.post(
  '/:id/suspend',
  requirePermission('resellers:manage'),
  validate(suspendSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await adminResellersService.suspend(req, req.params.id, req.body.reason), 'Partner suspended')),
)
resellersAdminRouter.post(
  '/:id/reactivate',
  requirePermission('resellers:manage'),
  validate(reactivateSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await adminResellersService.reactivate(req, req.params.id, req.body.note), 'Partner reactivated')),
)
