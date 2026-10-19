import type { Request } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { AppError } from '../../middleware/error.middleware'
import { decryptSecret, encryptSecret } from '../../utils/crypto'
import { logger } from '../../utils/logger'
import { normalizeSmsPhone } from '../../utils/phone'
import { auditService } from '../audit-logs/audit.service'

/**
 * SMSlenz gateway (https://www.smslenz.lk/developers/api). The credentials live in one encrypted
 * PlatformSetting row (AES-256-GCM with ENCRYPTION_KEY, the same key that protects bank slips), never
 * in .env, the browser or the logs. Only the admin API below ever sees them, and it returns a masked view.
 */

export const SMS_GATEWAY_SETTING_KEY = 'SMS_GATEWAY_CONFIG'
export const SMSLENZ_SEND_URL = 'https://www.smslenz.lk/api/send-sms'
const REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_SMS_DAILY_LIMIT = 500
export const SMS_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Verification codes issued in the last 24 hours: ONE token row per attempt, created when the code is reserved, so
 * failed and uncertain (timed-out) deliveries count and the number does not depend on a user's current WhatsApp/contact
 * phone. Test SMS create no row and are not counted.
 * Limitation: the table has no delivery-channel column, so the rare emailed code (an account without a phone number) is
 * counted too. That over-counts slightly and never under-counts; a `channel` column would be needed to separate them.
 */
export function countRecentOtpSms(db: Pick<Prisma.TransactionClient, 'emailVerificationToken'> = prisma): Promise<number> {
  return db.emailVerificationToken.count({
    where: { createdAt: { gte: new Date(Date.now() - SMS_DAILY_WINDOW_MS) } },
  })
}

export type SmsErrorCode =
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'INVALID_CREDENTIALS'
  | 'INSUFFICIENT_CREDIT'
  | 'INVALID_NUMBER'
  | 'INVALID_SENDER'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROVIDER_ERROR'

/** Fixed, safe messages: the provider's own text is never passed on (it could echo credentials or numbers). */
const SMS_ERROR_MESSAGES: Record<SmsErrorCode, string> = {
  NOT_CONFIGURED: 'The SMS gateway is not configured.',
  DISABLED: 'The SMS gateway is disabled.',
  INVALID_CREDENTIALS: 'SMSlenz rejected the User ID or API key.',
  INSUFFICIENT_CREDIT: 'The SMSlenz account has insufficient SMS credit.',
  INVALID_NUMBER: 'SMSlenz rejected the destination phone number.',
  INVALID_SENDER: 'SMSlenz rejected the Sender ID.',
  RATE_LIMITED: 'SMSlenz is rate limiting requests. Try again shortly.',
  TIMEOUT: 'SMSlenz did not respond in time.',
  NETWORK: 'Could not reach SMSlenz.',
  PROVIDER_ERROR: 'SMSlenz could not send the message.',
}

export class SmsSendError extends Error {
  constructor(public readonly code: SmsErrorCode) {
    super(SMS_ERROR_MESSAGES[code])
    this.name = 'SmsSendError'
  }
}

interface StoredConfig {
  provider: 'SMSLENZ'
  userId: string
  apiKey: string
  senderId: string
  enabled: boolean
  /** Maximum OTP SMS per rolling 24 hours, all users together. Absent in older saved configs = the default. */
  dailyLimit?: number
  updatedAt: string
  updatedById: string | null
  lastTest: { at: string; ok: boolean; code: SmsErrorCode | null } | null
}

async function loadConfig(): Promise<StoredConfig | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SMS_GATEWAY_SETTING_KEY } })
  if (!row) return null
  try {
    return JSON.parse(decryptSecret(row.value)) as StoredConfig
  } catch {
    // Wrong/rotated ENCRYPTION_KEY or a damaged row: treat as unconfigured rather than crash. Re-saving fixes it.
    logger.error('SMS gateway configuration could not be decrypted')
    return null
  }
}

