import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { verifyAccessToken, JwtPayload } from '../utils/jwt'
import { hasPermission, isPlatformRole, type Permission } from '../rbac/permissions'
import { forbidden, unauthorized } from './error.middleware'

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}

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
      select: { id: true, email: true, role: true, status: true, resellerId: true, reseller: { select: { status: true } } },
    })
    if (!user || user.status !== 'ACTIVE') return next(unauthorized('Account is inactive'))
    if (!isPlatformRole(user.role) && user.reseller?.status !== 'ACTIVE') {
      return next(forbidden('Reseller account is not active'))
    }
    req.user = { userId: user.id, email: user.email, role: user.role, resellerId: user.resellerId }
    next()
  } catch (err) {
    next(err)
  }
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized())
    const allowed = permissions.every((p) => hasPermission(req.user!.role, p))
    next(allowed ? undefined : forbidden('Insufficient permissions'))
  }
}

export function currentUser(req: Request): JwtPayload {
  if (!req.user) throw unauthorized()
  return req.user
}

/** Prisma `where` fragment restricting reseller users to their own reseller's rows. */
export function resellerScope(req: Request): { resellerId?: string } {
  const user = currentUser(req)
  if (isPlatformRole(user.role)) return {}
  if (!user.resellerId) throw forbidden('User is not linked to a reseller')
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
