import { Router } from 'express'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { updateBankDetailsSchema, updateLevelsSchema } from './settings.schema'
import { settingsService } from './settings.service'

const router = Router()
router.use(authenticate)

router.get(
  '/',
  requirePermission('settings:read'),
  asyncHandler(async (_req, res) => sendSuccess(res, await settingsService.get())),
)

router.put(
  '/company-bank-details',
  requirePermission('settings:manage'),
  validate(updateBankDetailsSchema),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await settingsService.updateCompanyBankDetails(req, req.body.value, req.body.reason), 'Company bank details updated'),
  ),
)

router.put(
  '/commission-levels',
  requirePermission('settings:manage'),
  validate(updateLevelsSchema),
  asyncHandler(async (req, res) => {
    const result = await settingsService.updateCommissionLevels(req, req.body)
    sendSuccess(res, result, `Commission levels updated; ${result.levelChanges} reseller level(s) changed`)
  }),
)

export default router
