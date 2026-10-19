import type { CreateTrialInput } from '../saas-integration'
import { PartnerApiIntegration, str, type Json } from './partner-api.integration'

/**
 * Hexalyte Mobile Shop. Tenant statuses already match the normalised set
 * (TRIAL / ACTIVE / SUSPENDED / CANCELLED); trial payload mirrors its
 * `registerTenantSchema` field names.
 */
export class MobileShopIntegration extends PartnerApiIntegration {
  readonly provider = 'MOBILE_SHOP'

  protected trialPayload(input: CreateTrialInput): Json {
    return {
      idempotencyKey: input.idempotencyKey,
      externalRef: input.externalRef,
      resellerCode: input.resellerCode,
      shopName: input.businessName,
      ownerName: input.contactName,
      ownerEmail: input.contactEmail,
      phone: input.contactPhone,
      ...(input.password ? { password: input.password } : {}),
    }
  }

  protected tenantIdentity(data: Json) {
    return { externalTenantId: str(data.tenantId), externalAccountId: str(data.ownerUserId ?? data.userId) }
  }
}
