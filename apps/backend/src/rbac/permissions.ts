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
  'bankslips:read',
  'bankslips:upload',
]

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set(PERMISSIONS),
  ADMIN: new Set(
    PERMISSIONS.filter(
      (p) => p !== 'users:manage' && p !== 'resellers:bank-reveal' && p !== 'integrations:manage' && p !== 'settings:manage',
    ),
  ),
  FINANCE: new Set<Permission>([
    'resellers:read',
    'resellers:bank-reveal',
    'products:read',
    'accounts:read',
    'subscriptions:record',
    'trials:read',
    'activations:read',
    'activations:review',
    'bankslips:read',
    'commissions:read',
    'commissions:manage',
    'settings:read',
  ]),
  RESELLER_ADMIN: new Set<Permission>([...RESELLER_BASE, 'reseller-users:manage', 'commissions:read']),
  RESELLER_AGENT: new Set<Permission>(RESELLER_BASE),
}

export const PLATFORM_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCE']
export const RESELLER_ROLES: readonly UserRole[] = ['RESELLER_ADMIN', 'RESELLER_AGENT']

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

export function permissionsFor(role: UserRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]]
}

export function isPlatformRole(role: UserRole): boolean {
  return PLATFORM_ROLES.includes(role)
}
