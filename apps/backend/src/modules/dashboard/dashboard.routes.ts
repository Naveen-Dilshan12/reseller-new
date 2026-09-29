import { Router } from 'express'
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.middleware'
import { forbidden } from '../../middleware/error.middleware'
import { isPlatformRole } from '../../rbac/permissions'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { resellerDashboardSchema, type ResellerDashboardQuery } from './dashboard.schema'
import { adminDashboard, dashboardService } from './dashboard.service'

const router = Router()
router.use(authenticate)

/** Reseller users see their own dashboard; platform users pass `resellerId`. */
router.get(
  '/reseller',
  requirePermission('accounts:read'),
  validate(resellerDashboardSchema, 'query'),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await dashboardService.reseller(req.query as unknown as ResellerDashboardQuery, req)),
  ),
)

router.get(
  '/admin',
  requirePermission('resellers:read'),
  asyncHandler(async (req, res) => {
    if (!isPlatformRole(currentUser(req).role)) throw forbidden()
    sendSuccess(res, await adminDashboard(req))
  }),
)

export default router
