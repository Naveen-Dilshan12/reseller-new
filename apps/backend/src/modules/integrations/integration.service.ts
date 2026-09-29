import type { Request } from 'express'
import type { IntegrationOperation, IntegrationStatus, SaasIntegrationConfig } from '@prisma/client'
import { prisma } from '../../config/database'
import { badRequest, notFoundError } from '../../middleware/error.middleware'
import { decryptSecret } from '../../utils/crypto'
import { auditService } from '../audit-logs/audit.service'
import { IntegrationError } from './integration-error'
import { integrationRegistry } from './integration-registry'
import type { SaasIntegration } from './saas-integration'

/** Admin view of a config. Secrets are reported only as present/absent. */
export function toSafeConfig(config: SaasIntegrationConfig | null) {
  if (!config) return null
  const provider = integrationRegistry.get(config.provider)
  return {
    provider: config.provider,
    providerLabel: provider?.label ?? config.provider,
    requiresCredentials: provider?.requiresCredentials ?? true,
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKeyEncrypted),
    hasSigningSecret: Boolean(config.signingSecretEncrypted),
    lastCheckedAt: config.lastCheckedAt,
    lastCheckOk: config.lastCheckOk,
    lastError: config.lastError,
    updatedAt: config.updatedAt,
  }
}

export function isConfigComplete(config: Pick<SaasIntegrationConfig, 'provider' | 'baseUrl' | 'apiKeyEncrypted' | 'signingSecretEncrypted'>) {
  const provider = integrationRegistry.get(config.provider)
  if (!provider) return false
  return !provider.requiresCredentials || Boolean(config.baseUrl && config.apiKeyEncrypted && config.signingSecretEncrypted)
}

/** Status after a config change; only a passing health check of a remote provider sets CONNECTED. */
export function statusAfterConfigChange(config: Parameters<typeof isConfigComplete>[0]): IntegrationStatus {
  return isConfigComplete(config) ? 'CONFIGURED' : 'NOT_CONFIGURED'
}

export interface TrialCapabilityInput {
  status: string
  trialAvailable: boolean
  integrationStatus: IntegrationStatus
  integration: { provider: string } | null
}

/**
 * Whether trials for a product can be created through the platform. Needs a
 * remote partner API: manual products have no SaaS trial API to call, and the
 * platform must not re-implement SaaS registration.
 */
export function trialCapability(p: TrialCapabilityInput): { canCreateTrial: boolean; reason: string | null } {
  if (p.status !== 'ACTIVE') return { canCreateTrial: false, reason: 'Product is not available' }
  if (!p.trialAvailable) return { canCreateTrial: false, reason: 'This product does not offer a free trial' }
  const provider = p.integration && integrationRegistry.get(p.integration.provider)
  if (!provider?.requiresCredentials || p.integrationStatus === 'NOT_CONFIGURED') {
    return { canCreateTrial: false, reason: 'Trial creation through the reseller platform is not available for this product yet' }
  }
  if (p.integrationStatus === 'DISABLED') {
    return { canCreateTrial: false, reason: 'Trial creation is temporarily unavailable' }
  }
  return { canCreateTrial: true, reason: null }
}

async function resolve(productId: string): Promise<{ integration: SaasIntegration; productCode: string }> {
  const product = await prisma.saasProduct.findUnique({
    where: { id: productId },
    select: { code: true, integrationStatus: true, integration: true },
  })
  if (!product) throw notFoundError('SaaS product')
  const config = product.integration
  if (product.integrationStatus === 'DISABLED') throw badRequest('Integration is disabled for this product')
  if (!config || !isConfigComplete(config)) throw badRequest('Integration is not configured for this product')

  const provider = integrationRegistry.get(config.provider)!
  const credentials = provider.requiresCredentials
    ? {
        baseUrl: config.baseUrl!,
        apiKey: decryptSecret(config.apiKeyEncrypted!),
        signingSecret: decryptSecret(config.signingSecretEncrypted!),
      }
    : null
  return { integration: provider.create(credentials), productCode: product.code }
}

/** Runs one remote operation and records it in the integration log (never the payload). */
async function run<T>(
  productId: string,
  operation: IntegrationOperation,
  entityId: string | null,
  fn: (integration: SaasIntegration) => Promise<T>,
): Promise<T> {
  const { integration } = await resolve(productId)
  const started = Date.now()
  try {
    const result = await fn(integration)
    await log(productId, operation, entityId, true, integration.lastHttpStatus, started)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await log(productId, operation, entityId, false, integration.lastHttpStatus, started, message)
    if (err instanceof IntegrationError) throw err
    throw new IntegrationError('SaaS integration failed')
  }
}

function log(
  productId: string,
  operation: IntegrationOperation,
  entityId: string | null,
  success: boolean,
  httpStatus: number | undefined,
  started: number,
  errorMessage?: string,
) {
  return prisma.integrationLog.create({
    data: { productId, operation, entityId, success, httpStatus, durationMs: Date.now() - started, errorMessage },
  })
}

export const integrationService = {
  run,

  async healthCheck(productId: string, req: Request) {
    let ok = false
    let remote = true
    let message: string | undefined
    try {
      const result = await run(productId, 'HEALTH_CHECK', null, (i) => {
        remote = i.supportsRemoteQueries
        return i.healthCheck()
      })
      ok = result.ok
      message = result.message
    } catch (err) {
      // Configuration problems (not configured, disabled) are reported as-is without flagging ERROR.
      if (!(err instanceof IntegrationError)) throw err
      message = err.message
    }

    const product = await prisma.saasProduct.update({
      where: { id: productId },
      data: {
        integrationStatus: ok ? (remote ? 'CONNECTED' : 'CONFIGURED') : 'ERROR',
        integration: { update: { lastCheckedAt: new Date(), lastCheckOk: ok, lastError: ok ? null : (message ?? null) } },
      },
      select: { integrationStatus: true, integration: true },
    })
    await auditService.fromRequest(req, {
      action: 'INTEGRATION_HEALTH_CHECKED',
      entityType: 'SaasProduct',
      entityId: productId,
      metadata: { ok, message: message ?? null },
    })
    return { ok, message: message ?? null, integrationStatus: product.integrationStatus, config: toSafeConfig(product.integration) }
  },

  /** Reads the tenant's live status from the SaaS for display. Nothing is stored. */
  async liveAccountStatus(account: { id: string; productId: string; externalTenantId: string | null }) {
    if (!account.externalTenantId) return { available: false as const, reason: 'Tenant not provisioned yet' }
    const product = await prisma.saasProduct.findUnique({
      where: { id: account.productId },
      select: { integrationStatus: true, integration: { select: { provider: true } } },
    })
    const provider = product?.integration && integrationRegistry.get(product.integration.provider)
    if (!provider?.requiresCredentials || product!.integrationStatus === 'DISABLED' || product!.integrationStatus === 'NOT_CONFIGURED') {
      return { available: false as const, reason: 'Live status is not available for this product' }
    }
    const status = await run(account.productId, 'GET_ACCOUNT_STATUS', account.id, (i) =>
      i.getAccountStatus(account.externalTenantId!),
    )
    return { available: true as const, fetchedAt: new Date().toISOString(), status }
  },
}
