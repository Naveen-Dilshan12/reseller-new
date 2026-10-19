import type { Request } from 'express'
import type { Prisma, User } from '@prisma/client'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { AppError } from '../../middleware/error.middleware'
import { generateNumericOtp, sha256 } from '../../utils/crypto'
import { getClientIp, getUserAgent } from '../../utils/request'
import { emailService } from '../email/email.service'
import { countRecentOtpSms, SmsSendError, smsGatewayService } from '../sms/sms-gateway.service'

export const OTP_TTL_MINUTES = 10
export const OTP_MAX_ATTEMPTS = 5
export const OTP_RESEND_COOLDOWN_SECONDS = 60
/** At most this many codes per account, and per phone number, per hour (also limits SMS credit abuse). */
export const OTP_MAX_SENDS_PER_HOUR = 5
/** Constant key of the Postgres advisory lock that serialises reservations against the global daily SMS cap. */
const SMS_CAP_LOCK_SQL = 'SELECT pg_advisory_xact_lock(7305001)'

// Ephemeral in-memory development store for test OTPs
// Only populated when env.NODE_ENV !== 'production' && env.OTP_DEBUG_MODE
const devOtpStore = new Map<string, { otp: string; expiresAt: number }>()

export function recordDevOtp(email: string, otp: string, ttlMs: number = OTP_TTL_MINUTES * 60 * 1000): void {
  if (env.NODE_ENV === 'production' || !env.OTP_DEBUG_MODE) return
  devOtpStore.set(email.trim().toLowerCase(), { otp, expiresAt: Date.now() + ttlMs })
}

export function clearDevOtp(email: string): void {
  devOtpStore.delete(email.trim().toLowerCase())
}

export function readDevOtp(email: string): { otp: string; expiresAt: number } | undefined {
  return devOtpStore.get(email.trim().toLowerCase())
}

export const maskPhone = (phone: string) => `${phone.slice(0, 3)} ••• ••${phone.slice(-4)}`

type TokenDb = Pick<Prisma.TransactionClient, 'emailVerificationToken'>

/** Thrown by `issueVerificationCode`. `reserved` = a token row already exists (so the attempt counts toward every limit). */
export class VerificationError extends AppError {
  constructor(message: string, statusCode: number, code: string, public readonly reserved: boolean) {
    super(message, statusCode, undefined, code)
    this.name = 'VerificationError'
  }
}

/**
 * Resend cooldown, measured from the newest code of the account INCLUDING codes whose delivery failed.
 * Authoritative only when called inside `issueVerificationCode`'s locked transaction.
 */
async function assertResendCooldown(db: TokenDb, userId: string) {
  const latest = await db.emailVerificationToken.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  if (!latest) return
  const elapsed = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000)
  if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
    const wait = OTP_RESEND_COOLDOWN_SECONDS - elapsed
    throw new AppError(`Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`, 429, undefined, 'RESEND_COOLDOWN')
  }
}

/**
 * Rejects when too many codes were already issued in the last hour for this account and/or phone number.
 * Called without `db` it is only a fast, non-authoritative early check; the authoritative call is inside the lock.
 */
export async function assertSendBudget(scope: { userId?: string; phone?: string | null }, db: TokenDb = prisma) {
  const since = new Date(Date.now() - 60 * 60 * 1000)
  const counts = await Promise.all([
    scope.userId ? db.emailVerificationToken.count({ where: { userId: scope.userId, createdAt: { gte: since } } }) : 0,
    scope.phone ? db.emailVerificationToken.count({ where: { user: { phone: scope.phone }, createdAt: { gte: since } } }) : 0,
  ])
  if (counts.some((c) => c >= OTP_MAX_SENDS_PER_HOUR)) {
    throw new AppError('Too many verification codes requested. Please try again later.', 429, undefined, 'OTP_SEND_LIMIT')
  }
}

