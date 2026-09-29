import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma, type CommissionLevel } from '@prisma/client'
import { calculateCommissionAmount, levelFor } from '../src/modules/commissions/level.service'

const mockLevels: CommissionLevel[] = [
  { id: '1', level: 1, name: 'Level 1', minActiveCustomers: 1, maxActiveCustomers: 5, ratePercent: new Prisma.Decimal('10.00'), createdAt: new Date(), updatedAt: new Date() },
  { id: '2', level: 2, name: 'Level 2', minActiveCustomers: 6, maxActiveCustomers: 15, ratePercent: new Prisma.Decimal('15.00'), createdAt: new Date(), updatedAt: new Date() },
  { id: '3', level: 3, name: 'Level 3', minActiveCustomers: 16, maxActiveCustomers: 30, ratePercent: new Prisma.Decimal('20.00'), createdAt: new Date(), updatedAt: new Date() },
  { id: '4', level: 4, name: 'Level 4', minActiveCustomers: 31, maxActiveCustomers: 50, ratePercent: new Prisma.Decimal('25.00'), createdAt: new Date(), updatedAt: new Date() },
  { id: '5', level: 5, name: 'Level 5', minActiveCustomers: 51, maxActiveCustomers: null, ratePercent: new Prisma.Decimal('30.00'), createdAt: new Date(), updatedAt: new Date() },
]

describe('Commission Level & Calculation Service', () => {
  it('should return level null and 0% rate for 0 active customers', () => {
    const info = levelFor(0, mockLevels)
    assert.equal(info.level, null)
    assert.equal(info.name, null)
    assert.equal(info.ratePercent.toString(), '0')
    assert.equal(info.activeCustomerCount, 0)
    assert.ok(info.nextLevel)
    assert.equal(info.nextLevel?.level, 1)
    assert.equal(info.nextLevel?.customersNeeded, 1)
  })

  it('should resolve Level 1 (10%) for 1 to 5 active customers', () => {
    const info1 = levelFor(1, mockLevels)
    assert.equal(info1.level, 1)
    assert.equal(info1.ratePercent.toString(), '10')
    assert.equal(info1.nextLevel?.level, 2)
    assert.equal(info1.nextLevel?.customersNeeded, 5) // 6 - 1 = 5

    const info5 = levelFor(5, mockLevels)
    assert.equal(info5.level, 1)
    assert.equal(info5.ratePercent.toString(), '10')
    assert.equal(info5.nextLevel?.customersNeeded, 1) // 6 - 5 = 1
  })

  it('should resolve Level 2 (15%) for 6 to 15 active customers', () => {
    const info = levelFor(10, mockLevels)
    assert.equal(info.level, 2)
    assert.equal(info.ratePercent.toString(), '15')
    assert.equal(info.nextLevel?.level, 3)
    assert.equal(info.nextLevel?.customersNeeded, 6) // 16 - 10 = 6
  })

  it('should resolve Level 5 (30%) with no nextLevel for 51+ active customers', () => {
    const info51 = levelFor(51, mockLevels)
    assert.equal(info51.level, 5)
    assert.equal(info51.ratePercent.toString(), '30')
    assert.equal(info51.nextLevel, null)

    const info100 = levelFor(100, mockLevels)
    assert.equal(info100.level, 5)
    assert.equal(info100.ratePercent.toString(), '30')
    assert.equal(info100.nextLevel, null)
  })

  it('should correctly calculate commission amount rounded to 2 decimal places', () => {
    // 5500.00 * 10% = 550.00
    const amt1 = calculateCommissionAmount(new Prisma.Decimal('5500.00'), new Prisma.Decimal('10.00'))
    assert.equal(amt1.toString(), '550')

    // 5500.00 * 15% = 825.00
    const amt2 = calculateCommissionAmount(new Prisma.Decimal('5500.00'), new Prisma.Decimal('15.00'))
    assert.equal(amt2.toString(), '825')

    // 3333.33 * 10% = 333.333 -> 333.33
    const amt3 = calculateCommissionAmount(new Prisma.Decimal('3333.33'), new Prisma.Decimal('10.00'))
    assert.equal(amt3.toString(), '333.33')

    // 99.95 * 12.5% = 12.49375 -> 12.49
    const amt4 = calculateCommissionAmount(new Prisma.Decimal('99.95'), new Prisma.Decimal('12.50'))
    assert.equal(amt4.toString(), '12.49')
  })
})
