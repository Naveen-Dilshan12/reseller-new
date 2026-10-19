import { Request, Response } from 'express'
import { currentUser } from '../../middleware/auth.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { authService } from './auth.service'

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.login(req, req.body), 'Logged in')
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.refresh(req, req.body.refreshToken), 'Token refreshed')
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    await authService.logout(req, typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined)
    sendSuccess(res, null, 'Logged out')
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.me(currentUser(req).userId))
  }),

  markWelcomeShown: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.markWelcomeShown(req, currentUser(req).userId))
  }),

  setWhatsappNumber: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.setWhatsappNumber(req, currentUser(req).userId, req.body.whatsappNumber), 'WhatsApp number saved')
  }),

  removeWhatsappNumber: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.removeWhatsappNumber(req, currentUser(req).userId), 'WhatsApp number removed')
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.changePassword(req, currentUser(req).userId, req.body)
    sendSuccess(res, null, 'Password changed. Please log in again on other devices.')
  }),

  forgotPassword: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.forgotPassword(req, req.body)
    sendSuccess(res, null, result.message)
  }),

  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.resetPassword(req, req.body)
    sendSuccess(res, null, result.message)
  }),

  registerBasic: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.registerBasic(req, req.body)
    sendSuccess(res, result, 'Account created successfully', 201)
  }),

  verifyEmail: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.verifyEmail(req, req.body)
    sendSuccess(res, null, result.message)
  }),

  resendVerification: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.resendVerification(req, req.body)
    sendSuccess(res, null, result.message)
  }),

  getDevOtp: asyncHandler(async (req: Request, res: Response) => {
    const email = typeof req.query.email === 'string' ? req.query.email : ''
    const result = authService.getDevOtp(email)
    sendSuccess(res, result)
  }),
}
