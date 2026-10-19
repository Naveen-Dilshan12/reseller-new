import { Request } from 'express'
import type { Reseller, User } from '@prisma/client'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { AppError, conflict, notFoundError, unauthorized } from '../../middleware/error.middleware'
import { isAccountVerified } from '../../config/account-verification'
import { effectivePermissions, isPlatformRole } from '../../rbac/permissions'
import { randomToken, safeEqual, sha256 } from '../../utils/crypto'

import { signAccessToken } from '../../utils/jwt'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../utils/password'
import { getClientIp, getUserAgent } from '../../utils/request'
import { auditService } from '../audit-logs/audit.service'
import { emailService } from '../email/email.service'
import { smsGatewayService } from '../sms/sms-gateway.service'
import {
  OTP_MAX_ATTEMPTS,
  VerificationError,
  assertSendBudget,
  clearDevOtp,
  issueVerificationCode,
  maskPhone,
  readDevOtp,
} from './verification.service'
import type { ChangePasswordInput, ForgotPasswordInput, LoginInput, RegisterBasicInput, ResendVerificationInput, ResetPasswordInput, VerifyEmailInput } from './auth.schema'

type UserWithReseller = User & { reseller: Pick<Reseller, 'status' | 'rejectionReason'> | null }

const userInclude = { reseller: { select: { status: true, rejectionReason: true } } } as const

