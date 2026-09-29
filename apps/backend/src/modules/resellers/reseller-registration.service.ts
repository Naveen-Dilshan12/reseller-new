import { Request } from 'express'
import crypto from 'crypto'
import { prisma } from '../../config/database'
import { conflict } from '../../middleware/error.middleware'
import { hashPassword } from '../../utils/password'
import { auditService } from '../audit-logs/audit.service'
import { notificationService } from '../notifications/notification.service'
import { encryptAccountNumber } from './bank-account.util'
import type { RegisterResellerInput } from './reseller.schema'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

async function generateResellerCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    const code = `RS-${suffix}`
    if (!(await prisma.reseller.findUnique({ where: { code }, select: { id: true } }))) return code
  }
  throw new Error('Could not generate a unique reseller code')
}

async function assertNotRegistered(input: RegisterResellerInput) {
  const [user, byNic, byBrn] = await Promise.all([
    prisma.user.findUnique({ where: { email: input.personal.email }, select: { id: true } }),
    prisma.reseller.findUnique({ where: { nicOrPassport: input.personal.nicOrPassport }, select: { id: true } }),
    prisma.reseller.findUnique({
      where: { businessRegistrationNo: input.business.businessRegistrationNo },
      select: { id: true },
    }),
  ])
  if (user) throw conflict('An account with this email already exists')
  if (byNic) throw conflict('An application with this NIC/passport number already exists')
  if (byBrn) throw conflict('An application with this business registration number already exists')
}

export const resellerRegistrationService = {
  /**
   * Creates the reseller in PENDING status together with its first user
   * (RESELLER_ADMIN). The user cannot log in until an admin approves.
   */
  async register(req: Request, input: RegisterResellerInput) {
    await assertNotRegistered(input)

    const [code, passwordHash] = await Promise.all([generateResellerCode(), hashPassword(input.password)])
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
      const user = await tx.user.create({
        data: {
          email: personal.email,
          name: personal.fullName,
          phone: personal.mobile,
          passwordHash,
          role: 'RESELLER_ADMIN',
          resellerId: reseller.id,
        },
      })
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
        title: 'New reseller application',
        body: `${reseller.businessName} (${reseller.code}) submitted a reseller application.`,
        link: `/admin/reseller-applications/${reseller.id}`,
      },
      ['SUPER_ADMIN', 'ADMIN'],
    )

    return { applicationId: reseller.id, code: reseller.code, status: reseller.status, email: user.email }
  },
}
