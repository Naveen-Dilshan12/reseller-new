import { Router } from 'express'
import { authLimiter, passwordResetLimiter } from '../../config/rate-limit'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { authController } from './auth.controller'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerBasicSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  whatsappNumberSchema,
} from './auth.schema'
import { registrationLimiter } from '../../config/rate-limit'

const router = Router()

router.post('/register', registrationLimiter, validate(registerBasicSchema), authController.registerBasic)
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), authController.verifyEmail)
router.post('/resend-verification', passwordResetLimiter, validate(resendVerificationSchema), authController.resendVerification)
router.get('/dev-otp', authController.getDevOtp)
router.post('/login', authLimiter, validate(loginSchema), authController.login)
router.post('/refresh', authLimiter, validate(refreshSchema), authController.refresh)
router.post('/logout', authenticate, authController.logout)
router.get('/me', authenticate, authController.me)
router.post('/me/welcome-shown', authenticate, authController.markWelcomeShown)
router.put('/me/whatsapp', authenticate, validate(whatsappNumberSchema), authController.setWhatsappNumber)
router.delete('/me/whatsapp', authenticate, authController.removeWhatsappNumber)
router.post('/change-password', authenticate, validate(changePasswordSchema), authController.changePassword)
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), authController.forgotPassword)
router.post('/reset-password', passwordResetLimiter, validate(resetPasswordSchema), authController.resetPassword)

export default router
