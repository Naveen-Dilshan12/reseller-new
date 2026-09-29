import { Router } from 'express'
import { authLimiter } from '../../config/rate-limit'
import { authenticate } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { authController } from './auth.controller'
import { changePasswordSchema, loginSchema, refreshSchema } from './auth.schema'

const router = Router()

router.post('/login', authLimiter, validate(loginSchema), authController.login)
router.post('/refresh', authLimiter, validate(refreshSchema), authController.refresh)
router.post('/logout', authenticate, authController.logout)
router.get('/me', authenticate, authController.me)
router.post('/change-password', authenticate, validate(changePasswordSchema), authController.changePassword)

export default router
