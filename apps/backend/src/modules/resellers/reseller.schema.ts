import { z } from 'zod'
import { paginationSchema } from '../../utils/pagination'
import { passwordSchema } from '../../utils/password'

const stripSeparators = (s: string) => s.replace(/[\s-]/g, '')

export const text = (label: string, min = 2, max = 150) =>
  z.string({ required_error: `${label} is required` }).trim().min(min, `${label} is required`).max(max)

export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(150)

/** Sri Lankan mobile, normalised to +947XXXXXXXX. */
export const mobile = z
  .string()
  .transform(stripSeparators)
  .pipe(z.string().regex(/^(\+94|0)7\d{8}$/, 'Enter a valid mobile number, e.g. 0771234567'))
  .transform((s) => `+94${s.slice(-9)}`)

/** Sri Lankan landline or mobile, normalised to +94XXXXXXXXX. */
const phone = z
  .string()
  .transform(stripSeparators)
  .pipe(z.string().regex(/^(\+94|0)\d{9}$/, 'Enter a valid phone number, e.g. 0112345678'))
  .transform((s) => `+94${s.slice(-9)}`)

/** Old NIC (123456789V), new NIC (200012345678) or passport number. */
const nicOrPassport = z
  .string()
  .transform((s) => stripSeparators(s).toUpperCase())
  .pipe(z.string().regex(/^(\d{9}[VX]|\d{12}|[A-Z][A-Z0-9]{5,11})$/, 'Enter a valid NIC or passport number'))

export const registerResellerSchema = z
  .object({
    personal: z.object({
      fullName: text('Full name', 3, 150),
      nicOrPassport,
      email,
      mobile,
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
      businessPhone: phone,
      businessEmail: email,
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
    password: passwordSchema.optional(),
    confirmPassword: z.string().optional(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the partner terms' }) }),
  })
  .refine(
    (d) => (!d.password && !d.confirmPassword) || d.password === d.confirmPassword,
    { path: ['confirmPassword'], message: 'Passwords do not match' },
  )

export type RegisterResellerInput = z.infer<typeof registerResellerSchema>

export const listApplicationsSchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'TERMINATED']).optional(),
  search: z.string().trim().max(100).optional(),
})

export type ListApplicationsQuery = z.infer<typeof listApplicationsSchema>

export const approveApplicationSchema = z.object({
  note: z.string().trim().max(1000).optional(),
})

export const rejectApplicationSchema = z.object({
  reason: z.string().trim().min(10, 'Rejection reason must be at least 10 characters').max(1000),
})

export type ApproveApplicationInput = z.infer<typeof approveApplicationSchema>
export type RejectApplicationInput = z.infer<typeof rejectApplicationSchema>
