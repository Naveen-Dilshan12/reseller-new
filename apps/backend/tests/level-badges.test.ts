import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma, type CommissionLevel } from '@prisma/client'
import { calculateCommissionAmount, levelFor, splitSubscription } from '../src/modules/commissions/level.service'
import { updateLevelsSchema } from '../src/modules/settings/settings.schema'
import { hasPermission, permissionsFor } from '../src/rbac/permissions'

const D = (n: number | string) => new Prisma.Decimal(n)

/** Levels exactly as an Admin could configure them: nothing here is built into the code. */
const levels = [
  { level: 1, name: 'Starter', minActiveCustomers: 1, maxActiveCustomers: 4, ratePercent: D(8) },
  { level: 2, name: 'Pro', minActiveCustomers: 5, maxActiveCustomers: 12, ratePercent: D(12.5) },
  { level: 3, name: 'Elite', minActiveCustomers: 13, maxActiveCustomers: null, ratePercent: D(22) },
] as unknown as CommissionLevel[]

describe('Commission split: reseller commission vs Hexalyte remainder', () => {
  it('splits the subscription price using the configured percentage; the two parts add up to the price', () => {
    const a = splitSubscription(D(5000), D(10))
    assert.equal(a.resellerAmount.toFixed(2), '500.00')
    assert.equal(a.hexalyteAmount.toFixed(2), '4500.00')
    const b = splitSubscription(D(5000), D(30))
    assert.equal(b.resellerAmount.toFixed(2), '1500.00')
    assert.equal(b.hexalyteAmount.toFixed(2), '3500.00')
    const odd = splitSubscription(D('5500.00'), D('12.5'))
    assert.equal(odd.resellerAmount.toFixed(2), '687.50')
    assert.equal(odd.resellerAmount.plus(odd.hexalyteAmount).toFixed(2), '5500.00')
  })

  it('uses the same rounding as the commission ledger and gives the seller nothing at 0%', () => {
    const price = D('5000')
    assert.equal(splitSubscription(price, D('10.33')).resellerAmount.toFixed(2), calculateCommissionAmount(price, D('10.33')).toFixed(2))
    const zero = splitSubscription(price, D(0))
    assert.equal(zero.resellerAmount.toFixed(2), '0.00')
    assert.equal(zero.hexalyteAmount.toFixed(2), '5000.00')
  })
})

describe('Levels follow the Admin-configured thresholds and rates', () => {
  it('no level below the first threshold; the rate is 0', () => {
    const info = levelFor(0, levels)
    assert.equal(info.level, null)
    assert.equal(info.ratePercent.toFixed(2), '0.00')
    assert.equal(info.nextLevel?.customersNeeded, 1)
  })

  it('resolves level, rate and next-level target from whatever levels are configured', () => {
    const l1 = levelFor(4, levels)
    assert.deepEqual([l1.level, l1.name, Number(l1.ratePercent), l1.nextLevel?.name, l1.nextLevel?.customersNeeded], [1, 'Starter', 8, 'Pro', 1])
    const l2 = levelFor(5, levels)
    assert.deepEqual([l2.level, Number(l2.ratePercent), l2.nextLevel?.customersNeeded], [2, 12.5, 8])
    const top = levelFor(40, levels)
    assert.deepEqual([top.level, top.name, Number(top.ratePercent), top.nextLevel], [3, 'Elite', 22, null])
  })

  it('changing the configured levels changes the outcome (no built-in thresholds)', () => {
    const changed = [
      { level: 1, name: 'Bronze', minActiveCustomers: 0, maxActiveCustomers: 2, ratePercent: D(5) },
      { level: 2, name: 'Silver', minActiveCustomers: 3, maxActiveCustomers: null, ratePercent: D(50) },
    ] as unknown as CommissionLevel[]
    assert.equal(levelFor(4, levels).level, 1)
    assert.equal(levelFor(4, changed).level, 2)
    assert.equal(Number(levelFor(4, changed).ratePercent), 50)
  })
})

describe('Only Admin can change levels, rates and thresholds', () => {
  it('the settings and commission management permissions belong to ADMIN, never to SELLER', () => {
    for (const p of ['settings:manage', 'settings:read', 'commissions:manage'] as const) {
      assert.equal(hasPermission('ADMIN', p), true, `ADMIN must have ${p}`)
      assert.equal(hasPermission('SELLER', p), false, `SELLER must not have ${p}`)
    }
    assert.equal(permissionsFor('SELLER').includes('commissions:read'), true, 'a seller can read their own commission data')
  })

  it('the level update payload keeps tiers contiguous and rates within 0–100 (so Admin edits cannot break the ladder)', () => {
    const ok = updateLevelsSchema.safeParse({
      reason: 'Quarterly review',
      levels: [
        { level: 1, name: 'Starter', minActiveCustomers: 1, maxActiveCustomers: 4, ratePercent: 8 },
        { level: 2, name: 'Pro', minActiveCustomers: 5, maxActiveCustomers: null, ratePercent: 12.5 },
      ],
    })
    assert.equal(ok.success, true)
    const gap = updateLevelsSchema.safeParse({
      reason: 'Quarterly review',
      levels: [
        { level: 1, name: 'Starter', minActiveCustomers: 1, maxActiveCustomers: 4, ratePercent: 8 },
        { level: 2, name: 'Pro', minActiveCustomers: 9, maxActiveCustomers: null, ratePercent: 12.5 },
      ],
    })
    assert.equal(gap.success, false, 'a gap between tiers must be refused')
    const tooHigh = updateLevelsSchema.safeParse({
      reason: 'Quarterly review',
      levels: [{ level: 1, name: 'Starter', minActiveCustomers: 1, maxActiveCustomers: null, ratePercent: 101 }],
    })
    assert.equal(tooHigh.success, false, 'a rate above 100% must be refused')
  })
})
