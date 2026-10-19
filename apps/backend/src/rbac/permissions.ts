import type { UserRole } from '@prisma/client'

export const PERMISSIONS = [
  'users:manage',
  'resellers:read',
  'resellers:manage',
  'resellers:bank-reveal',
  'reseller-users:manage',
  'products:read',
  'products:manage',
  'accounts:read',
  'accounts:sync',
  'accounts:manage',
  'subscriptions:record',
  'trials:read',
  'trials:create',
  'trials:manage',
  'activations:read',
  'activations:create',
  'activations:review',
  'activations:activate',
  'demos:read',
  'demos:create',
  'demos:review',
  'bankslips:read',
  'bankslips:upload',
  'commissions:read',
  'commissions:manage',
  'audit:read',
  'integrations:read',
  'integrations:manage',
  'settings:read',
  'settings:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const RESELLER_BASE: Permission[] = [
  'products:read',
  'accounts:read',
  'accounts:sync',
  'trials:read',
  'trials:create',
  'activations:read',
  'activations:create',
  'demos:read',
  'demos:create',
  'bankslips:read',
  'bankslips:upload',
]

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  ADMIN: new Set(PERMISSIONS),
  SELLER: new Set<Permission>([...RESELLER_BASE, 'reseller-users:manage', 'commissions:read']),
}

export const PLATFORM_ROLES: readonly UserRole[] = ['ADMIN']
export const RESELLER_ROLES: readonly UserRole[] = ['SELLER']

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

export function permissionsFor(role: UserRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]]
}

/**
 * What a signed-in user may do right now. Sellers have no permissions until their reseller
 * application has been approved (status ACTIVE); staff are not affected.
 */
export function effectivePermissions(role: UserRole, resellerStatus: string | null | undefined): Permission[] {
  return isPlatformRole(role) || resellerStatus === 'ACTIVE' ? permissionsFor(role) : []
}

export function isPlatformRole(role: UserRole): boolean {
  return PLATFORM_ROLES.includes(role)
}
