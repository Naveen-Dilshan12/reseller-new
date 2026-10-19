import { z } from 'zod'
import { passwordSchema } from '../../utils/password'
import { smsPhoneField } from '../settings/settings.schema'
import { INTERNATIONAL_PHONE_MESSAGE, normalizeInternationalPhone } from '../../utils/phone'

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(200),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
})

/** The Seller's own WhatsApp number: stored as plain contact data, normalised to +<country code><number>. */
export const whatsappNumberSchema = z
  .object({
    whatsappNumber: z
      .string({ required_error: 'WhatsApp number is required' })
      .max(40, INTERNATIONAL_PHONE_MESSAGE)
      .transform((value, ctx) => {
        const normalized = normalizeInternationalPhone(value)
        if (!normalized) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: INTERNATIONAL_PHONE_MESSAGE })
          return z.NEVER
        }
        return normalized
      }),
  })
  .strict()

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(20, 'Invalid reset token').max(250),
  newPassword: passwordSchema,
})

export const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
  otp: z.string().trim().regex(/^\d{6}$/, 'Verification code must be exactly 6 digits'),
})

export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
})

export const registerBasicSchema = z
  .object({
    name: z.string().trim().min(2, 'Full name is required').max(150),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(150),
    phone: smsPhoneField,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms and conditions' }) }),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })

const stripSeparators = (s: string) => s.replace(/[\s-]/g, '')
const text = (label: string, min = 2, max = 150) =>
  z.string({ required_error: `${label} is required` }).trim().min(min, `${label} is required`).max(max)
const emailField = z.string().trim().toLowerCase().email('Enter a valid email address').max(150)
const mobileField = z
  .string()
  .transform(stripSeparators)
  .pipe(z.string().regex(/^(\+94|0)7\d{8}$/, 'Enter a valid mobile number, e.g. 0771234567'))
  .transform((s) => `+94${s.slice(-9)}`)
const phoneField = z
  .string()
  .transform(stripSeparators)
  .pipe(z.string().regex(/^(\+94|0)\d{9}$/, 'Enter a valid phone number, e.g. 0112345678'))
  .transform((s) => `+94${s.slice(-9)}`)
const nicOrPassportField = z
  .string()
  .transform((s) => stripSeparators(s).toUpperCase())
  .pipe(z.string().regex(/^(\d{9}[VX]|\d{12}|[A-Z][A-Z0-9]{5,11})$/, 'Enter a valid NIC or passport number'))

export const resellerOnboardingSchema = z.object({
  personal: z.object({
    fullName: text('Full name', 3, 150),
    nicOrPassport: nicOrPassportField,
    email: emailField,
    mobile: mobileField,
    address: text('Address', 5, 300),
  }),
  business: z.object({
    businessName: text('Business name', 2, 150),
    businessRegistrationNo: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9 /-]{2,29}$/, 'Enter a valid business registration number'),
    businessAddress: text('Business address', 5, 300),
    businessPhone: phoneField,
    businessEmail: emailField,
  }),
  bank: z.object({
    bankName: text('Bank name', 2, 100),
    branch: text('Branch', 2, 100),
    accountHolderName: text('Account holder name', 3, 150),
    accountNumber: z
      .string()
      .transform(stripSeparators)
      .pipe(z.string().regex(/^\d{6,20}$/, 'Account number must be 6-20 digits')),
  }),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the partner terms' }) }),
})

export type LoginInput = z.infer<typeof loginSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>
export type RegisterBasicInput = z.infer<typeof registerBasicSchema>
export type ResellerOnboardingInput = z.infer<typeof resellerOnboardingSchema>
