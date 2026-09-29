import { Request, Response } from 'express'
import { asyncHandler } from '../../utils/async-handler'
import { sendSuccess } from '../../utils/response'
import { resellerApplicationsService } from './reseller-applications.service'
import { resellerRegistrationService } from './reseller-registration.service'
import type { ListApplicationsQuery } from './reseller.schema'

export const resellersController = {
  register: asyncHandler(async (req: Request, res: Response) => {
    const result = await resellerRegistrationService.register(req, req.body)
    sendSuccess(res, result, 'Application submitted. You can log in once it has been approved.', 201)
  }),

  listApplications: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as unknown as ListApplicationsQuery
    const { items, total, pendingCount } = await resellerApplicationsService.list(query)
    res.json({
      success: true,
      data: items,
      meta: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit), pendingCount },
    })
  }),

  getApplication: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await resellerApplicationsService.get(req, req.params.id))
  }),

  revealBankAccount: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await resellerApplicationsService.revealBankAccountNumber(req, req.params.id))
  }),

  approve: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await resellerApplicationsService.approve(req, req.params.id, req.body), 'Application approved')
  }),

  reject: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await resellerApplicationsService.reject(req, req.params.id, req.body), 'Application rejected')
  }),
}
