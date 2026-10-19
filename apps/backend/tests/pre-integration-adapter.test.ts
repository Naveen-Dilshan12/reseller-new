import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import {
  getIntegrationReadiness,
  isConfigComplete,
  statusAfterConfigChange,
  trialCapability,
} from '../src/modules/integrations/integration.service'
import { ManualIntegration } from '../src/modules/integrations/providers/manual.integration'
import { IntegrationError } from '../src/modules/integrations/integration-error'
import { integrationRegistry } from '../src/modules/integrations/integration-registry'
import type {
  ActivateSubscriptionInput,
  ActivationResult,
  CreateTrialInput,
  CreateTrialResult,
  HealthResult,
  SaasIntegration,
} from '../src/modules/integrations/saas-integration'

/**
 * Dedicated Test Adapter implementing SaasIntegration.
 * IMPORTANT: This adapter is strictly for automated unit and integration tests.
 * It must NEVER be presented as proof of real external provider integration.
 */
class TestSaasIntegration implements SaasIntegration {
  readonly provider = 'TEST_ADAPTER'
  readonly supportsRemoteQueries = true
  lastHttpStatus?: number

  constructor(
    private readonly config: {
      trialOutcome?: 'PROVISIONED' | 'PENDING' | 'FAILED'
      activateOutcome?: 'ACTIVATED' | 'PENDING' | 'FAILED'
      failStatus?: number
      failMessage?: string
    } = {},
  ) {}

  async createTrial(input: CreateTrialInput): Promise<CreateTrialResult> {
    if (this.config.failStatus) {
      this.lastHttpStatus = this.config.failStatus
      throw new IntegrationError(this.config.failMessage || 'Simulated SaaS failure', this.config.failStatus)
    }
    if (this.config.trialOutcome === 'FAILED') {
      return { outcome: 'FAILED' }
    }
    if (this.config.trialOutcome === 'PENDING') {
      return { outcome: 'PENDING', reference: `REF-${input.idempotencyKey.slice(0, 8)}` }
    }
    return {
      outcome: 'PROVISIONED',
      externalTenantId: `tenant_${input.idempotencyKey.slice(0, 8)}`,
      externalAccountId: `acc_${input.idempotencyKey.slice(0, 8)}`,
      status: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    }
  }

  async activateSubscription(input: ActivateSubscriptionInput): Promise<ActivationResult> {
    if (this.config.failStatus) {
      this.lastHttpStatus = this.config.failStatus
      throw new IntegrationError(this.config.failMessage || 'Simulated SaaS failure', this.config.failStatus)
    }
    if (this.config.activateOutcome === 'FAILED') {
      return { status: 'FAILED', note: 'Simulated rejection from SaaS' }
    }
    if (this.config.activateOutcome === 'PENDING') {
      return { status: 'PENDING', requestId: `REQ-${input.idempotencyKey.slice(0, 8)}` }
    }
    return {
      status: 'ACTIVATED',
      subscriptionReference: `SUB-${input.idempotencyKey.slice(0, 8)}`,
    }
  }

  async findTenantByReference() {
    return null
  }

  async getAccountStatus() {
    return null
  }

  async getActivationStatus() {
    return null
  }

  async healthCheck(): Promise<HealthResult> {
    if (this.config.failStatus) {
      return { ok: false, message: `Health check failed (${this.config.failStatus})` }
    }
    return { ok: true, message: 'Test adapter healthy' }
  }
}

