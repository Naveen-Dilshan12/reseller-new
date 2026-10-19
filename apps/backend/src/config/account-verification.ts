import { isPlatformRole } from '../rbac/permissions'
import type { UserRole } from '@prisma/client'

import { ACCOUNT_VERIFICATION_REQUIRED_FROM, parseVerificationCutoff } from './account-verification.config'

export { ACCOUNT_VERIFICATION_REQUIRED_FROM, parseVerificationCutoff }

const cutoff = parseVerificationCutoff(ACCOUNT_VERIFICATION_REQUIRED_FROM)

if (!cutoff && process.env.NODE_ENV === 'production') {
  // Secondary safety net: `npm run build` already rejects this (scripts/check-deploy-config.cjs).
  throw new Error('ACCOUNT_VERIFICATION_REQUIRED_FROM in src/config/account-verification.config.ts is still the placeholder. Set the deployment timestamp before building for production.')
}

export interface VerifiableAccount {
  role: UserRole
  emailVerified?: Date | null
  phoneVerifiedAt?: Date | null
  createdAt?: Date | null
}

/** True for accounts that existed before verification became mandatory. */
export function hasLegacyAccess(user: Pick<VerifiableAccount, 'createdAt'>, at: Date | null = cutoff): boolean {
  return !!at && !!user.createdAt && user.createdAt.getTime() < at.getTime()
}

/**
 * The one login/session gate for non-admin accounts: the account completed SMS verification (`phoneVerifiedAt`),
 * proved its email (`emailVerified`, set only by an emailed code), or is a legacy account.
 * NOTE: this answers "may this account sign in", not "is this email address owned by the user". Use `emailVerified`
 * alone for anything that needs email ownership; SMS verification never sets it.
 */
export function isAccountVerified(user: VerifiableAccount, at: Date | null = cutoff): boolean {
  return isPlatformRole(user.role) || !!user.emailVerified || !!user.phoneVerifiedAt || hasLegacyAccess(user, at)
}
