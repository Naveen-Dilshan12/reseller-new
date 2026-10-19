import type { Request } from 'express'
import { Prisma } from '@prisma/client'
import { ZodError, ZodIssueCode } from 'zod'
import { prisma } from '../../config/database'
import { conflict, notFoundError } from '../../middleware/error.middleware'
import { isPlatformRole } from '../../rbac/permissions'
import { encryptSecret } from '../../utils/crypto'
import { auditService } from '../audit-logs/audit.service'
import { statusKeepingLastCheck, toSafeConfig, trialCapability } from '../integrations/integration.service'
import {
  statusRuleMessage,
  trialRuleMessage,
  type CreateProductInput,
  type UpdateIntegrationInput,
  type UpdateProductInput,
} from './product.schema'

/** Everything a reseller may see about a product. Never add integration fields here. */
export const PUBLIC_PRODUCT_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  status: true,
  monthlyPrice: true,
  currency: true,
  trialAvailable: true,
  trialDays: true,
} satisfies Prisma.SaasProductSelect

const ADMIN_PRODUCT_SELECT = {
  ...PUBLIC_PRODUCT_SELECT,
  integrationStatus: true,
  createdAt: true,
  updatedAt: true,
  integration: { select: { provider: true, lastCheckedAt: true, lastCheckOk: true } },
  _count: { select: { resellerAccess: { where: { status: 'ACTIVE' } }, accounts: true } },
} satisfies Prisma.SaasProductSelect

/** Stored vs requested value; money is compared as a number, not by how it is written (5500.5 vs 5500.50). */
function sameValue(stored: unknown, requested: unknown): boolean {
  if (stored === null || stored === undefined || requested === null || requested === undefined) return stored === requested
  if (stored instanceof Prisma.Decimal || requested instanceof Prisma.Decimal) {
    return new Prisma.Decimal(stored as Prisma.Decimal.Value).equals(requested as Prisma.Decimal.Value)
  }
  return stored === requested
}

/** The requested fields whose value differs from what is stored. */
function changedFields(before: Record<string, unknown>, requested: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(requested).filter(([key, value]) => value !== undefined && !sameValue(before[key], value)))
}

/**
 * A product without a trial never keeps trial days. The schema can only check the request itself, so this checks it
 * against the stored product: `{ trialDays: 30 }` is refused (same 422 as the schema's rule) unless the product has,
 * or is being given, a trial. Days left over on a product without a trial are cleared by any update.
 */
function withConsistentTrial(before: { trialAvailable: boolean; trialDays: number | null }, input: UpdateProductInput): UpdateProductInput {
  const data = { ...input }
  if (data.trialAvailable ?? before.trialAvailable) return data
  if (data.trialDays) {
    throw new ZodError([{ code: ZodIssueCode.custom, path: trialRuleMessage.path, message: trialRuleMessage.message }])
  }
  if (before.trialDays !== null) data.trialDays = null
  return data
}

/**
 * Status is changed by Retire / Restore (product-lifecycle.service), never by a general edit: those record a reason, take an
 * impact snapshot and audit the move. A request that names the status the product already has is harmless (older forms
 * send the whole product); any other status is refused, not turned into a lifecycle action.
 */
function assertStatusUnchanged(before: { status: string }, requested: string | undefined) {
  if (requested !== undefined && requested !== before.status) {
    throw new ZodError([{ code: ZodIssueCode.custom, path: statusRuleMessage.path, message: statusRuleMessage.message }])
  }
}

