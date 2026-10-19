import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { RESELLER_APPROVAL_REQUIRED, requirePermission } from '../src/middleware/auth.middleware'
import { effectivePermissions, permissionsFor } from '../src/rbac/permissions'

/** Runs the middleware with a fake request and returns what it passed to `next`. */
function run(permission: Parameters<typeof requirePermission>[0], req: Partial<Request>) {
  let result: unknown = 'not-called'
  requirePermission(permission)(req as Request, {} as Response, (err?: unknown) => {
    result = err
  })
  return result as undefined | { statusCode?: number; message?: string }
}

const seller = (resellerStatus: 'PENDING' | 'ACTIVE' | 'REJECTED' | null) =>
  ({ user: { userId: 'u1', email: 's@x.test', role: 'SELLER', resellerId: resellerStatus ? 'r1' : null }, resellerStatus }) as Partial<Request>

describe('Reseller approval gate (backend)', () => {
  it('refuses permissioned seller routes until the reseller application is approved', () => {
    for (const status of [null, 'PENDING', 'REJECTED'] as const) {
      const err = run('products:read', seller(status))
      assert.equal(err?.statusCode, 403, `status ${status}: must be refused`)
      assert.equal(err?.message, RESELLER_APPROVAL_REQUIRED)
    }
  })

  it('lets an approved reseller through', () => {
    assert.equal(run('products:read', seller('ACTIVE')), undefined)
    assert.equal(run('demos:create', seller('ACTIVE')), undefined)
  })

  it('still enforces the role permission itself (an approved seller cannot use admin permissions)', () => {
    const err = run('settings:manage', seller('ACTIVE'))
    assert.equal(err?.statusCode, 403)
    assert.equal(err?.message, 'Insufficient permissions')
  })

  it('does not affect platform staff', () => {
    const admin = { user: { userId: 'a1', email: 'a@x.test', role: 'ADMIN', resellerId: null }, resellerStatus: null } as Partial<Request>
    assert.equal(run('settings:manage', admin), undefined)
    assert.equal(run('resellers:manage', admin), undefined)
  })

  it('an unauthenticated request is still a 401', () => {
    assert.equal(run('products:read', {})?.statusCode, 401)
  })
})

describe('/auth/me permissions mirror the approval gate', () => {
  it('a seller has no permissions until the application is approved, then gets the normal set', () => {
    for (const status of [null, undefined, 'PENDING', 'REJECTED']) {
      assert.deepEqual(effectivePermissions('SELLER', status), [], `status ${String(status)}`)
    }
    assert.deepEqual(effectivePermissions('SELLER', 'ACTIVE'), permissionsFor('SELLER'))
    assert.equal(effectivePermissions('SELLER', 'ACTIVE').includes('products:read'), true)
  })

  it('staff always keep their permissions', () => {
    assert.deepEqual(effectivePermissions('ADMIN', null), permissionsFor('ADMIN'))
  })
})
