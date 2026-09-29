import type { ActivateSubscriptionInput, CreateTrialInput, ExternalTenantStatus } from '../saas-integration'
import { PartnerApiIntegration, str, type Json } from './partner-api.integration'

/**
 * Hexalyte Salon. Uses snake_case payloads and lowercase statuses; a trial is
 * `status: active` with `plan: trial`, and subscriptions can be `past_due`.
 */
export class SalonIntegration extends PartnerApiIntegration {
  readonly provider = 'SALON'

  protected trialPayload(input: CreateTrialInput): Json {
    return {
      idempotency_key: input.idempotencyKey,
      external_ref: input.externalRef,
      reseller_code: input.resellerCode,
      name: input.businessName,
      owner_name: input.contactName,
      owner_email: input.contactEmail,
      owner_phone: input.contactPhone,
      plan: 'trial',
    }
  }

  protected activationPayload(input: ActivateSubscriptionInput): Json {
    return {
      idempotency_key: input.idempotencyKey,
      external_ref: input.externalRef,
      period_month: input.periodMonth,
      amount: input.amount,
      currency: input.currency,
      payment_method: 'bank_transfer',
      payment_reference: input.paymentReference,
      payment_date: input.paymentDate,
      verified_by: input.verifiedBy,
    }
  }

  protected tenantIdentity(data: Json) {
    return {
      externalTenantId: str(data.tenant_id ?? data.tenantId),
      externalAccountId: str(data.owner_user_id ?? data.user_id),
    }
  }

  protected mapStatus(data: Json): ExternalTenantStatus {
    const status = String(data.status ?? '').toLowerCase()
    const subscription = String(data.subscription_status ?? '').toLowerCase()
    if (status === 'cancelled' || subscription === 'cancelled') return 'CANCELLED'
    if (status === 'suspended' || subscription === 'past_due') return 'SUSPENDED'
    if (status === 'active') {
      return String(data.plan ?? '').toLowerCase() === 'trial' || subscription === 'trialing' ? 'TRIAL' : 'ACTIVE'
    }
    return 'UNKNOWN'
  }

  protected accountStatus(data: Json, externalTenantId: string) {
    return {
      ...super.accountStatus(data, externalTenantId),
      trialEndsAt: str(data.trial_ends_at),
      subscriptionEndsAt: str(data.current_period_end),
    }
  }
}
