import type { Request } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { conflict, notFoundError } from '../../middleware/error.middleware'
import { isPlatformRole } from '../../rbac/permissions'
import { encryptSecret } from '../../utils/crypto'
import { auditService } from '../audit-logs/audit.service'
import { statusAfterConfigChange, toSafeConfig, trialCapability } from '../integrations/integration.service'
import type { CreateProductInput, UpdateIntegrationInput, UpdateProductInput } from './product.schema'

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
    return { ...product, integration: toSafeConfig(product.integration) }
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

  async update(id: string, input: UpdateProductInput, req: Request) {
    const before = await prisma.saasProduct.findUnique({ where: { id }, select: PUBLIC_PRODUCT_SELECT })
    if (!before) throw notFoundError('SaaS product')
    if (input.trialAvailable === false) input.trialDays = null

    await prisma.$transaction(async (tx) => {
      await tx.saasProduct.update({ where: { id }, data: input })
      await auditService.fromRequest(
        req,
        {
          action: 'SAAS_PRODUCT_UPDATED',
          entityType: 'SaasProduct',
          entityId: id,
          metadata: {
            changes: Object.fromEntries(
              Object.entries(input).map(([k, v]) => [k, { from: String(before[k as keyof typeof before] ?? ''), to: String(v ?? '') }]),
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
    const integrationStatus = input.enabled ? statusAfterConfigChange(next) : 'DISABLED'
    const connectionChanged =
      !current ||
      current.provider !== next.provider ||
      current.baseUrl !== next.baseUrl ||
      Boolean(input.apiKey || input.signingSecret || input.clearCredentials)
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
