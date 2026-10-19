import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasPermission,
  permissionsFor,
  isPlatformRole,
  PLATFORM_ROLES,
  RESELLER_ROLES,
} from '../src/rbac/permissions'

describe('RBAC & Role Permissions', () => {
  it('ADMIN should have all permissions', () => {
    assert.equal(hasPermission('ADMIN', 'users:manage'), true)
    assert.equal(hasPermission('ADMIN', 'integrations:manage'), true)
    assert.equal(hasPermission('ADMIN', 'settings:manage'), true)
    assert.equal(hasPermission('ADMIN', 'resellers:bank-reveal'), true)
    assert.equal(hasPermission('ADMIN', 'commissions:manage'), true)
    assert.equal(hasPermission('ADMIN', 'demos:review'), true)
  })

  it('SELLER can read commissions and manage reseller users, but not approve activations or review bank slips of others', () => {
    assert.equal(hasPermission('SELLER', 'trials:create'), true)
    assert.equal(hasPermission('SELLER', 'activations:create'), true)
    assert.equal(hasPermission('SELLER', 'commissions:read'), true)
    assert.equal(hasPermission('SELLER', 'reseller-users:manage'), true)
    // Forbidden
    assert.equal(hasPermission('SELLER', 'commissions:manage'), false)
    assert.equal(hasPermission('SELLER', 'activations:review'), false)
    assert.equal(hasPermission('SELLER', 'activations:activate'), false)
  })

  it('SELLER can submit and read demo requests but can never review/approve/reject them', () => {
    assert.equal(hasPermission('SELLER', 'demos:read'), true)
    assert.equal(hasPermission('SELLER', 'demos:create'), true)
    assert.equal(hasPermission('SELLER', 'demos:review'), false)
  })

  it('should correctly classify platform vs reseller roles', () => {
    for (const role of PLATFORM_ROLES) {
      assert.equal(isPlatformRole(role), true)
    }
    for (const role of RESELLER_ROLES) {
      assert.equal(isPlatformRole(role), false)
    }
  })
})
