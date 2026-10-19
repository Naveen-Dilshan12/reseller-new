import { Router } from 'express'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { smsTestLimiter } from '../../config/rate-limit'
import { smsGatewayService } from '../sms/sms-gateway.service'
import { smsTestSchema, updateBankDetailsSchema, updateLevelsSchema, updateSmsGatewaySchema } from './settings.schema'
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
    sendSuccess(res, result, `Commission levels updated; ${result.levelChanges} partner level(s) changed`)
  }),
)

router.get(
  '/sms-gateway',
  requirePermission('settings:read'),
  asyncHandler(async (_req, res) => sendSuccess(res, await smsGatewayService.getPublicConfig())),
)

router.put(
  '/sms-gateway',
  requirePermission('settings:manage'),
  validate(updateSmsGatewaySchema),
  asyncHandler(async (req, res) => {
    const { userId, senderId, enabled, dailyLimit, updateApiKey, apiKey } = req.body
    sendSuccess(res, await smsGatewayService.updateConfig(req, { userId, senderId, enabled, dailyLimit, apiKey: updateApiKey ? apiKey : undefined }), 'SMS gateway settings saved')
  }),
)

// Sends one real SMS, so: admin-only, an explicit destination number and a tight rate limit.
router.post(
  '/sms-gateway/test',
  requirePermission('settings:manage'),
  smsTestLimiter,
  validate(smsTestSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await smsGatewayService.sendTest(req, req.body.phone), 'Test SMS sent')),
)

export default router