export const productService = {
  /** Reseller users see only ACTIVE products they have ACTIVE access to. */
  async catalogue(req: Request) {
    const user = req.user!
    if (isPlatformRole(user.role)) {
      return prisma.saasProduct.findMany({
        select: { ...PUBLIC_PRODUCT_SELECT, integrationStatus: true },
        orderBy: { name: 'asc' },
      })
    }
    const products = await prisma.saasProduct.findMany({
      where: { status: 'ACTIVE', resellerAccess: { some: { resellerId: user.resellerId!, status: 'ACTIVE' } } },
      select: { ...PUBLIC_PRODUCT_SELECT, integrationStatus: true, integration: { select: { provider: true } } },
      orderBy: { name: 'asc' },
    })
    // Only the derived capability leaves the server, never integration details.
    return products.map(({ integrationStatus, integration, ...product }) => ({
      ...product,
      ...trialCapability({ ...product, integrationStatus, integration }),
    }))
  },

  list() {
    return prisma.saasProduct.findMany({ select: ADMIN_PRODUCT_SELECT, orderBy: { name: 'asc' } })
  },

  async get(id: string) {
    const product = await prisma.saasProduct.findUnique({
      where: { id },
      select: { ...ADMIN_PRODUCT_SELECT, integration: true },
    })
    if (!product) throw notFoundError('SaaS product')
    return { ...product, integration: toSafeConfig(product.integration, product.integrationStatus) }
  },

  async create(input: CreateProductInput, req: Request) {
    if (await prisma.saasProduct.findUnique({ where: { code: input.code }, select: { id: true } })) {
      throw conflict(`Product code ${input.code} already exists`)
    }
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.saasProduct.create({
        data: {
          ...input,
          integrationStatus: 'CONFIGURED',
          integration: { create: { provider: 'MANUAL', updatedById: req.user!.userId } },
        },
        select: { id: true, code: true },
      })
      await auditService.fromRequest(
        req,
        { action: 'SAAS_PRODUCT_CREATED', entityType: 'SaasProduct', entityId: created.id, metadata: { ...input } },
        tx,
      )
      return created
    })
    return this.get(product.id)
  },

  /**
   * `expectedUpdatedAt` (optional) is the product's `updatedAt` as the caller last saw it. If the product has been saved
   * since, the edit is refused with 409 instead of overwriting the newer data. The comparison is part of the UPDATE
   * itself, so two simultaneous edits of the same version cannot both succeed. Callers that omit it are not protected.
   *
   * `status` is not editable here (see `assertStatusUnchanged`): it is taken out of the data before anything is compared or
   * written. If a request repeats the current status, the write is also conditional on it, so a retire that lands in
   * between makes the edit fail (409) even for a caller that sent no version.
   */
  async update(id: string, request: UpdateProductInput, req: Request) {
    const { expectedUpdatedAt, status: requestedStatus, ...input } = request
    const before = await prisma.saasProduct.findUnique({ where: { id }, select: { ...PUBLIC_PRODUCT_SELECT, updatedAt: true } })
    if (!before) throw notFoundError('SaaS product')
    if (expectedUpdatedAt && expectedUpdatedAt.getTime() !== before.updatedAt.getTime()) {
      throw conflict('This product has been changed since you opened it. Reload it to see the latest version; your changes were not saved.')
    }
    assertStatusUnchanged(before, requestedStatus)

    // Only what really differs from the stored product is written and audited.
    const changed = changedFields(before, withConsistentTrial(before, input))
    if (Object.keys(changed).length === 0) return this.get(id)

    // New days are only valid while the trial is on: if someone switches it off between our read and this write,
    // fail rather than leave days on a product without a trial.
    const trialGuard = input.trialAvailable === undefined && typeof changed.trialDays === 'number' ? { trialAvailable: before.trialAvailable } : {}

    await prisma.$transaction(async (tx) => {
      const versionGuard = expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}
      const statusGuard = requestedStatus ? { status: before.status } : {}
      const result = await tx.saasProduct.updateMany({
        where: { id, ...trialGuard, ...versionGuard, ...statusGuard },
        data: changed as Prisma.SaasProductUpdateManyMutationInput,
      })
      if (result.count === 0) throw conflict('This product was changed by someone else. Reload it and try again.')
      await auditService.fromRequest(
        req,
        {
          action: 'SAAS_PRODUCT_UPDATED',
          entityType: 'SaasProduct',
          entityId: id,
          metadata: {
            changes: Object.fromEntries(
              Object.entries(changed).map(([k, v]) => [k, { from: String(before[k as keyof typeof before] ?? ''), to: String(v ?? '') }]),
            ),
          },
        },
        tx,
      )
    })
    return this.get(id)
  },

  async updateIntegration(productId: string, input: UpdateIntegrationInput, req: Request) {
    const product = await prisma.saasProduct.findUnique({ where: { id: productId }, select: { integration: true } })
    if (!product) throw notFoundError('SaaS product')
    const current = product.integration

    const next = {
      provider: input.provider,
      baseUrl: input.baseUrl === undefined ? (current?.baseUrl ?? null) : input.baseUrl,
      apiKeyEncrypted: input.clearCredentials
        ? null
        : input.apiKey
          ? encryptSecret(input.apiKey)
          : (current?.apiKeyEncrypted ?? null),
      signingSecretEncrypted: input.clearCredentials
        ? null
        : input.signingSecret
          ? encryptSecret(input.signingSecret)
          : (current?.signingSecretEncrypted ?? null),
    }
    const connectionChanged =
      !current ||
      current.provider !== next.provider ||
      current.baseUrl !== next.baseUrl ||
      Boolean(input.apiKey || input.signingSecret || input.clearCredentials)
    // The stored health check is kept only while the connection is unchanged; the status must agree with whatever is kept.
    const keptCheck = connectionChanged || !current ? null : { lastCheckedAt: current.lastCheckedAt, lastCheckOk: current.lastCheckOk }
    const integrationStatus = input.enabled ? statusKeepingLastCheck(next, keptCheck) : 'DISABLED'
    const checkReset = connectionChanged ? { lastCheckedAt: null, lastCheckOk: null, lastError: null } : {}

    const rotated = [input.apiKey && 'API key', input.signingSecret && 'signing secret'].filter(Boolean) as string[]
    await prisma.$transaction(async (tx) => {
      await tx.saasIntegrationConfig.upsert({
        where: { productId },
        create: { productId, ...next, updatedById: req.user!.userId },
        update: { ...next, ...checkReset, updatedById: req.user!.userId },
      })
      await tx.saasProduct.update({ where: { id: productId }, data: { integrationStatus } })
      await auditService.fromRequest(
        req,
        {
          action: 'INTEGRATION_CONFIG_UPDATED',
          entityType: 'SaasProduct',
          entityId: productId,
          metadata: {
            provider: next.provider,
            baseUrl: next.baseUrl,
            enabled: input.enabled,
            integrationStatus,
            credentialsUpdated: rotated,
            credentialsCleared: Boolean(input.clearCredentials),
          },
        },
        tx,
      )
    })
    return this.get(productId)
  },
}