/** Blocks inactive users, unverified accounts, and resellers whose application is not approved. */
function assertCanLogin(user: UserWithReseller): void {
  if (user.status !== 'ACTIVE') {
    throw new AppError('Your account is inactive. Contact Hexalyte support.', 403, undefined, 'ACCOUNT_INACTIVE')
  }

  // Non-admin accounts must have completed SMS verification (`phoneVerifiedAt`), proved their email (`emailVerified`),
  // or be a legacy account created before verification was mandatory (see config/account-verification.ts).
  if (!isAccountVerified(user)) {
    throw new AppError(
      user.phone
        ? 'Please verify your phone number to log in. Enter the 6-digit code we sent by SMS.'
        : 'Please verify your email address to log in. Check your inbox for the verification code.',
      403,
      undefined,
      'EMAIL_NOT_VERIFIED',
    )
  }

  if (isPlatformRole(user.role)) return

  // Basic users who have not completed onboarding yet have no reseller association.
  // They are allowed to authenticate so they can view the user dashboard and apply to become a reseller.
  if (!user.resellerId) {
    return
  }

  // Users who have submitted an application are allowed to log in to see their application
  // status card (PENDING / REJECTED) on the dashboard.
  switch (user.reseller?.status) {
    case 'ACTIVE':
    case 'PENDING':
    case 'REJECTED':
      return
    default:
      throw new AppError('Your partner account is suspended. Contact Hexalyte support.', 403, undefined, 'RESELLER_SUSPENDED')
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

/**
 * The welcome popup state is kept in the existing audit log (action + user id, indexed), so no new
 * column is needed. The reseller application's own status stays the source of truth for everything else.
 */
const WELCOME_SHOWN_ACTION = 'RESELLER_WELCOME_SHOWN'

async function hasSeenWelcome(userId: string): Promise<boolean> {
  const count = await prisma.auditLog.count({ where: { entityType: 'User', entityId: userId, action: WELCOME_SHOWN_ACTION } })
  return count > 0
}

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    resellerId: user.resellerId,
    emailVerified: !!user.emailVerified,
    phoneVerified: !!user.phoneVerifiedAt,
  }
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
      include: {
        reseller: {
          select: {
            id: true,
            code: true,
            businessName: true,
            status: true,
            rejectionReason: true,
            createdAt: true,
          },
        },
      },
    })
    return {
      ...publicUser(user),
      // Seller-managed WhatsApp number; stored in the existing nullable User.phone column.
      whatsappNumber: user.phone ?? null,
      // Whether the first-login welcome popup has already been shown (recorded server-side, so it survives logout and other devices).
      welcomeSeen: await hasSeenWelcome(userId),
      reseller: user.reseller,
      // Sellers get no permissions until their reseller application is approved (the API enforces the same rule).
      permissions: effectivePermissions(user.role, user.reseller?.status),
    }
  },

  /** Records, once, that this user has been shown the welcome popup. */
  async markWelcomeShown(req: Request, userId: string) {
    if (!(await hasSeenWelcome(userId))) {
      await auditService.fromRequest(req, { action: WELCOME_SHOWN_ACTION, entityType: 'User', entityId: userId })
    }
    return { welcomeSeen: true }
  },

  /** Saves or replaces the caller's own WhatsApp number. Plain contact data only: no WhatsApp login, token or API. */
  async setWhatsappNumber(req: Request, userId: string, whatsappNumber: string) {
    await prisma.user.update({ where: { id: userId }, data: { phone: whatsappNumber } })
    await auditService.fromRequest(req, { action: 'AUTH_WHATSAPP_NUMBER_SET', entityType: 'User', entityId: userId })
    return { whatsappNumber }
  },

  async removeWhatsappNumber(req: Request, userId: string) {
    await prisma.user.update({ where: { id: userId }, data: { phone: null } })
    await auditService.fromRequest(req, { action: 'AUTH_WHATSAPP_NUMBER_REMOVED', entityType: 'User', entityId: userId })
    return { whatsappNumber: null }
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

  /**
   * Generates a cryptographically secure reset token, saves only sha256(token),
   * and sends an email. Returns a generic success message regardless of whether
   * the email exists (preventing account enumeration).
   */
  async forgotPassword(req: Request, input: ForgotPasswordInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, status: true },
    })

    // If user is not found or inactive, execute constant-time dummy wait and return generic message
    if (!user || user.status !== 'ACTIVE') {
      await verifyPassword('dummy-wait', DUMMY_PASSWORD_HASH)
      return { message: 'If an account exists with that email address, password reset instructions have been sent.' }
    }

    const rawToken = randomToken(32)
    const tokenHash = sha256(rawToken)
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000)

    // Store hashed token in database, invalidating previous unused tokens for this user
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
          ip: getClientIp(req),
          userAgent: getUserAgent(req),
        },
      }),
    ])

    // Generate link using trusted configured frontend URL
    const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(rawToken)}`
    const { html, text } = emailService.createPasswordResetEmail(
      user.name,
      resetUrl,
      env.PASSWORD_RESET_TOKEN_TTL_MINUTES,
    )

    await emailService.sendEmail({
      to: user.email,
      subject: 'Reset Your Hexalyte Innovation Password',
      html,
      text,
    })

    await auditService.fromRequest(req, {
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      actor: { userId: user.id, email: user.email },
    })

    return { message: 'If an account exists with that email address, password reset instructions have been sent.' }
  },

  /**
   * Verifies the reset token, updates the password, and revokes active sessions in a single transaction.
   */
  async resetPassword(req: Request, input: ResetPasswordInput) {
    const tokenHash = sha256(input.token)
    const stored = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    })

    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw new AppError('The password reset link is invalid or has expired. Please request a new one.', 400, undefined, 'INVALID_RESET_TOKEN')
    }

    const newHash = await hashPassword(input.newPassword)

    await prisma.$transaction([
      // Mark token as used
      prisma.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      // Invalidate any other outstanding reset tokens for this user
      prisma.passwordResetToken.updateMany({
        where: { userId: stored.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
      // Update password hash and clear any failed login lockouts
      prisma.user.update({
        where: { id: stored.userId },
        data: {
          passwordHash: newHash,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      // Revoke all existing refresh token sessions
      prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])

    await auditService.fromRequest(req, {
      action: 'AUTH_PASSWORD_RESET_COMPLETED',
      entityType: 'User',
      entityId: stored.userId,
      actor: { userId: stored.userId, email: stored.user.email },
    })

    return { message: 'Your password has been successfully reset. You can now log in.' }
  },

  /**
   * Registers a basic user account without creating a reseller record. The account is created inactive-for-login
   * (no verification fields set) and a single-use 6-digit code is sent by SMS to the submitted phone number;
   * login stays blocked until the code is verified, so the SMS step cannot be skipped by calling the API directly.
   * Email is plain account information and is not verified.
   */
  async registerBasic(req: Request, input: RegisterBasicInput) {
    if (!(await smsGatewayService.isReady())) {
      throw new AppError('SMS verification is temporarily unavailable. Please try again later.', 503, undefined, 'SMS_UNAVAILABLE')
    }

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    })
    if (existing) {
      throw conflict('An account with this email address already exists')
    }
    // Only a number verified by SMS blocks it (contact/WhatsApp numbers in `phone` never do), so an unverified sign-up cannot squat a phone.
    const phoneTaken = await prisma.user.findFirst({ where: { verifiedPhone: input.phone }, select: { id: true } })
    if (phoneTaken) {
      throw conflict('An account with this phone number already exists')
    }
    // Early, non-authoritative check; the binding one runs inside issueVerificationCode's lock.
    await assertSendBudget({ phone: input.phone })

    const passwordHash = await hashPassword(input.password)
    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        phone: input.phone,
        passwordHash,
        role: 'SELLER',
        status: 'ACTIVE',
        resellerId: null,
        emailVerified: null,
      },
    })

    let delivery: { sent: true } | { sent: false; reason: 'gateway_disabled' | 'send_failed' } = { sent: true }
    try {
      await issueVerificationCode(req, user)
    } catch (err) {
      if (!(err instanceof VerificationError) || !err.reserved) {
        // Refused before any code was reserved (limit reached, bad state): nothing was issued, so remove the new account and let them retry.
        await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
        throw err
      }
      // A code was reserved but delivery failed or is uncertain (timeout). KEEP the account: it stays blocked at login,
      // its attempt keeps counting toward every limit, and the user can request a new code from the verification page.
      delivery = { sent: false, reason: err.code === 'SMS_UNAVAILABLE' ? 'gateway_disabled' : 'send_failed' }
    }

    await auditService.fromRequest(req, {
      action: 'AUTH_REGISTER_BASIC',
      entityType: 'User',
      entityId: user.id,
      metadata: { codeSent: delivery.sent },
      actor: { userId: user.id, email: user.email },
    })

    return {
      message: delivery.sent
        ? `Registration successful. A 6-digit verification code has been sent by SMS to ${maskPhone(input.phone)}.`
        : 'Your account was created, but we could not send the verification SMS. Open the verification page and request a new code in a minute; you cannot sign in until your number is verified.',
      email: user.email,
      phoneMasked: maskPhone(input.phone),
      codeSent: delivery.sent,
      ...(delivery.sent ? {} : { reason: delivery.reason }),
    }
  },

  /**
   * Verifies the account using the 6-digit numeric OTP sent by SMS (or by email for older accounts that have no phone).
   * Enforces 10-minute expiry, a 5-attempt limit counted atomically, and single use. An SMS code sets
   * `phoneVerifiedAt` + `verifiedPhone`; an emailed code (accounts without a phone) sets `emailVerified`.
   */
  async verifyEmail(req: Request, input: VerifyEmailInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, phone: true, role: true, status: true, emailVerified: true, phoneVerifiedAt: true, createdAt: true },
    })

    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('Invalid email address or verification code.', 400, undefined, 'INVALID_OTP')
    }

    if (isAccountVerified(user)) {
      return { message: 'Your account is already verified. You can log in.' }
    }

    // Find the latest active (unused) OTP for this user
    const stored = await prisma.emailVerificationToken.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    })

    if (!stored) {
      throw new AppError('No active verification code found. Please request a new one.', 400, undefined, 'NO_ACTIVE_OTP')
    }

    const invalidate = () => prisma.emailVerificationToken.updateMany({ where: { id: stored.id, usedAt: null }, data: { usedAt: new Date() } })

    if (stored.expiresAt < new Date()) {
      await invalidate()
      clearDevOtp(user.email)
      throw new AppError('Your verification code has expired. Please request a new one.', 400, undefined, 'OTP_EXPIRED')
    }

    // Count this guess before comparing, atomically, so parallel requests cannot get more than OTP_MAX_ATTEMPTS tries.
    const counted = await prisma.emailVerificationToken.update({
      where: { id: stored.id },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    })
    if (counted.failedAttempts > OTP_MAX_ATTEMPTS) {
      await invalidate()
      clearDevOtp(user.email)
      throw new AppError('Too many incorrect attempts. This code has been invalidated. Please request a new code.', 400, undefined, 'TOO_MANY_ATTEMPTS')
    }

    // Validate OTP hash using constant-time comparison
    if (!safeEqual(sha256(input.otp), stored.tokenHash)) {
      if (counted.failedAttempts >= OTP_MAX_ATTEMPTS) {
        await invalidate()
        clearDevOtp(user.email)
        throw new AppError('Too many incorrect attempts. This code has been invalidated. Please request a new code.', 400, undefined, 'TOO_MANY_ATTEMPTS')
      }
      const remaining = OTP_MAX_ATTEMPTS - counted.failedAttempts
      throw new AppError(`Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`, 400, undefined, 'INVALID_OTP')
    }

    // A code sent by SMS proves control of the phone only; a code sent by email (accounts with no phone) proves the email.
    // They are recorded separately: SMS verification never sets `emailVerified`.
    const bySms = !!user.phone
    const proof = bySms
      ? { phoneVerifiedAt: new Date(), verifiedPhone: user.phone }
      : { emailVerified: new Date() }

    if (bySms) {
      // Someone else may have verified this number while this account was waiting.
      const owner = await prisma.user.findFirst({ where: { verifiedPhone: user.phone, id: { not: user.id } }, select: { id: true } })
      if (owner) {
        await invalidate()
        throw conflict('An account with this phone number already exists')
      }
    }

    // One-time use: only the request that flips usedAt may verify the account.
    let verified: boolean
    try {
      verified = await prisma.$transaction(async (tx) => {
        const claimed = await tx.emailVerificationToken.updateMany({ where: { id: stored.id, usedAt: null }, data: { usedAt: new Date() } })
        if (claimed.count !== 1) return false
        await tx.user.update({ where: { id: user.id }, data: proof })
        return true
      })
    } catch (err) {
      // Two accounts verifying the same number at once: the unique index lets exactly one win.
      if ((err as { code?: string })?.code === 'P2002') {
        await invalidate()
        throw conflict('An account with this phone number already exists')
      }
      throw err
    }
    if (!verified) {
      throw new AppError('This verification code has already been used.', 400, undefined, 'INVALID_OTP')
    }

    clearDevOtp(user.email)

    await auditService.fromRequest(req, {
      action: user.phone ? 'AUTH_PHONE_VERIFIED' : 'AUTH_EMAIL_VERIFIED',
      entityType: 'User',
      entityId: user.id,
      actor: { userId: user.id, email: user.email },
    })

    return { message: 'Your account has been verified. You can now log in.' }
  },

  /**
   * Resends a 6-digit verification OTP with a 60-second cooldown and an hourly cap.
   */
  async resendVerification(req: Request, input: ResendVerificationInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, phone: true, role: true, status: true, emailVerified: true, phoneVerifiedAt: true, createdAt: true },
    })
    const generic = { message: 'If an unverified account exists with that email, a verification code has been sent.' }

    // If user does not exist or is already verified, return generic success to prevent account enumeration
    if (!user || user.status !== 'ACTIVE' || isAccountVerified(user)) {
      return generic
    }

    // Cooldown, hourly limits and the daily cap are all enforced atomically inside issueVerificationCode.
    await issueVerificationCode(req, user, { cooldown: true })

    await auditService.fromRequest(req, {
      action: 'AUTH_VERIFICATION_CODE_RESENT',
      entityType: 'User',
      entityId: user.id,
      actor: { userId: user.id, email: user.email },
    })

    return generic
  },

  /**
   * Secure, development-only accessor for test OTPs.
   * Throws 404 in production or when OTP_DEBUG_MODE is disabled.
   */
  getDevOtp(email: string) {
    if (env.NODE_ENV === 'production' || !env.OTP_DEBUG_MODE) {
      throw notFoundError('Debug OTP endpoint')
    }
    const cleanEmail = email.trim().toLowerCase()
    const entry = readDevOtp(cleanEmail)
    if (!entry || entry.expiresAt < Date.now()) {
      return { debugMode: true, otp: null }
    }
    return { debugMode: true, otp: entry.otp }
  },
}

export { recordDevOtp, clearDevOtp } from './verification.service'
