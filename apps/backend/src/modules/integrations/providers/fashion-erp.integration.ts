import type { CreateTrialInput } from '../saas-integration'
import { PartnerApiIntegration, str, type Json } from './partner-api.integration'

/**
 * HexaOne Clothing ERP (main ERP). Tenant statuses match the normalised set;
 * trial payload mirrors its `RegisterTenantDto` field names.
 */
export class FashionErpIntegration extends PartnerApiIntegration {
  readonly provider = 'FASHION_ERP'

  protected trialPayload(input: CreateTrialInput): Json {
    const [firstName, ...rest] = input.contactName.trim().split(/\s+/)
    return {
      idempotencyKey: input.idempotencyKey,
      externalRef: input.externalRef,
      resellerCode: input.resellerCode,
      companyName: input.businessName,
      adminFirstName: firstName,
      adminLastName: rest.join(' ') || firstName,
      adminEmail: input.contactEmail,
      phone: input.contactPhone,
      country: 'LK',
      currency: 'LKR',
    }
  }

  protected tenantIdentity(data: Json) {
    return { externalTenantId: str(data.tenantId), externalAccountId: str(data.adminUserId ?? data.userId) }
  }
}
