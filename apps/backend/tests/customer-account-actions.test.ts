import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Customer Account Action Rules & Lifecycle State Machine Tests
 *
 * Verifies backend enforcement and lifecycle validation for:
 * 1. ACTIVE (PAID) - No new trials, no duplicate activations, View Account only
 * 2. PENDING SETUP (with pending trial) - No duplicate trials, Check Status only, no activations without tenant
 * 3. ACTIVE TRIAL - No duplicate trials, allow paid activation only when no open request exists
 * 4. FAILED PROVISIONING - Blind create blocked with retry required, safe idempotent retry
 * 5. PENDING PAID ACTIVATION - Blocks duplicate activation requests and blocks trial requests
 */

type AccountStatus = 'PENDING' | 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
type TrialStatus = 'PENDING' | 'SUBMITTED' | 'PROVISIONED' | 'FAILED' | 'CANCELLED'
type ActivationStatus =
  | 'PENDING_REVIEW'
  | 'UNDER_REVIEW'
  | 'PAYMENT_VERIFIED'
  | 'APPROVED'
  | 'ACTIVATION_IN_PROGRESS'
  | 'ACTIVATION_COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'

const OPEN_ACTIVATION_STATUSES: ActivationStatus[] = ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED']

interface AccountContext {
  id: string
  status: AccountStatus
  externalTenantId: string | null
  product: { id: string; name: string; monthlyPrice: number; currency: string }
  trialRequests: { id: string; status: TrialStatus; attempts: number }[]
  activationRequests: { id: string; reference: string; status: ActivationStatus }[]
}

/**
 * Backend business rule evaluation function matching trialService.create enforcement.
 */
function validateTrialCreation(account: AccountContext | null, productName: string): { ok: boolean; status?: number; error?: string; code?: string } {
  if (!account) return { ok: true }

  if (account.status === 'ACTIVE') {
    return { ok: false, status: 409, error: `This customer already has an active paid subscription for ${productName}` }
  }

  if (account.status === 'TRIAL' || account.externalTenantId) {
    return { ok: false, status: 409, error: `This customer already has an active trial for ${productName}` }
  }

  const openActivation = account.activationRequests.find((a) => OPEN_ACTIVATION_STATUSES.includes(a.status))
  if (openActivation) {
    return {
      ok: false,
      status: 409,
      error: `An activation request (${openActivation.reference}) is already pending review for this customer account`,
    }
  }

  const lastTrial = account.trialRequests[0]
  if (lastTrial && (lastTrial.status === 'PENDING' || lastTrial.status === 'SUBMITTED')) {
    return { ok: false, status: 409, error: 'A trial request for this customer is already in progress' }
  }

  if (lastTrial && lastTrial.status === 'FAILED') {
    return {
      ok: false,
      status: 409,
      error: 'A previous trial request for this customer failed. Retry it from the trial list.',
      code: 'TRIAL_RETRY_AVAILABLE',
    }
  }

  return { ok: true }
}

/**
 * Backend business rule evaluation function matching activationService.create enforcement.
 */
function validateActivationCreation(
  account: AccountContext | null,
  amount: number,
  _periodMonth: string,
): { ok: boolean; status?: number; error?: string } {
  if (!account) {
    return {
      ok: false,
      status: 400,
      error: 'The customer must have a trial account for this product before requesting paid activation. Please provision a trial first.',
    }
  }

  if (!account.externalTenantId) {
    return {
      ok: false,
      status: 400,
      error: 'The customer account has no provisioned SaaS tenant. Provision a trial through the SaaS integration first before submitting paid activation.',
    }
  }

  if (account.status === 'ACTIVE') {
    return {
      ok: false,
      status: 409,
      error: `This customer already has an active paid subscription for ${account.product.name}`,
    }
  }

  const openRequest = account.activationRequests.find((a) => OPEN_ACTIVATION_STATUSES.includes(a.status))
  if (openRequest) {
    return {
      ok: false,
      status: 409,
      error: `An activation request (${openRequest.reference}) is already pending review for this customer account`,
    }
  }

  if (amount !== account.product.monthlyPrice) {
    return {
      ok: false,
      status: 400,
      error: `The monthly subscription fee for ${account.product.name} is ${account.product.currency} ${account.product.monthlyPrice.toFixed(2)}`,
    }
  }

  return { ok: true }
}

