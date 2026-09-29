import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4100),
  API_PREFIX: z.string().default('api/v1'),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

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
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format())
  process.exit(1)
}

if (parsed.data.NODE_ENV === 'production' && /^0+$/.test(parsed.data.ENCRYPTION_KEY)) {
  console.error('ENCRYPTION_KEY must be set to a random value in production')
  process.exit(1)
}

export const env = parsed.data

export const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
