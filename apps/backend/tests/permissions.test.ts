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
  it('SUPER_ADMIN should have all permissions', () => {
    assert.equal(hasPermission('SUPER_ADMIN', 'users:manage'), true)
    assert.equal(hasPermission('SUPER_ADMIN', 'integrations:manage'), true)
    assert.equal(hasPermission('SUPER_ADMIN', 'settings:manage'), true)
    assert.equal(hasPermission('SUPER_ADMIN', 'resellers:bank-reveal'), true)
    assert.equal(hasPermission('SUPER_ADMIN', 'commissions:manage'), true)
  })

  it('ADMIN should not have users:manage or bank-reveal or integrations:manage or settings:manage', () => {
    assert.equal(hasPermission('ADMIN', 'users:manage'), false)
    assert.equal(hasPermission('ADMIN', 'resellers:bank-reveal'), false)
    assert.equal(hasPermission('ADMIN', 'integrations:manage'), false)
    assert.equal(hasPermission('ADMIN', 'settings:manage'), false)
    // But should have products:manage, resellers:manage, activations:review
    assert.equal(hasPermission('ADMIN', 'products:manage'), true)
    assert.equal(hasPermission('ADMIN', 'resellers:manage'), true)
    assert.equal(hasPermission('ADMIN', 'activations:review'), true)
  })

  it('FINANCE role should have finance & bank permissions but not products:manage or users:manage', () => {
    assert.equal(hasPermission('FINANCE', 'resellers:bank-reveal'), true)
    assert.equal(hasPermission('FINANCE', 'commissions:manage'), true)
    assert.equal(hasPermission('FINANCE', 'activations:review'), true)
    assert.equal(hasPermission('FINANCE', 'products:manage'), false)
    assert.equal(hasPermission('FINANCE', 'users:manage'), false)
  })

  it('RESELLER_ADMIN can read commissions and manage reseller users, but not approve activations or review bank slips of others', () => {
    assert.equal(hasPermission('RESELLER_ADMIN', 'trials:create'), true)
    assert.equal(hasPermission('RESELLER_ADMIN', 'activations:create'), true)
    assert.equal(hasPermission('RESELLER_ADMIN', 'commissions:read'), true)
    assert.equal(hasPermission('RESELLER_ADMIN', 'reseller-users:manage'), true)
    // Forbidden
    assert.equal(hasPermission('RESELLER_ADMIN', 'commissions:manage'), false)
    assert.equal(hasPermission('RESELLER_ADMIN', 'activations:review'), false)
    assert.equal(hasPermission('RESELLER_ADMIN', 'activations:activate'), false)
  })

  it('RESELLER_AGENT cannot view commissions or manage users', () => {
    assert.equal(hasPermission('RESELLER_AGENT', 'trials:create'), true)
    assert.equal(hasPermission('RESELLER_AGENT', 'activations:create'), true)
    assert.equal(hasPermission('RESELLER_AGENT', 'commissions:read'), false)
    assert.equal(hasPermission('RESELLER_AGENT', 'reseller-users:manage'), false)
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
