import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerResellerSchema } from '../src/modules/resellers/reseller.schema'
import { periodMonthSchema } from '../src/utils/period'
import { updateLevelsSchema } from '../src/modules/settings/settings.schema'
import { createTrialSchema } from '../src/modules/trials/trial.schema'
import { createActivationSchema } from '../src/modules/activations/activation.schema'

describe('Zod Validation Schemas', () => {
  it('should validate and normalize Sri Lankan mobile numbers and NICs', () => {
    const validData = {
      personal: {
        fullName: 'Nimal Perera',
        nicOrPassport: '123456789V',
        email: 'nimal@example.com',
        mobile: '0771234567',
        address: '12 Temple Road, Colombo',
      },
      business: {
        businessName: 'Nimal Traders',
        businessRegistrationNo: 'PV12345',
        businessAddress: '12 Temple Road, Colombo',
        businessPhone: '0112345678',
        businessEmail: 'biz@nimal.test',
      },
      bank: {
        bankName: 'Commercial Bank',
        branch: 'Kollupitiya',
        accountHolderName: 'Nimal Perera',
        accountNumber: '8001234567',
      },
      password: 'SecurePassword123!',
      confirmPassword: 'SecurePassword123!',
      acceptTerms: true,
    }

    const parsed = registerResellerSchema.safeParse(validData)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.personal.mobile, '+94771234567')
      assert.equal(parsed.data.personal.nicOrPassport, '123456789V')
    }
  })

  it('should reject passwords that do not match confirmation', () => {
    const data = {
      personal: { fullName: 'Test', nicOrPassport: '123456789V', email: 'test@a.test', mobile: '0771234567', address: 'Addr 123' },
      business: { businessName: 'Biz', businessRegistrationNo: 'PV999', businessAddress: 'Addr', businessPhone: '0112345678', businessEmail: 'b@a.test' },
      bank: { bankName: 'Bank', branch: 'Branch', accountHolderName: 'Holder', accountNumber: '1234567' },
      password: 'Password123A',
      confirmPassword: 'DifferentPassword123A',
      acceptTerms: true,
    }
    const parsed = registerResellerSchema.safeParse(data)
    assert.equal(parsed.success, false)
  })

  it('should validate periodMonth YYYY-MM format', () => {
    assert.equal(periodMonthSchema.safeParse('2026-09').success, true)
    assert.equal(periodMonthSchema.safeParse('2026-12').success, true)
    assert.equal(periodMonthSchema.safeParse('2026-13').success, false)
    assert.equal(periodMonthSchema.safeParse('2026-00').success, false)
    assert.equal(periodMonthSchema.safeParse('2026/09').success, false)
    assert.equal(periodMonthSchema.safeParse('invalid').success, false)
  })

  it('should validate contiguous commission tiers in settings schema', () => {
    const validLevels = {
      levels: [
        { level: 1, name: 'L1', minActiveCustomers: 1, maxActiveCustomers: 5, ratePercent: 10 },
        { level: 2, name: 'L2', minActiveCustomers: 6, maxActiveCustomers: 15, ratePercent: 15 },
        { level: 3, name: 'L3', minActiveCustomers: 16, maxActiveCustomers: null, ratePercent: 20 },
      ],
      reason: 'Updating tier boundaries for Q4 promotion',
    }
    assert.equal(updateLevelsSchema.safeParse(validLevels).success, true)

    // Gap between tiers (1-5, then 7-15) -> Should FAIL
    const gapLevels = {
      levels: [
        { level: 1, name: 'L1', minActiveCustomers: 1, maxActiveCustomers: 5, ratePercent: 10 },
        { level: 2, name: 'L2', minActiveCustomers: 7, maxActiveCustomers: null, ratePercent: 15 },
      ],
      reason: 'Has gap between 5 and 7',
    }
    assert.equal(updateLevelsSchema.safeParse(gapLevels).success, false)

    // Non-open-ended last level -> Should FAIL
    const closedLastLevel = {
      levels: [
        { level: 1, name: 'L1', minActiveCustomers: 1, maxActiveCustomers: 10, ratePercent: 10 },
      ],
      reason: 'Last level has max',
    }
    assert.equal(updateLevelsSchema.safeParse(closedLastLevel).success, false)
  })

  it('should validate createTrial schema', () => {
    const valid = {
      productId: 'prod-123',
      owner: {
        businessName: 'Super Store',
        contactName: 'Kasun Silva',
        contactEmail: 'kasun@superstore.test',
        contactPhone: '0712345678',
      },
    }
    assert.equal(createTrialSchema.safeParse(valid).success, true)
  })

  it('should validate createActivation schema', () => {
    const valid = {
      customerId: 'cust-1',
      productId: 'prod-1',
      periodMonth: '2026-09',
      amount: '5500.00',
      payerName: 'Kasun Silva',
      payerBank: 'BOC',
      transactionRef: 'TRX-998877',
      transferDate: '2026-09-28',
    }
    assert.equal(createActivationSchema.safeParse(valid).success, true)
  })
})