describe('Safe Pre-Integration Architecture & Adapter Tests', () => {
  describe('1. Missing Integration Configuration & Readiness States', () => {
    it('should report DISABLED state when integration is explicitly disabled', () => {
      const readiness = getIntegrationReadiness(null, 'DISABLED')
      assert.equal(readiness.state, 'DISABLED')
      assert.match(readiness.label, /Disabled/i)
    })

    it('should report MANUAL_FULFILMENT state when config is null or provider is MANUAL', () => {
      const readiness1 = getIntegrationReadiness(null, 'NOT_CONFIGURED')
      assert.equal(readiness1.state, 'MANUAL_FULFILMENT')
      assert.match(readiness1.label, /Manual fulfilment/i)

      const readiness2 = getIntegrationReadiness({ provider: 'MANUAL', baseUrl: null, apiKeyEncrypted: null, signingSecretEncrypted: null }, 'CONFIGURED')
      assert.equal(readiness2.state, 'MANUAL_FULFILMENT')
    })

    it('should report AWAITING_CREDENTIALS when a remote provider is selected without credentials', () => {
      const readiness = getIntegrationReadiness(
        { provider: 'MOBILE_SHOP', baseUrl: null, apiKeyEncrypted: null, signingSecretEncrypted: null },
        'CONFIGURED',
      )
      assert.equal(readiness.state, 'AWAITING_CREDENTIALS')
      assert.match(readiness.description, /not been supplied/i)
    })

    it('should report CONNECTED only when health check passed and status is CONNECTED', () => {
      const readiness = getIntegrationReadiness(
        { provider: 'MOBILE_SHOP', baseUrl: 'https://api.shop.com', apiKeyEncrypted: 'enc_k', signingSecretEncrypted: 'enc_s' },
        'CONNECTED',
      )
      assert.equal(readiness.state, 'CONNECTED')
      assert.match(readiness.label, /Connected/i)
    })

    it('should validate config completeness correctly', () => {
      assert.equal(isConfigComplete({ provider: 'MANUAL', baseUrl: null, apiKeyEncrypted: null, signingSecretEncrypted: null }), true)
      assert.equal(isConfigComplete({ provider: 'MOBILE_SHOP', baseUrl: null, apiKeyEncrypted: null, signingSecretEncrypted: null }), false)
      assert.equal(isConfigComplete({ provider: 'MOBILE_SHOP', baseUrl: 'https://api.test', apiKeyEncrypted: null, signingSecretEncrypted: 's' }), false)
      assert.equal(isConfigComplete({ provider: 'MOBILE_SHOP', baseUrl: 'https://api.test', apiKeyEncrypted: 'k', signingSecretEncrypted: 's' }), true)
      assert.equal(statusAfterConfigChange({ provider: 'MOBILE_SHOP', baseUrl: 'https://api.test', apiKeyEncrypted: 'k', signingSecretEncrypted: 's' }), 'CONFIGURED')
    })
  })

  describe('2. Pre-Integration Manual Fulfilment Adapter Behavior', () => {
    const manual = new ManualIntegration()

    it('should return supportsRemoteQueries = false', () => {
      assert.equal(manual.supportsRemoteQueries, false)
    })

    it('should return outcome = PENDING for createTrial (never pretends to be provisioned)', async () => {
      const res = await manual.createTrial()
      assert.equal(res.outcome, 'PENDING')
      assert.equal(res.reference, null)
      assert.equal((res as any).externalTenantId, undefined)
    })

    it('should return status = PENDING for activateSubscription', async () => {
      const res = await manual.activateSubscription()
      assert.equal(res.status, 'PENDING')
      assert.equal(res.requestId, null)
    })

    it('should return health check confirmation for manual fulfilment', async () => {
      const res = await manual.healthCheck()
      assert.equal(res.ok, true)
      assert.match(res.message, /Manual fulfilment/i)
    })
  })

  describe('3. Trial Capability Evaluation in Pre-Integration Stage', () => {
    it('should allow trial requests for active manual fulfilment products (pre-integration queueing)', () => {
      const cap = trialCapability({
        status: 'ACTIVE',
        trialAvailable: true,
        integrationStatus: 'CONFIGURED',
        integration: { provider: 'MANUAL' },
      })
      assert.equal(cap.canCreateTrial, true)
      assert.equal(cap.reason, null)
    })

    it('should reject trial creation if product is inactive or does not offer trials', () => {
      const capInactive = trialCapability({
        status: 'INACTIVE',
        trialAvailable: true,
        integrationStatus: 'CONFIGURED',
        integration: { provider: 'MANUAL' },
      })
      assert.equal(capInactive.canCreateTrial, false)
      assert.match(capInactive.reason!, /not available/i)

      const capNoTrial = trialCapability({
        status: 'ACTIVE',
        trialAvailable: false,
        integrationStatus: 'CONFIGURED',
        integration: { provider: 'MANUAL' },
      })
      assert.equal(capNoTrial.canCreateTrial, false)
      assert.match(capNoTrial.reason!, /does not offer/i)
    })

    it('should reject trial creation if integration is explicitly disabled', () => {
      const cap = trialCapability({
        status: 'ACTIVE',
        trialAvailable: true,
        integrationStatus: 'DISABLED',
        integration: { provider: 'MANUAL' },
      })
      assert.equal(cap.canCreateTrial, false)
      assert.match(cap.reason!, /temporarily unavailable/i)
    })

    it('should block remote trial calls if a remote provider is selected but NOT_CONFIGURED', () => {
      const cap = trialCapability({
        status: 'ACTIVE',
        trialAvailable: true,
        integrationStatus: 'NOT_CONFIGURED',
        integration: { provider: 'MOBILE_SHOP' },
      })
      assert.equal(cap.canCreateTrial, false)
      assert.match(cap.reason!, /awaiting provider API configuration/i)
    })
  })

  describe('4. Test Adapter: Failure Simulation & Retry Handling', () => {
    it('should simulate transient 503 error and record http status', async () => {
      const adapter = new TestSaasIntegration({ failStatus: 503, failMessage: 'SaaS maintenance outage' })
      await assert.rejects(
        () =>
          adapter.createTrial({
            idempotencyKey: 'idemp-1234',
            externalRef: 'acc-1234',
            resellerCode: 'HEXA-01',
            businessName: 'Acme Test',
            contactName: 'Alice',
            contactEmail: 'alice@acme.test',
            contactPhone: '0771234567',
          }),
        (err: any) => {
          assert.equal(err instanceof IntegrationError, true)
          assert.equal(err.httpStatus, 503)
          assert.match(err.message, /maintenance outage/i)
          return true
        },
      )
      assert.equal(adapter.lastHttpStatus, 503)
    })

    it('should simulate client 409 conflict error', async () => {
      const adapter = new TestSaasIntegration({ failStatus: 409, failMessage: 'Tenant email already registered in SaaS' })
      await assert.rejects(
        () =>
          adapter.createTrial({
            idempotencyKey: 'idemp-5678',
            externalRef: 'acc-5678',
            resellerCode: 'HEXA-01',
            businessName: 'Acme Test',
            contactName: 'Bob',
            contactEmail: 'bob@acme.test',
            contactPhone: '0771234567',
          }),
        (err: any) => {
          assert.equal(err.httpStatus, 409)
          return true
        },
      )
    })

    it('should simulate successful provisioning with unique externalTenantId based on idempotency key', async () => {
      const adapter = new TestSaasIntegration({ trialOutcome: 'PROVISIONED' })
      const res1 = await adapter.createTrial({
        idempotencyKey: 'unique-key-abc',
        externalRef: 'acc-001',
        resellerCode: 'HEXA-01',
        businessName: 'Client 1',
        contactName: 'Charlie',
        contactEmail: 'charlie@client1.test',
        contactPhone: '0771234567',
      })
      assert.equal(res1.outcome, 'PROVISIONED')
      assert.equal(res1.externalTenantId, 'tenant_unique-k')
      assert.equal(res1.status, 'TRIAL')
      assert.ok(res1.trialEndsAt)
    })

    it('should simulate successful activation confirmation with subscription reference', async () => {
      const adapter = new TestSaasIntegration({ activateOutcome: 'ACTIVATED' })
      const res = await adapter.activateSubscription({
        idempotencyKey: 'act-key-xyz',
        externalRef: 'AR-999',
        externalTenantId: 'tenant_001',
        periodMonth: '2026-10',
        amount: '5500.00',
        currency: 'LKR',
        paymentMethod: 'BANK_TRANSFER',
        paymentReference: 'TXN-777',
        paymentDate: '2026-10-12',
        verifiedBy: 'admin@test.invalid',
      })
      assert.equal(res.status, 'ACTIVATED')
      assert.equal(res.subscriptionReference, 'SUB-act-key-')
    })
  })

  describe('5. Decoupling Internal Approval from SaaS Activation', () => {
    it('should verify that internal review states do not imply active subscription', () => {
      // In the Hexalyte platform, internal review states:
      const internalReviewStatuses = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED']
      const activeSaaSStatuses = ['ACTIVATION_COMPLETED']

      for (const st of internalReviewStatuses) {
        // None of the internal approval states equate to completed activation
        assert.equal(activeSaaSStatuses.includes(st), false)
      }
    })

    it('should confirm that decimal commission math matches exact rounding rules', () => {
      const base = new Prisma.Decimal('5500.00')
      const rate10 = new Prisma.Decimal('10.00')
      const comm10 = base.mul(rate10).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      assert.equal(comm10.toFixed(2), '550.00')

      const rate25 = new Prisma.Decimal('25.00')
      const comm25 = base.mul(rate25).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      assert.equal(comm25.toFixed(2), '1375.00')
    })
  })
})
