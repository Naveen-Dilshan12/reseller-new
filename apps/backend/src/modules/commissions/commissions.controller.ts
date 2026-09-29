import { Request, Response } from 'express'
import { z } from 'zod'
import { badRequest } from '../../middleware/error.middleware'
import { resolveResellerId } from '../../middleware/auth.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { periodMonthOf } from '../../utils/period'
import { sendPaginated, sendSuccess } from '../../utils/response'
import { commissionActionsService } from './commission-actions.service'
import { commissionLedgerService } from './commission-ledger.service'
import { getLevels } from './level.service'
import { recordSubscriptionEvent } from './subscription-events.service'
import type {
  byCustomerSchema,
  listCommissionsSchema,
  listPayoutsSchema,
  monthlyReportSchema,
  resellerQuerySchema,
} from './commission.schema'

const query = <T extends z.ZodTypeAny>(req: Request) => req.query as unknown as z.infer<T>

export const commissionsController = {
  levels: asyncHandler(async (_req, res) => {
    sendSuccess(res, await getLevels())
  }),

  summary: asyncHandler(async (req: Request, res: Response) => {
    const resellerId = resolveResellerId(req, query<typeof resellerQuerySchema>(req).resellerId)
    if (!resellerId) throw badRequest('resellerId is required')
    sendSuccess(res, await commissionLedgerService.summary(resellerId))
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    const q = query<typeof listCommissionsSchema>(req)
    const { items, total, netAmount } = await commissionLedgerService.list(q, resolveResellerId(req, q.resellerId))
    res.json({
      success: true,
      data: items,
      meta: { total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit), netAmount },
    })
  }),

  byCustomer: asyncHandler(async (req: Request, res: Response) => {
    const q = query<typeof byCustomerSchema>(req)
    sendSuccess(res, await commissionLedgerService.byCustomer(resolveResellerId(req, q.resellerId), q.periodMonth))
  }),

  monthlyReport: asyncHandler(async (req: Request, res: Response) => {
    const q = query<typeof monthlyReportSchema>(req)
    sendSuccess(res, await commissionLedgerService.monthlyReport(q.month ?? periodMonthOf(), resolveResellerId(req, q.resellerId)))
  }),

  approve: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await commissionActionsService.approve(req, req.body.ids), 'Commissions approved')
  }),

  reverse: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await commissionActionsService.reverse(req, req.params.id, req.body.reason), 'Commission reversed')
  }),

  createPayout: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await commissionActionsService.createPayout(req, req.body), 'Payout recorded', 201)
  }),

  listPayouts: asyncHandler(async (req: Request, res: Response) => {
    const q = query<typeof listPayoutsSchema>(req)
    const { items, total } = await commissionActionsService.listPayouts(q, resolveResellerId(req, q.resellerId))
    sendPaginated(res, items, total, q.page, q.limit)
  }),

  recordSubscriptionEvent: asyncHandler(async (req: Request, res: Response) => {
    const result = await recordSubscriptionEvent(req.body, { source: 'ADMIN', req })
    sendSuccess(res, result, 'Subscription event recorded', 201)
  }),
}
