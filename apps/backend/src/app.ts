import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import compression from 'compression'

import { env, corsOrigins } from './config/env'
import { globalLimiter } from './config/rate-limit'
import { prisma } from './config/database'
import { CorsOriginError, errorHandler, notFound } from './middleware/error.middleware'

import authRoutes from './modules/auth/auth.routes'
import { applicationsRouter, registrationRouter, resellersAdminRouter } from './modules/resellers/resellers.routes'
import settingsRoutes from './modules/settings/settings.routes'
import bankSlipsRoutes from './modules/activations/bank-slips.routes'
import { commissionsRouter, subscriptionEventsRouter } from './modules/commissions/commissions.routes'
import { customerAccountsRouter, customersRouter } from './modules/customer-accounts/customer-accounts.routes'
import { adminProductsRouter, productsRouter, resellerAccessRouter } from './modules/products/products.routes'
import trialsRoutes from './modules/trials/trials.routes'
import activationsRoutes from './modules/activations/activations.routes'
import notificationsRoutes from './modules/notifications/notifications.routes'
import dashboardRoutes from './modules/dashboard/dashboard.routes'
import auditLogsRoutes from './modules/audit-logs/audit-logs.routes'

const app = express()

app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(helmet())
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || corsOrigins.includes(origin)) return callback(null, true)
      callback(new CorsOriginError(origin))
    },
    credentials: true,
  }),
)
app.use(compression())
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'))
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      ;(req as express.Request & { rawBody?: Buffer }).rawBody = buf
    },
  }),
)

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok' })
  } catch {
    res.status(503).json({ status: 'degraded' })
  }
})

const api = express.Router()
api.use(globalLimiter)
api.use((_req, res, next) => {
  // Responses contain personal and banking data; never cache them.
  res.set('Cache-Control', 'no-store')
  next()
})

api.use('/auth', authRoutes)
api.use('/reseller-registration', registrationRouter)
api.use('/admin/reseller-applications', applicationsRouter)
api.use('/admin/resellers', resellersAdminRouter)
api.use('/admin/settings', settingsRoutes)
api.use('/bank-slips', bankSlipsRoutes)
api.use('/products', productsRouter)
api.use('/admin/saas-products', adminProductsRouter)
api.use('/admin/resellers/:resellerId/product-access', resellerAccessRouter)
api.use('/customers', customersRouter)
api.use('/trials', trialsRoutes)
api.use('/activation-requests', activationsRoutes)
api.use('/customer-accounts', customerAccountsRouter)
api.use('/subscription-events', subscriptionEventsRouter)
api.use('/commissions', commissionsRouter)
api.use('/dashboard', dashboardRoutes)
api.use('/notifications', notificationsRoutes)
api.use('/audit-logs', auditLogsRoutes)

app.use(`/${env.API_PREFIX}`, api)

app.use(notFound)
app.use(errorHandler)

export default app
