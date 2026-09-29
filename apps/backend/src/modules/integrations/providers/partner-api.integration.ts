import { env } from '../../../config/env'
import { IntegrationError } from '../integration-error'
import { signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../signing'
import type {
  AccountStatus,
  ActivationResult,
  CreateTrialInput,
  CreateTrialResult,
  ExternalTenantStatus,
  HealthResult,
  IntegrationCredentials,
  ActivateSubscriptionInput,
  SaasIntegration,
} from '../saas-integration'

export type Json = Record<string, unknown>

const PREFIX = '/partner/v1'
const MAX_RESPONSE_CHARS = 1_000_000
const NORMALISED: readonly ExternalTenantStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED']

export function str(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : String(value)
}

/**
 * Base for SaaS products exposing the Hexalyte partner API under `/partner/v1`
 * (bearer API key + HMAC signature). Subclasses override the mapping hooks
 * where a product's payloads or status vocabulary differ from the defaults.
 */
export abstract class PartnerApiIntegration implements SaasIntegration {
  abstract readonly provider: string
  readonly supportsRemoteQueries = true
  lastHttpStatus: number | undefined

  constructor(private readonly credentials: IntegrationCredentials) {}

  // ─── Mapping hooks ─────────────────────────────────────────────────────────

  protected activationPayload(input: ActivateSubscriptionInput): Json {
    const { externalTenantId: _tenant, ...body } = input
    return body
  }

  protected trialPayload(input: CreateTrialInput): Json {
    return { ...input }
  }

  protected tenantIdentity(data: Json): { externalTenantId: string | null; externalAccountId: string | null } {
    return { externalTenantId: str(data.tenantId), externalAccountId: str(data.accountId ?? data.ownerUserId) }
  }

  protected mapStatus(data: Json): ExternalTenantStatus {
    const raw = String(data.status ?? '').toUpperCase() as ExternalTenantStatus
    return NORMALISED.includes(raw) ? raw : 'UNKNOWN'
  }

  protected accountStatus(data: Json, externalTenantId: string): AccountStatus {
    return {
      externalTenantId,
      externalAccountId: this.tenantIdentity(data).externalAccountId,
      status: this.mapStatus(data),
      rawStatus: str(data.status),
      plan: str(data.plan),
      trialEndsAt: str(data.trialEndsAt),
      subscriptionEndsAt: str(data.subscriptionEndsAt),
    }
  }

  // ─── Operations ────────────────────────────────────────────────────────────

  async createTrial(input: CreateTrialInput): Promise<CreateTrialResult> {
    const { status, data } = await this.request('POST', '/tenants', this.trialPayload(input), input.idempotencyKey)
    const identity = this.tenantIdentity(data)
    if (status === 202 || !identity.externalTenantId) {
      return { outcome: 'PENDING', reference: str(data.reference) }
    }
    const snapshot = this.accountStatus(data, identity.externalTenantId)
    return {
      outcome: 'PROVISIONED',
      externalTenantId: identity.externalTenantId,
      externalAccountId: identity.externalAccountId,
      status: snapshot.status,
      trialEndsAt: snapshot.trialEndsAt,
    }
  }

  async findTenantByReference(externalRef: string): Promise<AccountStatus | null> {
    try {
      const { data } = await this.request('GET', `/tenants/by-reference/${encodeURIComponent(externalRef)}`)
      const { externalTenantId } = this.tenantIdentity(data)
      return externalTenantId ? this.accountStatus(data, externalTenantId) : null
    } catch (err) {
      if (err instanceof IntegrationError && err.httpStatus === 404) return null
      throw err
    }
  }

  async getAccountStatus(externalTenantId: string): Promise<AccountStatus | null> {
    const { data } = await this.request('GET', `/tenants/${encodeURIComponent(externalTenantId)}/status`)
    return this.accountStatus(data, externalTenantId)
  }

  async activateSubscription(input: ActivateSubscriptionInput): Promise<ActivationResult> {
    const path = `/tenants/${encodeURIComponent(input.externalTenantId)}/subscription-activations`
    const { status, data } = await this.request('POST', path, this.activationPayload(input), input.idempotencyKey)
    const result = normaliseActivation(data)
    return status === 202 && result.status === 'ACTIVATED' ? { ...result, status: 'PENDING' } : result
  }

  async getActivationStatus(requestId: string): Promise<ActivationResult | null> {
    const { data } = await this.request('GET', `/subscription-activations/${encodeURIComponent(requestId)}`)
    return normaliseActivation(data)
  }

  async healthCheck(): Promise<HealthResult> {
    await this.request('GET', '/health')
    return { ok: true }
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string) {
    const fullPath = `${PREFIX}${path}`
    const payload = body === undefined ? '' : JSON.stringify(body)
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.credentials.apiKey}`,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signRequest(this.credentials.signingSecret, method, fullPath, payload, timestamp),
    }
    if (payload) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    this.lastHttpStatus = undefined
    let res: Response
    try {
      res = await fetch(`${this.credentials.baseUrl.replace(/\/+$/, '')}${fullPath}`, {
        method,
        headers,
        body: payload || undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(env.INTEGRATION_TIMEOUT_MS),
      })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable'
      throw new IntegrationError(`SaaS API ${reason}`)
    }
    this.lastHttpStatus = res.status

    if (Number(res.headers.get('content-length') ?? 0) > MAX_RESPONSE_CHARS) {
      throw new IntegrationError('SaaS API response too large', res.status)
    }
    const text = await res.text().catch(() => '')
    if (text.length > MAX_RESPONSE_CHARS) throw new IntegrationError('SaaS API response too large', res.status)
    let json: Json | null = null
    try {
      json = text ? (JSON.parse(text) as Json) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      // SaaS error text can echo internal details; keep it short and never forward headers.
      const message = typeof json?.message === 'string' ? json.message.slice(0, 200) : `HTTP ${res.status}`
      throw new IntegrationError(`SaaS API error: ${message}`, res.status)
    }
    // Hexalyte SaaS APIs wrap payloads as { success, data, message }.
    const data = (json && 'data' in json ? json.data : json) ?? {}
    return { status: res.status, data: data as Json }
  }
}

const ACTIVATED = new Set(['ACTIVATED', 'ACTIVE', 'COMPLETED', 'APPROVED', 'PAID'])
const FAILED = new Set(['FAILED', 'REJECTED', 'ERROR'])

function normaliseActivation(data: Json): ActivationResult {
  const raw = String(data.status ?? 'PENDING').toUpperCase()
  return {
    requestId: str(data.requestId ?? data.request_id),
    status: ACTIVATED.has(raw) ? 'ACTIVATED' : FAILED.has(raw) ? 'FAILED' : 'PENDING',
    subscriptionReference: str(data.subscriptionReference ?? data.subscription_reference ?? data.invoiceId ?? data.invoice_id),
    note: str(data.note ?? data.message),
  }
}