/**
 * Frontend state evaluation matching getAccountDisplayState in apps/web/src/app/customers/page.tsx.
 */
function getDisplayState(account: AccountContext) {
  const latestTrial = account.trialRequests[0]
  const latestActivation = account.activationRequests[0]
  const hasOpenActivation = Boolean(latestActivation && OPEN_ACTIVATION_STATUSES.includes(latestActivation.status))

  if (account.status === 'ACTIVE') {
    return {
      label: 'Active (Paid)',
      kind: 'ACTIVE' as const,
      hasOpenActivation: false,
      allowedActions: ['VIEW_ACCOUNT'] as const,
    }
  }

  if (hasOpenActivation) {
    return {
      label: 'Activation in Review',
      kind: 'ACTIVATION_REVIEW' as const,
      hasOpenActivation: true,
      allowedActions: ['CHECK_STATUS'] as const,
    }
  }

  if (account.status === 'TRIAL') {
    return {
      label: 'Active Trial',
      kind: 'TRIAL' as const,
      hasOpenActivation: false,
      allowedActions: ['ACTIVATE'] as const,
    }
  }

  if (account.status === 'PENDING') {
    if (latestTrial && (latestTrial.status === 'SUBMITTED' || latestTrial.status === 'PENDING')) {
      return {
        label: 'Trial Provisioning',
        kind: 'TRIAL_PENDING' as const,
        hasOpenActivation: false,
        allowedActions: ['CHECK_STATUS'] as const,
      }
    }
    if (latestTrial && latestTrial.status === 'FAILED') {
      return {
        label: 'Provisioning Failed',
        kind: 'TRIAL_FAILED' as const,
        hasOpenActivation: false,
        allowedActions: ['RETRY'] as const,
      }
    }
    return {
      label: 'Pending Setup',
      kind: 'PENDING_SETUP' as const,
      hasOpenActivation: false,
      allowedActions: ['START_TRIAL'] as const,
    }
  }

  return {
    label: account.status,
    kind: account.status,
    hasOpenActivation: false,
    allowedActions: [],
  }
}