/**
 * Creates a fresh single-use code (only its SHA-256 is stored, older codes are invalidated) and delivers it:
 * by SMS to the account's phone, or by email for accounts that have no phone.
 *
 * Every limit is enforced inside ONE transaction guarded by a single global advisory lock (so there is exactly one
 * lock and no lock-ordering/deadlock risk): resend cooldown (when `cooldown`), per-account and per-number hourly caps,
 * and the global daily SMS cap. The new token row is inserted in that same transaction and is the reservation; the SMS
 * goes out after commit. Concurrent requests therefore cannot bypass any limit, and nothing is sent once one is hit.
 *
 * If delivery then fails or is uncertain (timeout), the code is invalidated but its row is KEPT, so the attempt keeps
 * counting toward the cooldown, the hourly caps and the daily cap. A `VerificationError` with `reserved: true` is thrown.
 * Errors thrown before the reservation are plain `AppError`s and leave no row. The code is never logged.
 */
export async function issueVerificationCode(
  req: Request,
  user: Pick<User, 'id' | 'email' | 'name' | 'phone'>,
  opts: { cooldown?: boolean } = {},
) {
  const viaSms = !!user.phone
  const dailyLimit = viaSms ? await smsGatewayService.getDailyLimit() : 0

  const rawOtp = generateNumericOtp()
  const token = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(SMS_CAP_LOCK_SQL)
    if (opts.cooldown) await assertResendCooldown(tx, user.id)
    await assertSendBudget({ userId: user.id, phone: user.phone }, tx)
    if (viaSms && (await countRecentOtpSms(tx)) >= dailyLimit) {
      throw new AppError('SMS verification is temporarily unavailable. Please try again later.', 503, undefined, 'SMS_DAILY_LIMIT')
    }
    await tx.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } })
    return tx.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(rawOtp),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
        failedAttempts: 0,
        ip: getClientIp(req),
        userAgent: getUserAgent(req),
      },
    })
  })

  try {
    if (user.phone) {
      await smsGatewayService.send(
        user.phone,
        `Your Hexalyte verification code is ${rawOtp}. It expires in ${OTP_TTL_MINUTES} minutes. Do not share this code with anyone.`,
      )
    } else {
      const { html, text } = emailService.createEmailVerificationOtpEmail(user.name, rawOtp, OTP_TTL_MINUTES)
      await emailService.sendEmail({ to: user.email, subject: 'Your Verification Code - Hexalyte Central Partner Platform', html, text })
    }
  } catch (err) {
    // Keep the row (it still counts); only make the code unusable.
    await prisma.emailVerificationToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }).catch(() => undefined)
    if (err instanceof SmsSendError) {
      const unavailable = err.code === 'NOT_CONFIGURED' || err.code === 'DISABLED'
      throw new VerificationError(
        unavailable ? 'SMS verification is temporarily unavailable. Please try again later.' : 'We could not send the verification SMS. Please check the number and try again.',
        unavailable ? 503 : 502,
        unavailable ? 'SMS_UNAVAILABLE' : 'SMS_SEND_FAILED',
        true,
      )
    }
    throw new VerificationError('We could not send the verification code. Please try again.', 502, 'OTP_SEND_FAILED', true)
  }

  if (env.NODE_ENV !== 'production' && env.OTP_DEBUG_MODE) {
    recordDevOtp(user.email, rawOtp)
  }
}

export type InitialCodeOutcome =
  | { sent: true; phoneMasked: string | null }
  | { sent: false; reason: 'gateway_disabled' | 'daily_limit' | 'rate_limited' | 'send_failed' }

/**
 * Best-effort first code for an account created outside /auth/register (the public /reseller-registration route).
 * Never throws: the caller reports exactly what happened, and never claims an SMS that was not sent.
 */
export async function trySendInitialCode(req: Request, user: Pick<User, 'id' | 'email' | 'name' | 'phone'>): Promise<InitialCodeOutcome> {
  try {
    await issueVerificationCode(req, user)
    return { sent: true, phoneMasked: user.phone ? maskPhone(user.phone) : null }
  } catch (err) {
    const code = err instanceof AppError ? err.code : undefined
    if (code === 'SMS_UNAVAILABLE') return { sent: false, reason: 'gateway_disabled' }
    if (code === 'SMS_DAILY_LIMIT') return { sent: false, reason: 'daily_limit' }
    if (code === 'OTP_SEND_LIMIT') return { sent: false, reason: 'rate_limited' }
    return { sent: false, reason: 'send_failed' }
  }
}
