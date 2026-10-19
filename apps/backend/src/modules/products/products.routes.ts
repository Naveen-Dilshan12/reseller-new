import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/database'
import { authenticate, requirePermission } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/async-handler'
import { toSkipTake } from '../../utils/pagination'
import { sendPaginated, sendSuccess } from '../../utils/response'
import { integrationRegistry } from '../integrations/integration-registry'
import { integrationService } from '../integrations/integration.service'
import {
  comingSoonProductSchema,
  createProductSchema,
  integrationLogsSchema,
  launchProductSchema,
  restoreProductSchema,
  retireProductSchema,
  setAccessSchema,
  updateIntegrationSchema,
  updateProductSchema,
} from './product.schema'
import { productLifecycleService } from './product-lifecycle.service'
import { productService } from './product.service'
import { resellerAccessService } from './reseller-access.service'

/** Catalogue for any signed-in user; resellers only see products they can sell. */
export const productsRouter = Router()
productsRouter.get(
  '/',
  authenticate,
  requirePermission('products:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await productService.catalogue(req))),
)

export const adminProductsRouter = Router()
adminProductsRouter.use(authenticate)

adminProductsRouter.get(
  '/providers',
  requirePermission('integrations:read'),
  asyncHandler(async (_req, res) => sendSuccess(res, integrationRegistry.list())),
)

adminProductsRouter.get(
  '/',
  requirePermission('products:manage'),
  asyncHandler(async (_req, res) => sendSuccess(res, await productService.list())),
)

adminProductsRouter.post(
  '/',
  requirePermission('products:manage'),
  validate(createProductSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await productService.create(req.body, req), 'Product created', 201)),
)

adminProductsRouter.get(
  '/:id',
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => sendSuccess(res, await productService.get(req.params.id))),
)

adminProductsRouter.patch(
  '/:id',
  requirePermission('products:manage'),
  validate(updateProductSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await productService.update(req.params.id, req.body, req), 'Product updated')),
)

/** Lifecycle: counts of what retiring / restoring touches, shown before the admin confirms. */
adminProductsRouter.get(
  '/:id/impact',
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => sendSuccess(res, await productLifecycleService.impact(req.params.id))),
)

adminProductsRouter.post(
  '/:id/retire',
  requirePermission('products:manage'),
  validate(retireProductSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await productLifecycleService.retire(req.params.id, req.body, req), 'Product retired')),
)

adminProductsRouter.post(
  '/:id/restore',
  requirePermission('products:manage'),
  validate(restoreProductSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await productLifecycleService.restore(req.params.id, req.body, req), 'Product restored')),
)

/** Coming soon: ACTIVE | INACTIVE → COMING_SOON (reason required), and launch: COMING_SOON → ACTIVE (note optional). */
adminProductsRouter.post(
  '/:id/coming-soon',
  requirePermission('products:manage'),
  validate(comingSoonProductSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await productLifecycleService.comingSoon(req.params.id, req.body, req), 'Product set to coming soon')),
)

adminProductsRouter.post(
  '/:id/launch',
  requirePermission('products:manage'),
  validate(launchProductSchema),
  asyncHandler(async (req, res) => sendSuccess(res, await productLifecycleService.launch(req.params.id, req.body, req), 'Product launched')),
)

/** Read-only review of approved resellers without access; it lists reseller names, so it also needs resellers:read. */
adminProductsRouter.get(
  '/:id/resellers-without-access',
  requirePermission('products:manage', 'resellers:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await productLifecycleService.resellersWithoutAccess(req.params.id))),
)

adminProductsRouter.put(
  '/:id/integration',
  requirePermission('integrations:manage'),
  validate(updateIntegrationSchema),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await productService.updateIntegration(req.params.id, req.body, req), 'Integration saved'),
  ),
)

adminProductsRouter.post(
  '/:id/integration/test',
  requirePermission('integrations:manage'),
  asyncHandler(async (req, res) => {
    const result = await integrationService.healthCheck(req.params.id, req)
    sendSuccess(res, result, result.ok ? 'Connection OK' : 'Connection failed')
  }),
)

adminProductsRouter.get(
  '/:id/integration/logs',
  requirePermission('integrations:read'),
  validate(integrationLogsSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof integrationLogsSchema>
    const where = { productId: req.params.id, ...(q.success ? { success: q.success === 'true' } : {}) }
    const [items, total] = await Promise.all([
      prisma.integrationLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
      prisma.integrationLog.count({ where }),
    ])
    sendPaginated(res, items, total, q.page, q.limit)
  }),
)

/** Mounted at /admin/resellers/:resellerId/product-access */
export const resellerAccessRouter = Router({ mergeParams: true })
resellerAccessRouter.use(authenticate)

resellerAccessRouter.get(
  '/',
  requirePermission('resellers:read'),
  asyncHandler(async (req, res) => sendSuccess(res, await resellerAccessService.list(req.params.resellerId))),
)

resellerAccessRouter.put(
  '/:productId',
  requirePermission('resellers:manage'),
  validate(setAccessSchema),
  asyncHandler(async (req, res) => {
    const access = await resellerAccessService.set(req.params.resellerId, req.params.productId, req.body, req)
    sendSuccess(res, access, 'Access updated')
  }),
)
