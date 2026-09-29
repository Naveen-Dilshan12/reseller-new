import { PartnerApiIntegration } from './partner-api.integration'

/** Hexalyte Supermarket POS. Uses the default partner API contract unchanged. */
export class SupermarketIntegration extends PartnerApiIntegration {
  readonly provider = 'SUPERMARKET'
}
