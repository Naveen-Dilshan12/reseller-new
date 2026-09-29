import type { SaasIntegration } from '../saas-integration'

/**
 * For SaaS products without a partner API yet. Requests stay PENDING and a
 * platform admin records the outcome after acting in the SaaS admin console.
 */
export class ManualIntegration implements SaasIntegration {
  readonly provider = 'MANUAL'
  readonly supportsRemoteQueries = false

  async createTrial() {
    return { outcome: 'PENDING' as const, reference: null }
  }

  async findTenantByReference() {
    return null
  }

  async getAccountStatus() {
    return null
  }

  async activateSubscription() {
    return { status: 'PENDING' as const, requestId: null }
  }

  async getActivationStatus() {
    return null
  }

  async healthCheck() {
    return { ok: true, message: 'Manual fulfilment; no remote API' }
  }
}