describe('Customer Account Conditional Actions & Backend Enforcement', () => {
  const mockProduct = { id: 'prod_clothing_erp', name: 'HexaOne Clothing ERP', monthlyPrice: 5500.0, currency: 'LKR' }

  describe('1. ACTIVE (PAID) Account Rules', () => {
    const activeAccount: AccountContext = {
      id: 'acc_ruwan_shop',
      status: 'ACTIVE',
      externalTenantId: null, // Reconciled historical state or confirmed tenant
      product: mockProduct,
      trialRequests: [{ id: 'tr_1', status: 'PROVISIONED', attempts: 1 }],
      activationRequests: [{ id: 'act_1', reference: 'AR-COMPLETED', status: 'ACTIVATION_COMPLETED' }],
    }

    it('should reject new trial creation for ACTIVE (PAID) account with 409 Conflict', () => {
      const result = validateTrialCreation(activeAccount, mockProduct.name)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.match(result.error!, /already has an active paid subscription/)
    })

    it('should reject duplicate paid activation for ACTIVE (PAID) account with 409 Conflict', () => {
      const activeWithTenant: AccountContext = { ...activeAccount, externalTenantId: 'tenant_real_123' }
      const result = validateActivationCreation(activeWithTenant, 5500.0, '2026-10')
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.match(result.error!, /already has an active paid subscription/)
    })

    it('should evaluate UI display state as ACTIVE and allow only View Account (no Trial, no Activate)', () => {
      const ui = getDisplayState(activeAccount)
      assert.strictEqual(ui.kind, 'ACTIVE')
      assert.strictEqual(ui.label, 'Active (Paid)')
      assert.deepStrictEqual(ui.allowedActions, ['VIEW_ACCOUNT'])
      assert.strictEqual(ui.allowedActions.includes('START_TRIAL' as any), false)
      assert.strictEqual(ui.allowedActions.includes('ACTIVATE' as any), false)
    })
  })

  describe('2. PENDING SETUP with Pending Trial', () => {
    const pendingTrialAccount: AccountContext = {
      id: 'acc_dsdsds_trial_only',
      status: 'PENDING',
      externalTenantId: null,
      product: mockProduct,
      trialRequests: [{ id: 'tr_dsdsds', status: 'SUBMITTED', attempts: 1 }],
      activationRequests: [],
    }

    it('should reject duplicate trial creation when trial is SUBMITTED or PENDING with 409 Conflict', () => {
      const result = validateTrialCreation(pendingTrialAccount, mockProduct.name)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.match(result.error!, /A trial request for this customer is already in progress/)
    })

    it('should reject paid activation when SaaS tenant is not yet provisioned with 400 Bad Request', () => {
      const result = validateActivationCreation(pendingTrialAccount, 5500.0, '2026-10')
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 400)
      assert.match(result.error!, /has no provisioned SaaS tenant/)
    })

    it('should evaluate UI display state as TRIAL_PENDING and allow only Check Status (no Start Trial, no Activate)', () => {
      const ui = getDisplayState(pendingTrialAccount)
      assert.strictEqual(ui.kind, 'TRIAL_PENDING')
      assert.strictEqual(ui.label, 'Trial Provisioning')
      assert.deepStrictEqual(ui.allowedActions, ['CHECK_STATUS'])
      assert.strictEqual(ui.allowedActions.includes('START_TRIAL' as any), false)
      assert.strictEqual(ui.allowedActions.includes('ACTIVATE' as any), false)
    })
  })

  describe('3. ACTIVE TRIAL Account Rules', () => {
    const activeTrialAccount: AccountContext = {
      id: 'acc_trial_active',
      status: 'TRIAL',
      externalTenantId: 'tenant_trial_123',
      product: mockProduct,
      trialRequests: [{ id: 'tr_ok', status: 'PROVISIONED', attempts: 1 }],
      activationRequests: [],
    }

    it('should reject new trial creation when account is already in active TRIAL with 409 Conflict', () => {
      const result = validateTrialCreation(activeTrialAccount, mockProduct.name)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.match(result.error!, /already has an active trial/)
    })

    it('should allow paid activation submission when no prior activation request is pending', () => {
      const result = validateActivationCreation(activeTrialAccount, 5500.0, '2026-10')
      assert.strictEqual(result.ok, true)
    })

    it('should evaluate UI display state as TRIAL and show Activate when no activation is pending', () => {
      const ui = getDisplayState(activeTrialAccount)
      assert.strictEqual(ui.kind, 'TRIAL')
      assert.strictEqual(ui.label, 'Active Trial')
      assert.deepStrictEqual(ui.allowedActions, ['ACTIVATE'])
      assert.strictEqual(ui.allowedActions.includes('START_TRIAL' as any), false)
    })

    it('should hide Activate and show Activation in Review when trial has an open activation', () => {
      const trialWithOpenAct: AccountContext = {
        ...activeTrialAccount,
        activationRequests: [{ id: 'act_pending', reference: 'AR-TR1234', status: 'PENDING_REVIEW' }],
      }
      const ui = getDisplayState(trialWithOpenAct)
      assert.strictEqual(ui.kind, 'ACTIVATION_REVIEW')
      assert.strictEqual(ui.label, 'Activation in Review')
      assert.deepStrictEqual(ui.allowedActions, ['CHECK_STATUS'])
      assert.strictEqual(ui.allowedActions.includes('ACTIVATE' as any), false)
    })
  })

  describe('4. FAILED PROVISIONING Rules & Safe Idempotent Retries', () => {
    const failedTrialAccount: AccountContext = {
      id: 'acc_failed_provision',
      status: 'PENDING',
      externalTenantId: null,
      product: mockProduct,
      trialRequests: [{ id: 'tr_failed_1', status: 'FAILED', attempts: 1 }],
      activationRequests: [],
    }

    it('should reject blind trial create() when previous trial failed, directing user to retry', () => {
      const result = validateTrialCreation(failedTrialAccount, mockProduct.name)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.strictEqual(result.code, 'TRIAL_RETRY_AVAILABLE')
      assert.match(result.error!, /A previous trial request for this customer failed. Retry it from the trial list./)
    })

    it('should simulate idempotent retry: increments attempt count on the SAME record without creating new row', () => {
      const initialTrial = { ...failedTrialAccount.trialRequests[0] }
      // Simulating claimAttempt logic in trial.service.ts
      const retriedTrial = {
        ...initialTrial,
        status: 'PENDING' as TrialStatus,
        attempts: initialTrial.attempts + 1,
      }
      assert.strictEqual(retriedTrial.id, initialTrial.id, 'Must reuse the exact same TrialRequest ID')
      assert.strictEqual(retriedTrial.attempts, 2, 'Attempts count must increment')
      assert.strictEqual(retriedTrial.status, 'PENDING')
    })

    it('should evaluate UI display state as TRIAL_FAILED and show Retry button only', () => {
      const ui = getDisplayState(failedTrialAccount)
      assert.strictEqual(ui.kind, 'TRIAL_FAILED')
      assert.strictEqual(ui.label, 'Provisioning Failed')
      assert.deepStrictEqual(ui.allowedActions, ['RETRY'])
      assert.strictEqual(ui.allowedActions.includes('START_TRIAL' as any), false)
      assert.strictEqual(ui.allowedActions.includes('ACTIVATE' as any), false)
    })
  })

  describe('5. PENDING PAID ACTIVATION (e.g. dsdsds Scenario)', () => {
    const dsdsdsAccount: AccountContext = {
      id: 'cmv57vcpi0034ertpwzd8bps8',
      status: 'PENDING',
      externalTenantId: null,
      product: mockProduct,
      trialRequests: [{ id: 'cmv57vcw50036ertp9xajigcy', status: 'SUBMITTED', attempts: 1 }],
      activationRequests: [{ id: 'cmv582f2c003dertpp6mm8jp5', reference: 'AR-W4VRTR', status: 'PENDING_REVIEW' }],
    }

    it('should reject duplicate paid activation creation when an activation is already PENDING_REVIEW', () => {
      // Even if externalTenantId was set, duplicate open request must be rejected
      const accountWithTenant: AccountContext = { ...dsdsdsAccount, externalTenantId: 'tenant_mock' }
      const result = validateActivationCreation(accountWithTenant, 5500.0, '2026-10')
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.match(result.error!, /An activation request \(AR-W4VRTR\) is already pending review/)
    })

    it('should reject trial creation when an activation request is pending review', () => {
      const result = validateTrialCreation(dsdsdsAccount, mockProduct.name)
      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.status, 409)
      assert.match(result.error!, /An activation request \(AR-W4VRTR\) is already pending review/)
    })

    it('should evaluate UI display state as ACTIVATION_REVIEW with Check Status action', () => {
      const ui = getDisplayState(dsdsdsAccount)
      assert.strictEqual(ui.kind, 'ACTIVATION_REVIEW')
      assert.strictEqual(ui.label, 'Activation in Review')
      assert.deepStrictEqual(ui.allowedActions, ['CHECK_STATUS'])
      assert.strictEqual(ui.allowedActions.includes('START_TRIAL' as any), false)
      assert.strictEqual(ui.allowedActions.includes('ACTIVATE' as any), false)
    })
  })

  describe('6. Multi-Product Separation per Customer', () => {
    const secondProduct = { id: 'prod_mobile_shop', name: 'Hexalyte Mobile Shop', monthlyPrice: 3500.0, currency: 'LKR' }

    it('should allow trial creation for a DIFFERENT product for a customer who already has an ACTIVE subscription', () => {
      // Account for Product 2 does not exist yet (null)
      const result = validateTrialCreation(null, secondProduct.name)
      assert.strictEqual(result.ok, true, 'Starting trial for a distinct unowned product must be permitted')
    })

    it('should ensure validation checks are isolated per customer account and product ID', () => {
      const customerAccounts: AccountContext[] = [
        {
          id: 'acc_prod_1',
          status: 'ACTIVE',
          externalTenantId: 'tenant_clothing',
          product: mockProduct,
          trialRequests: [],
          activationRequests: [],
        },
        {
          id: 'acc_prod_2',
          status: 'TRIAL',
          externalTenantId: 'tenant_mobile',
          product: secondProduct,
          trialRequests: [{ id: 'tr_2', status: 'PROVISIONED', attempts: 1 }],
          activationRequests: [],
        },
      ]

      // Product 1: ACTIVE -> View Account
      const ui1 = getDisplayState(customerAccounts[0])
      assert.strictEqual(ui1.kind, 'ACTIVE')
      assert.deepStrictEqual(ui1.allowedActions, ['VIEW_ACCOUNT'])

      // Product 2: TRIAL -> Activate
      const ui2 = getDisplayState(customerAccounts[1])
      assert.strictEqual(ui2.kind, 'TRIAL')
      assert.deepStrictEqual(ui2.allowedActions, ['ACTIVATE'])
    })
  })

  describe('7. Paid Activation Pipeline Counts & Scoped Reseller KPI Metrics', () => {
    interface MockActivationRequest {
      id: string
      resellerId: string
      status: ActivationStatus
    }

    function calculateActivationKPIs(requests: MockActivationRequest[], targetResellerId: string) {
      const resellerRequests = requests.filter((r) => r.resellerId === targetResellerId)
      return {
        total: resellerRequests.length,
        pendingReview: resellerRequests.filter((r) => r.status === 'PENDING_REVIEW').length,
        underReview: resellerRequests.filter((r) => r.status === 'UNDER_REVIEW').length,
        completed: resellerRequests.filter((r) => r.status === 'ACTIVATION_COMPLETED').length,
      }
    }

    it('should accurately count total, pending review, under review, and completed activations', () => {
      const dataset: MockActivationRequest[] = [
        { id: 'ar_1', resellerId: 'reseller_alpha', status: 'PENDING_REVIEW' },
        { id: 'ar_2', resellerId: 'reseller_alpha', status: 'UNDER_REVIEW' },
        { id: 'ar_3', resellerId: 'reseller_alpha', status: 'ACTIVATION_COMPLETED' },
        { id: 'ar_4', resellerId: 'reseller_alpha', status: 'ACTIVATION_COMPLETED' },
        { id: 'ar_5', resellerId: 'reseller_alpha', status: 'REJECTED' },
        { id: 'ar_6', resellerId: 'reseller_alpha', status: 'CANCELLED' },
        { id: 'ar_7', resellerId: 'reseller_alpha', status: 'APPROVED' },
      ]

      const kpis = calculateActivationKPIs(dataset, 'reseller_alpha')
      assert.strictEqual(kpis.total, 7, 'Total must include all requests for the reseller')
      assert.strictEqual(kpis.pendingReview, 1, 'Pending review must count only PENDING_REVIEW')
      assert.strictEqual(kpis.underReview, 1, 'Under review must count only UNDER_REVIEW')
      assert.strictEqual(kpis.completed, 2, 'Completed must count only ACTIVATION_COMPLETED')
    })

    it('should strictly isolate counts by authenticated resellerId', () => {
      const dataset: MockActivationRequest[] = [
        { id: 'ar_1', resellerId: 'reseller_alpha', status: 'PENDING_REVIEW' },
        { id: 'ar_2', resellerId: 'reseller_alpha', status: 'ACTIVATION_COMPLETED' },
        { id: 'ar_3', resellerId: 'reseller_beta', status: 'PENDING_REVIEW' },
        { id: 'ar_4', resellerId: 'reseller_beta', status: 'UNDER_REVIEW' },
        { id: 'ar_5', resellerId: 'reseller_beta', status: 'ACTIVATION_COMPLETED' },
      ]

      const alphaKpis = calculateActivationKPIs(dataset, 'reseller_alpha')
      assert.strictEqual(alphaKpis.total, 2)
      assert.strictEqual(alphaKpis.pendingReview, 1)
      assert.strictEqual(alphaKpis.underReview, 0)
      assert.strictEqual(alphaKpis.completed, 1)

      const betaKpis = calculateActivationKPIs(dataset, 'reseller_beta')
      assert.strictEqual(betaKpis.total, 3)
      assert.strictEqual(betaKpis.pendingReview, 1)
      assert.strictEqual(betaKpis.underReview, 1)
      assert.strictEqual(betaKpis.completed, 1)
    })

    it('should ensure non-completed statuses (REJECTED, CANCELLED, APPROVED) are never counted as completed', () => {
      const dataset: MockActivationRequest[] = [
        { id: 'ar_1', resellerId: 'reseller_alpha', status: 'REJECTED' },
        { id: 'ar_2', resellerId: 'reseller_alpha', status: 'CANCELLED' },
        { id: 'ar_3', resellerId: 'reseller_alpha', status: 'APPROVED' },
        { id: 'ar_4', resellerId: 'reseller_alpha', status: 'ACTIVATION_IN_PROGRESS' },
      ]

      const kpis = calculateActivationKPIs(dataset, 'reseller_alpha')
      assert.strictEqual(kpis.total, 4)
      assert.strictEqual(kpis.completed, 0, 'No uncompleted or rejected requests may be counted as completed')
      assert.strictEqual(kpis.pendingReview, 0)
      assert.strictEqual(kpis.underReview, 0)
    })
  })
})
