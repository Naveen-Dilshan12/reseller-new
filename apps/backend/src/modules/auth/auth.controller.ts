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

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.changePassword(req, currentUser(req).userId, req.body)
    sendSuccess(res, null, 'Password changed. Please log in again on other devices.')
  }),
}
