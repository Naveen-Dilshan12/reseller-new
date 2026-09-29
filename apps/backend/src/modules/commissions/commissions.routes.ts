import { Router } from 'express'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { commissionsController as c } from './commissions.controller'
import {
  approveCommissionsSchema,
  byCustomerSchema,
  createPayoutSchema,
  listCommissionsSchema,
  listPayoutsSchema,
  monthlyReportSchema,
  recordSubscriptionEventSchema,
  resellerQuerySchema,
  reverseCommissionSchema,
} from './commission.schema'

/** `/commissions`: resellers see their own data; platform staff can filter by resellerId. */
export const commissionsRouter = Router()
commissionsRouter.use(authenticate)

commissionsRouter.get('/levels', c.levels)
commissionsRouter.get('/summary', requirePermission('commissions:read'), validate(resellerQuerySchema, 'query'), c.summary)
commissionsRouter.get('/', requirePermission('commissions:read'), validate(listCommissionsSchema, 'query'), c.list)
commissionsRouter.get('/by-customer', requirePermission('commissions:read'), validate(byCustomerSchema, 'query'), c.byCustomer)
commissionsRouter.get(
  '/monthly-report',
  requirePermission('commissions:read'),
  validate(monthlyReportSchema, 'query'),
  c.monthlyReport,
)
commissionsRouter.get('/payouts', requirePermission('commissions:read'), validate(listPayoutsSchema, 'query'), c.listPayouts)

commissionsRouter.post('/approve', requirePermission('commissions:manage'), validate(approveCommissionsSchema), c.approve)
commissionsRouter.post('/payouts', requirePermission('commissions:manage'), validate(createPayoutSchema), c.createPayout)
commissionsRouter.post('/:id/reverse', requirePermission('commissions:manage'), validate(reverseCommissionSchema), c.reverse)

/** `/subscription-events`: verified SaaS subscription outcomes that drive commissions. */
export const subscriptionEventsRouter = Router()
subscriptionEventsRouter.use(authenticate)
subscriptionEventsRouter.post(
  '/',
  requirePermission('subscriptions:record'),
  validate(recordSubscriptionEventSchema),
  c.recordSubscriptionEvent,
)
