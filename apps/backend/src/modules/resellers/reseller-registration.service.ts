import { trySendInitialCode, type InitialCodeOutcome } from '../auth/verification.service'
import { Request } from 'express'
import crypto from 'crypto'
import { prisma } from '../../config/database'
import { badRequest, conflict } from '../../middleware/error.middleware'
import { isPlatformRole } from '../../rbac/permissions'
import { hashPassword } from '../../utils/password'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { emailService } from '../email/email.service'
import { encryptAccountNumber } from './bank-account.util'
import type { RegisterResellerInput } from './reseller.schema'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

async function generateResellerCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    const code = `RS-${suffix}`
    if (!(await prisma.reseller.findUnique({ where: { code }, select: { id: true } }))) return code
  }
  throw new Error('Could not generate a unique partner code')
}

async function assertBusinessIdentifiersAvailable(input: RegisterResellerInput) {
  const [byNic, byBrn] = await Promise.all([
    prisma.reseller.findUnique({ where: { nicOrPassport: input.personal.nicOrPassport }, select: { id: true } }),
    prisma.reseller.findUnique({
      where: { businessRegistrationNo: input.business.businessRegistrationNo },
      select: { id: true },
    }),
  ])
  if (byNic) throw conflict('An application with this NIC/passport number already exists')
  if (byBrn) throw conflict('An application with this business registration number already exists')
}

/**
 * Resolves which (if any) existing user row this application may attach to —
 * without ever letting an unauthenticated (or differently-authenticated)
 * caller read or write someone else's account.
 *
 * SECURITY: this must never resolve "which user to update" from the request
 * body's email address alone. An earlier version did exactly that, which let
 * an unauthenticated caller take over *any* existing account (overwriting its
 * password and role, and detaching it from its reseller eligibility) just by
 * submitting that account's email address.
 *
 * - Authenticated caller: always resolves to *their own* user row, found by
 *   session id, never by the submitted email. The submitted contact email is
 *   only used to reject the application if it belongs to a *different*
 *   existing account — it never changes who gets linked.
 * - Unauthenticated caller: only a brand-new email is allowed through (and
 *   creates a brand-new user). An email that already exists is refused with
 *   no further read or write of that account.
 *
 * A platform role (ADMIN) is never linked, even to itself: this endpoint
 * must not be able to change a platform account's role or create a reseller
 * application owned by platform staff.
 */
async function resolveLinkTarget(req: Request, input: RegisterResellerInput): Promise<{ id: string } | null> {
  const sessionUserId = req.user?.userId ?? null

  if (sessionUserId) {
    const self = await prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { id: true, email: true, role: true, resellerId: true },
    })
    // Should not happen (authenticate/optionalAuthenticate already re-checked the user), but never trust it blindly.
    if (!self) throw conflict('Your session is no longer valid. Please log in again.')
    if (isPlatformRole(self.role)) throw conflict('Platform staff accounts cannot apply to become a partner')
    if (self.resellerId) throw conflict('Your account already has a partner application')

    if (self.email !== input.personal.email) {
      const emailOwner = await prisma.user.findUnique({ where: { email: input.personal.email }, select: { id: true } })
      if (emailOwner && emailOwner.id !== self.id) {
        throw conflict('An account with this contact email already exists')
      }
    }
    return { id: self.id }
  }

  const emailOwner = await prisma.user.findUnique({ where: { email: input.personal.email }, select: { id: true } })
  if (emailOwner) {
    throw conflict('An account with this email already exists. Please log in to apply for a partner account.')
  }
  return null
}

