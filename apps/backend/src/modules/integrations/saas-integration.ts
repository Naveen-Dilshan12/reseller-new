/**
 * Contract between the reseller platform and one SaaS product.
 *
 * Implementations only forward requests and translate responses into this
 * shape. All trial, subscription and payment rules stay inside the SaaS, and
 * nothing returned here is persisted beyond the tenant/account identifiers.
 */

/** Tenant status normalised across products. */
export type ExternalTenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'UNKNOWN'

/**
 * Trial-only by design: there is no plan field, so a reseller can never
 * request a paid subscription through this call.
 */
export interface CreateTrialInput {
  idempotencyKey: string
  /** Platform CustomerAccount id. The SaaS must return the existing tenant for a repeated externalRef. */
  externalRef: string
  resellerCode: string
  /** Owner details are forwarded to the SaaS once and not stored by the platform. */
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
  password?: string
}

export interface TenantIdentity {
  externalTenantId: string
  externalAccountId?: string | null
}

export type CreateTrialResult =
  | ({ outcome: 'PROVISIONED'; status: ExternalTenantStatus; trialEndsAt?: string | null } & TenantIdentity)
  /** SaaS accepted the request but provisions asynchronously or manually. */
  | { outcome: 'PENDING'; reference?: string | null }

/** Live status read from the SaaS on demand; never stored. */
export interface AccountStatus extends TenantIdentity {
  status: ExternalTenantStatus
  rawStatus?: string | null
  plan?: string | null
  trialEndsAt?: string | null
  subscriptionEndsAt?: string | null
}

/**
 * Sent only after Hexalyte staff verified the bank transfer. The SaaS applies
 * it through its own subscription flow (mark invoice paid, extend period, …).
 * The bank slip itself stays in the platform's private storage.
 */
export interface ActivateSubscriptionInput {
  idempotencyKey: string
  /** Platform ActivationRequest reference (e.g. AR-7K2F9Q). The SaaS must dedupe on it. */
  externalRef: string
  externalTenantId: string
  /** Billing month the payment covers (YYYY-MM). */
  periodMonth: string
  amount: string
  currency: string
  paymentMethod: 'BANK_TRANSFER'
  paymentReference: string
  paymentDate: string
  verifiedBy: string
}

export type ActivationOutcome = 'ACTIVATED' | 'PENDING' | 'FAILED'

export interface ActivationResult {
  requestId?: string | null
  status: ActivationOutcome
  /** Subscription / invoice reference inside the SaaS. */
  subscriptionReference?: string | null
  note?: string | null
}

export interface HealthResult {
  ok: boolean
  message?: string
}

export interface SaasIntegration {
  /** Registry key of this implementation, e.g. `MOBILE_SHOP`. */
  readonly provider: string
  /** `false` when the SaaS cannot be queried and an admin must record outcomes. */
  readonly supportsRemoteQueries: boolean
  /** HTTP status of the most recent remote call, used for integration logs. */
  readonly lastHttpStatus?: number
  createTrial(input: CreateTrialInput): Promise<CreateTrialResult>
  /** Finds a tenant created for `externalRef`; used to recover interrupted or asynchronous trials. */
  findTenantByReference(externalRef: string): Promise<AccountStatus | null>
  getAccountStatus(externalTenantId: string): Promise<AccountStatus | null>
  activateSubscription(input: ActivateSubscriptionInput): Promise<ActivationResult>
  getActivationStatus(requestId: string): Promise<ActivationResult | null>
  healthCheck(): Promise<HealthResult>
}

/** Decrypted connection settings handed to an implementation. Server-side only. */
export interface IntegrationCredentials {
  baseUrl: string
  apiKey: string
  signingSecret: string
}