async function saveConfig(config: StoredConfig): Promise<void> {
  const value = encryptSecret(JSON.stringify(config))
  await prisma.platformSetting.upsert({
    where: { key: SMS_GATEWAY_SETTING_KEY },
    create: { key: SMS_GATEWAY_SETTING_KEY, value, updatedById: config.updatedById },
    update: { value, updatedById: config.updatedById },
  })
}

const maskKey = (key: string) => `${'•'.repeat(8)}${key.length >= 12 ? key.slice(-4) : ''}`

function isComplete(c: StoredConfig | null): c is StoredConfig {
  return !!c && !!c.userId && !!c.apiKey && !!c.senderId
}

/** What the admin UI may see. Never contains the API key. */
function publicView(c: StoredConfig | null, usage24h = 0) {
  const status = !isComplete(c) ? 'NOT_CONFIGURED' : c.enabled ? 'READY' : 'DISABLED'
  return {
    provider: 'SMSLENZ' as const,
    status,
    enabled: !!c?.enabled,
    dailyLimit: c?.dailyLimit ?? DEFAULT_SMS_DAILY_LIMIT,
    usage24h,
    userId: c?.userId ?? '',
    senderId: c?.senderId ?? '',
    apiKeyConfigured: !!c?.apiKey,
    apiKeyMasked: c?.apiKey ? maskKey(c.apiKey) : null,
    updatedAt: c?.updatedAt ?? null,
    lastTest: c?.lastTest ?? null,
  }
}

function classify(httpStatus: number, message: string): SmsErrorCode {
  if (httpStatus === 401 || httpStatus === 403) return 'INVALID_CREDENTIALS'
  if (httpStatus === 402) return 'INSUFFICIENT_CREDIT'
  if (httpStatus === 429) return 'RATE_LIMITED'
  const m = message.toLowerCase()
  if (/credit|balance|insufficient|funds/.test(m)) return 'INSUFFICIENT_CREDIT'
  if (/api.?key|user.?id|credential|unauthori[sz]ed|authenticat|invalid user|suspend/.test(m)) return 'INVALID_CREDENTIALS'
  if (/sender/.test(m)) return 'INVALID_SENDER'
  if (/contact|number|recipient|phone|msisdn/.test(m)) return 'INVALID_NUMBER'
  return 'PROVIDER_ERROR'
}

/**
 * One request to SMSlenz. `contact` must be a Sri Lankan mobile number; it is re-validated here (callers validate their
 * input too) so no other path can send to an arbitrary or foreign destination. Throws SmsSendError, never leaks the
 * provider's text, and makes no request at all for an invalid destination.
 */
async function deliver(config: StoredConfig, rawContact: string, message: string): Promise<void> {
  const contact = normalizeSmsPhone(rawContact)
  if (!contact) throw new SmsSendError('INVALID_NUMBER')

  let res: Response
  try {
    res = await fetch(SMSLENZ_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user_id: config.userId, api_key: config.apiKey, sender_id: config.senderId, contact, message }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const name = (err as { name?: string })?.name
    throw new SmsSendError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK')
  }

  type ProviderBody = { success?: unknown; message?: unknown; data?: { status?: unknown } }
  const body: ProviderBody | null = await (res.json() as Promise<ProviderBody>).catch(() => null)
  const providerMessage = typeof body?.message === 'string' ? body.message : ''

  if (res.ok && body?.success === true && (body.data?.status === undefined || body.data.status === 'success')) return
  const code = classify(res.status, providerMessage)
  logger.warn('SMSlenz send failed', { httpStatus: res.status, smsErrorCode: code })
  throw new SmsSendError(code)
}

