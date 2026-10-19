import { Request, Response, NextFunction } from 'express'
import type { ResellerStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { isAccountVerified } from '../config/account-verification'
import { verifyAccessToken, JwtPayload } from '../utils/jwt'
import { hasPermission, isPlatformRole, type Permission } from '../rbac/permissions'
import { forbidden, unauthorized } from './error.middleware'

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
      /** Status of the caller's reseller application/account (null = no application submitted). Set by `authenticate`. */
      resellerStatus?: ResellerStatus | null
    }
  }
}

export const RESELLER_APPROVAL_REQUIRED = 'Your partner application must be approved before you can use this feature'

/**
 * Verifies the access token and re-checks the user in the database so that
 * deactivated users and suspended resellers lose access immediately.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return next(unauthorized())

  let payload: JwtPayload
  try {
    payload = verifyAccessToken(header.slice(7))
  } catch {
    return next(unauthorized('Invalid or expired token'))
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        emailVerified: true,
        phoneVerifiedAt: true,
        createdAt: true,
        resellerId: true,
        reseller: { select: { status: true } },
      },
    })
    if (!user || user.status !== 'ACTIVE') return next(unauthorized('Account is inactive'))
    if (!isAccountVerified(user)) {
      return next(forbidden('Account not verified'))
    }
    // Suspended resellers are blocked completely
    if (user.reseller && user.reseller.status === 'SUSPENDED') {
      return next(forbidden('Partner account is suspended'))
    }
    req.user = { userId: user.id, email: user.email, role: user.role, resellerId: user.resellerId }
    req.resellerStatus = user.reseller?.status ?? null
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Like `authenticate`, but never rejects the request: a missing header, an
 * invalid/expired token, or an inactive user all just leave `req.user` unset
 * instead of failing. Used by endpoints that behave differently for a
 * logged-in caller (e.g. linking a reseller application to the caller's own
 * account) but must stay reachable by a genuinely anonymous applicant too.
 */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return next()

  try {
    const payload = verifyAccessToken(header.slice(7))
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, role: true, status: true, resellerId: true },
    })
    if (user && user.status === 'ACTIVE') {
      req.user = { userId: user.id, email: user.email, role: user.role, resellerId: user.resellerId }
    }
  } catch {
    // Invalid/expired token: proceed unauthenticated rather than failing the request.
  }
  next()
}

/**
 * Every permissioned reseller feature (products, customers, trials, demos, activations, commissions…)
 * also needs an approved reseller. A seller whose application is missing, pending or rejected is
 * refused here, so the restriction holds even if someone calls the API directly. Routes that only
 * use `authenticate` (profile, password, notifications, the application itself) stay reachable.
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized())
    const allowed = permissions.every((p) => hasPermission(req.user!.role, p))
    if (!allowed) return next(forbidden('Insufficient permissions'))
    if (!isPlatformRole(req.user.role) && req.resellerStatus !== 'ACTIVE') return next(forbidden(RESELLER_APPROVAL_REQUIRED))
    next()
  }
}

export function currentUser(req: Request): JwtPayload {
  if (!req.user) throw unauthorized()
  return req.user
}

export function requireActiveReseller(req: Request, _res: Response, next: NextFunction): void {
  const user = currentUser(req)
  if (isPlatformRole(user.role)) return next()
  if (!user.resellerId) {
    return next(forbidden('You must have an approved partner account to access this resource'))
  }
  prisma.reseller
    .findUnique({
      where: { id: user.resellerId },
      select: { status: true },
    })
    .then((reseller) => {
      if (!reseller || reseller.status !== 'ACTIVE') {
        return next(forbidden('Partner account is not active'))
      }
      next()
    })
    .catch(next)
}

/** Prisma `where` fragment restricting reseller users to their own reseller's rows. */
export function resellerScope(req: Request): { resellerId?: string } {
  const user = currentUser(req)
  if (isPlatformRole(user.role)) return {}
  if (!user.resellerId) throw forbidden('User is not linked to a partner')
  return { resellerId: user.resellerId }
}

/**
 * Reseller users always get their own reseller id; platform users get the
 * requested one (possibly undefined, meaning "all resellers").
 */
export function resolveResellerId(req: Request, requested?: string): string | undefined {
  return resellerScope(req).resellerId ?? requested
}

/** Throws unless the user may act on data owned by `resellerId`. */
export function assertResellerAccess(req: Request, resellerId: string): void {
  const scope = resellerScope(req)
  if (scope.resellerId && scope.resellerId !== resellerId) throw forbidden()
}
