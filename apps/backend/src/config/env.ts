import dotenv from 'dotenv'
import { z } from 'zod'

import { parseAllowedHosts } from '../middleware/enforce-https.middleware'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4100),
  API_PREFIX: z.string().default('api/v1'),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  /** Force HTTPS - set to 'true' in production behind reverse proxy */
  FORCE_HTTPS: z.string().transform((val) => val === 'true').default('false'),

  /**
   * Comma-separated public hostnames (no scheme, port or path) that the FORCE_HTTPS redirect may send a browser to.
   * A plain-HTTP request for any other Host gets a 400 instead of a redirect. Empty = never redirect.
   */
  ALLOWED_HOSTS: z
    .string()
    .default('')
    .refine((val) => parseAllowedHosts(val).invalid.length === 0, 'must be comma-separated hostnames only (no scheme, port or path)'),

  /** Number of reverse proxies / CDNs between the client and this process (X-Forwarded-For hops to trust). Default 1 = previous behaviour. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  /** In development only: expose current test OTP to secure debug panel */
  OTP_DEBUG_MODE: z.string().transform((val) => val === 'true').default('false'),

  // Email service configuration
  EMAIL_FROM: z.string().default('Hexalyte Innovation <no-reply@hexalyte.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().transform((val) => val === 'true').default('false'),

  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes as 64 hex chars'),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(20).default(5),
  /** Hexalyte bank account customers pay into, shown to resellers on the activation form. */
  COMPANY_BANK_DETAILS: z.string().default(''),

  /** Refund window: approved commissions become payable this many days after the payment was verified. */
  COMMISSION_HOLD_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  /** Timezone used to decide which billing month (YYYY-MM) an event belongs to. */
  BUSINESS_TIMEZONE: z.string().default('Asia/Colombo'),

  INTEGRATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).default(300),

  /** Database connection pool configuration */
  DATABASE_POOL_MIN: z.coerce.number().int().min(1).default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format())
  process.exit(1)
}

if (parsed.data.NODE_ENV === 'production') {
  if (/^0+$/.test(parsed.data.ENCRYPTION_KEY)) {
    console.error('ENCRYPTION_KEY must be set to a random value in production')
    process.exit(1)
  }
  if (parsed.data.JWT_ACCESS_SECRET.startsWith('change-me')) {
    console.error('JWT_ACCESS_SECRET must be set to a random value in production')
    process.exit(1)
  }
}

export const env = parsed.data

export const allowedHosts = parseAllowedHosts(env.ALLOWED_HOSTS).hosts

export const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
