import { Request } from 'express'
import type { Reseller, User } from '@prisma/client'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { AppError, unauthorized } from '../../middleware/error.middleware'
import { isPlatformRole, permissionsFor } from '../../rbac/permissions'
import { randomToken, sha256 } from '../../utils/crypto'
import { signAccessToken } from '../../utils/jwt'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../utils/password'
import { getClientIp, getUserAgent } from '../../utils/request'
import { auditService } from '../audit-logs/audit.service'
import type { ChangePasswordInput, LoginInput } from './auth.schema'

type UserWithReseller = User & { reseller: Pick<Reseller, 'status' | 'rejectionReason'> | null }

const userInclude = { reseller: { select: { status: true, rejectionReason: true } } } as const

/** Blocks inactive users and resellers whose application is not approved. */
function assertCanLogin(user: UserWithReseller): void {
  if (user.status !== 'ACTIVE') {
    throw new AppError('Your account is inactive. Contact Hexalyte support.', 403, undefined, 'ACCOUNT_INACTIVE')
  }
  if (isPlatformRole(user.role)) return

  switch (user.reseller?.status) {
    case 'ACTIVE':
      return
    case 'PENDING':
      throw new AppError(
        'Your reseller application is pending approval. You can log in once it has been approved.',
        403,
        undefined,
        'APPLICATION_PENDING',
      )
    case 'REJECTED':
      throw new AppError(
        `Your reseller application was rejected.${user.reseller.rejectionReason ? ` Reason: ${user.reseller.rejectionReason}` : ''}`,
        403,
        undefined,
        'APPLICATION_REJECTED',
      )
    default:
      throw new AppError('Your reseller account is suspended. Contact Hexalyte support.', 403, undefined, 'RESELLER_SUSPENDED')
  }
}

async function issueTokens(req: Request, user: User) {
  const refreshToken = randomToken()
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    },
  })
  const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role, resellerId: user.resellerId })
  return { accessToken, refreshToken }
}

function publicUser(user: User) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, resellerId: user.resellerId }
}

export const authService = {
  async login(req: Request, input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email }, include: userInclude })

    if (!user) {
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH)
      throw unauthorized('Invalid email or password')
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH)
      throw new AppError('Too many failed attempts. Try again later.', 423, undefined, 'ACCOUNT_LOCKED')
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      const attempts = user.failedLoginCount + 1
      const lock = attempts >= env.LOGIN_MAX_ATTEMPTS
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : attempts,
          lockedUntil: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60 * 1000) : undefined,
        },
      })
      await auditService.fromRequest(req, {
        action: lock ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        resellerId: user.resellerId,
        actor: { userId: user.id, email: user.email },
      })
      throw unauthorized('Invalid email or password')
    }

    try {
      assertCanLogin(user)
    } catch (err) {
      await auditService.fromRequest(req, {
        action: 'AUTH_LOGIN_BLOCKED',
        entityType: 'User',
        entityId: user.id,
        resellerId: user.resellerId,
        metadata: { reason: err instanceof AppError ? (err.code ?? err.message) : 'unknown' },
        actor: { userId: user.id, email: user.email },
      })
      throw err
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    })
    await auditService.fromRequest(req, {
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      resellerId: user.resellerId,
      actor: { userId: user.id, email: user.email },
    })

    return { ...(await issueTokens(req, user)), user: publicUser(user) }
  },

  /** Rotates the refresh token. Reuse of a revoked token revokes every session of that user. */
  async refresh(req: Request, refreshToken: string) {
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: { include: userInclude } },
    })
    if (!stored) throw unauthorized('Invalid refresh token')

    const reused = async () => {
      await prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } })
      await auditService.fromRequest(req, {
        action: 'AUTH_REFRESH_TOKEN_REUSED',
        entityType: 'User',
        entityId: stored.userId,
        actor: { userId: stored.userId, email: stored.user.email },
      })
      return unauthorized('Invalid refresh token')
    }

    if (stored.revokedAt) throw await reused()
    if (stored.expiresAt < new Date()) throw unauthorized('Refresh token expired')

    assertCanLogin(stored.user)

    // Only one concurrent refresh with the same token may win the rotation.
    const claimed = await prisma.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } })
    if (claimed.count === 0) throw await reused()
    return { ...(await issueTokens(req, stored.user)), user: publicUser(stored.user) }
  },

  async logout(req: Request, refreshToken?: string) {
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(refreshToken), userId: req.user?.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }
    await auditService.fromRequest(req, { action: 'AUTH_LOGOUT', entityType: 'User', entityId: req.user?.userId })
  },

  async me(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { reseller: { select: { id: true, code: true, businessName: true, status: true } } },
    })
    return { ...publicUser(user), reseller: user.reseller, permissions: permissionsFor(user.role) }
  },

  async changePassword(req: Request, userId: string, input: ChangePasswordInput) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError('Current password is incorrect', 400)
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.newPassword) } }),
      prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])
    await auditService.fromRequest(req, { action: 'AUTH_PASSWORD_CHANGED', entityType: 'User', entityId: userId })
  },
}