export const smsGatewayService = {
  /** Masked configuration for the admin page. */
  async getPublicConfig() {
    return publicView(await loadConfig(), await countRecentOtpSms())
  },

  /** The configured daily OTP cap (default 500). */
  async getDailyLimit(): Promise<number> {
    return (await loadConfig())?.dailyLimit ?? DEFAULT_SMS_DAILY_LIMIT
  },

  /**
   * Saves the gateway settings. The API key is only replaced when `apiKey` is given (the caller's explicit
   * "update API key" choice); otherwise the stored key is kept untouched and never leaves the server.
   */
  async updateConfig(req: Request, input: { userId: string; senderId: string; enabled: boolean; dailyLimit: number; apiKey?: string }) {
    const before = await loadConfig()
    const apiKey = input.apiKey ?? before?.apiKey
    if (!apiKey) throw new AppError('Enter the API key to save the gateway.', 422, ['apiKey: API key is required'])

    const next: StoredConfig = {
      provider: 'SMSLENZ',
      userId: input.userId,
      apiKey,
      senderId: input.senderId,
      enabled: input.enabled,
      dailyLimit: input.dailyLimit,
      updatedAt: new Date().toISOString(),
      updatedById: req.user!.userId,
      // New credentials invalidate the previous test result.
      lastTest: input.apiKey || before?.userId !== input.userId || before?.senderId !== input.senderId ? null : (before?.lastTest ?? null),
    }
    await saveConfig(next)
    await auditService.fromRequest(req, {
      action: 'SETTINGS_SMS_GATEWAY_UPDATED',
      entityType: 'PlatformSetting',
      entityId: SMS_GATEWAY_SETTING_KEY,
      // Never the key itself, only that it was replaced.
      metadata: {
        provider: 'SMSLENZ',
        enabled: { before: before?.enabled ?? false, after: next.enabled },
        senderId: { before: before?.senderId ?? null, after: next.senderId },
        dailyLimit: { before: before?.dailyLimit ?? DEFAULT_SMS_DAILY_LIMIT, after: next.dailyLimit },
        userIdChanged: before?.userId !== next.userId,
        credentialRotated: !!input.apiKey,
      },
    })
    return publicView(next, await countRecentOtpSms())
  },

  /** Sends one explicit test (not counted against the daily OTP cap; it has its own admin rate limit) SMS with the saved credentials (works while the gateway is disabled, so it can be checked before enabling). */
  async sendTest(req: Request, contact: string) {
    const config = await loadConfig()
    if (!isComplete(config)) throw new AppError(SMS_ERROR_MESSAGES.NOT_CONFIGURED, 409, undefined, 'SMS_NOT_CONFIGURED')

    let code: SmsErrorCode | null = null
    try {
      await deliver(config, contact, 'Hexalyte SMS gateway test. If you received this message, the gateway is working.')
    } catch (err) {
      code = err instanceof SmsSendError ? err.code : 'PROVIDER_ERROR'
    }
    await saveConfig({ ...config, lastTest: { at: new Date().toISOString(), ok: code === null, code } })
    await auditService.fromRequest(req, {
      action: code ? 'SETTINGS_SMS_GATEWAY_TEST_FAILED' : 'SETTINGS_SMS_GATEWAY_TEST_SENT',
      entityType: 'PlatformSetting',
      entityId: SMS_GATEWAY_SETTING_KEY,
      metadata: { result: code ?? 'OK' },
    })
    if (code) throw new AppError(SMS_ERROR_MESSAGES[code], code === 'RATE_LIMITED' ? 429 : 502, undefined, `SMS_${code}`)
    return publicView((await loadConfig()) ?? config, await countRecentOtpSms())
  },

  /** True when OTP messages can currently be sent. */
  async isReady(): Promise<boolean> {
    const c = await loadConfig()
    return isComplete(c) && c.enabled
  },

  /** Sends a message through the enabled gateway. Throws SmsSendError. */
  async send(contact: string, message: string): Promise<void> {
    const config = await loadConfig()
    if (!isComplete(config)) throw new SmsSendError('NOT_CONFIGURED')
    if (!config.enabled) throw new SmsSendError('DISABLED')
    await deliver(config, contact, message)
  },
}
