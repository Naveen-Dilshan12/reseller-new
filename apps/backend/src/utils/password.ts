import bcrypt from 'bcryptjs'
import { z } from 'zod'

const BCRYPT_COST = 12

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a number')
  // bcrypt ignores everything after 72 bytes.
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long')

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_COST)

export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash)

/** Compared against when the email is unknown so response timing does not reveal accounts. */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST)