/** Applicant-facing wording for the first SMS code. Never claims a message that was not sent; never reveals limits. */
function describeInitialCode(outcome: InitialCodeOutcome) {
  if (outcome.sent) {
    return {
      required: true,
      codeSent: true,
      message: `We sent a 6-digit verification code by SMS to ${outcome.phoneMasked ?? 'your mobile number'}. Enter it on the account verification page before signing in.`,
    }
  }
  const message =
    outcome.reason === 'send_failed'
      ? 'Your application was received, but we could not send the verification SMS to that number. Check the number, then request a new code on the account verification page.'
      : outcome.reason === 'rate_limited'
        ? 'Your application was received. Too many codes were requested for this number; try requesting a new code on the account verification page later.'
        : 'Your application was received, but the verification SMS could not be sent right now. Request a new code on the account verification page in a little while; you cannot sign in until the number is verified.'
  return { required: true, codeSent: false, message }
}

export const resellerRegistrationService = {
  /**
   * Creates the reseller application in PENDING status.
   *
   * - If the caller is authenticated (e.g. a basic SELLER account created via
   *   `/auth/register`), the application links to *that same* account only.
   * - If the caller is unauthenticated, a brand-new user + reseller pair is
   *   created, but only for an email with no existing account.
   *
   * See resolveLinkTarget() for the security boundary this depends on.
   */
  async register(req: Request, input: RegisterResellerInput) {
    await assertBusinessIdentifiersAvailable(input)
    const existingUser = await resolveLinkTarget(req, input)

    const [code, passwordHash] = await Promise.all([
      generateResellerCode(),
      input.password ? hashPassword(input.password) : Promise.resolve(null),
    ])
    const { personal, business, bank } = input

    const { reseller, user } = await prisma.$transaction(async (tx) => {
      const reseller = await tx.reseller.create({
        data: {
          code,
          ...personal,
          ...business,
          status: 'PENDING',
          bankAccount: {
            create: {
              bankName: bank.bankName,
              branch: bank.branch,
              accountHolderName: bank.accountHolderName,
              ...encryptAccountNumber(bank.accountNumber),
            },
          },
        },
      })

      let user
      if (existingUser) {
        user = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            name: personal.fullName,
            phone: personal.mobile,
            role: 'SELLER',
            resellerId: reseller.id,
            ...(passwordHash ? { passwordHash } : {}),
          },
        })
      } else {
        if (!passwordHash) throw badRequest('Password is required for new registration')
        user = await tx.user.create({
          data: {
            email: personal.email,
            name: personal.fullName,
            phone: personal.mobile,
            passwordHash,
            role: 'SELLER',
            resellerId: reseller.id,
          },
        })
      }
      await auditService.fromRequest(
        req,
        {
          action: 'RESELLER_APPLICATION_SUBMITTED',
          entityType: 'Reseller',
          entityId: reseller.id,
          resellerId: reseller.id,
          metadata: { code, businessName: business.businessName },
          actor: { userId: user.id, email: user.email },
        },
        tx,
      )
      return { reseller, user }
    })

    await notificationService.notifyPlatform(
      {
        type: 'RESELLER_APPLICATION_SUBMITTED',
        title: 'New partner application',
        body: `${reseller.businessName} (${reseller.code}) submitted a partner application.`,
        link: `/admin/reseller-applications/${reseller.id}`,
      },
      ['ADMIN'],
    )

    // Send confirmation email to applicant
    const { html, text } = emailService.createApplicationReceivedEmail(
      reseller.fullName,
      reseller.businessName,
      reseller.code,
    )
    await emailService.sendEmail({
      to: reseller.email,
      subject: `Application Received (${reseller.code}) - Hexalyte Central Partner Platform`,
      html,
      text,
    }).catch(() => {
      // Non-fatal if email dispatch encounters logger/transport error
    })

    // A brand-new account (no session) has not been verified. Send its SMS code now and report exactly what happened.
    // Applicants who were logged in already own a verified account and need no code.
    return {
      applicationId: reseller.id,
      code: reseller.code,
      status: reseller.status,
      email: user.email,
      verification: existingUser ? { required: false, codeSent: false, message: null } : describeInitialCode(await trySendInitialCode(req, user)),
    }
  },
}
