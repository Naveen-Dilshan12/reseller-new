import type { Request } from 'express'
import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { auditService } from '../audit-logs/audit.service'
import { getLevels, recalculateResellerLevel } from '../commissions/level.service'
import { notificationService } from '../notifications/notification.service'
import type { UpdateLevelsInput } from './settings.schema'

export const SETTING_KEYS = { COMPANY_BANK_DETAILS: 'COMPANY_BANK_DETAILS' } as const

/** Company account resellers tell customers to pay into. The database value overrides the environment default. */
export async function getCompanyBankDetails(): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTING_KEYS.COMPANY_BANK_DETAILS } })
  return row?.value || env.COMPANY_BANK_DETAILS || null
}

export const settingsService = {
  async get() {
    const [levels, bank, products] = await Promise.all([
      getLevels(),
      prisma.platformSetting.findUnique({ where: { key: SETTING_KEYS.COMPANY_BANK_DETAILS } }),
      prisma.saasProduct.findMany({
        select: { id: true, code: true, name: true, status: true, integrationStatus: true, integration: { select: { provider: true, lastCheckedAt: true } } },
        orderBy: { name: 'asc' },
      }),
    ])
    const updatedBy = bank?.updatedById
      ? await prisma.user.findUnique({ where: { id: bank.updatedById }, select: { name: true, email: true } })
      : null
    return {
      commissionLevels: levels,
      companyBankDetails: {
        value: bank?.value || env.COMPANY_BANK_DETAILS || null,
        source: bank ? 'database' : env.COMPANY_BANK_DETAILS ? 'environment' : 'not-set',
        updatedAt: bank?.updatedAt ?? null,
        updatedBy,
      },
      system: {
        commissionHoldDays: env.COMMISSION_HOLD_DAYS,
        maxUploadMb: env.MAX_UPLOAD_MB,
        businessTimezone: env.BUSINESS_TIMEZONE,
        environment: env.NODE_ENV,
      },
      integrations: products.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
        integrationStatus: p.integrationStatus,
        provider: p.integration?.provider ?? null,
        lastCheckedAt: p.integration?.lastCheckedAt ?? null,
      })),
    }
  },

  async updateCompanyBankDetails(req: Request, value: string, reason: string) {
    const before = await getCompanyBankDetails()
    await prisma.$transaction(async (tx) => {
      await tx.platformSetting.upsert({
        where: { key: SETTING_KEYS.COMPANY_BANK_DETAILS },
        create: { key: SETTING_KEYS.COMPANY_BANK_DETAILS, value, updatedById: req.user!.userId },
        update: { value, updatedById: req.user!.userId },
      })
      await auditService.fromRequest(
        req,
        { action: 'SETTINGS_COMPANY_BANK_DETAILS_UPDATED', entityType: 'PlatformSetting', entityId: SETTING_KEYS.COMPANY_BANK_DETAILS, metadata: { before, after: value, reason } },
        tx,
      )
    })
    // Changing where customers send money is a fraud risk: tell every admin.
    await notificationService.notifyPlatform({
      type: 'SETTINGS_CHANGED',
      title: 'Company bank details changed',
      body: `${req.user!.email} changed the bank details shown to resellers. Reason: ${reason}`,
      link: '/admin/settings',
    })
    return this.get()
  },

  /**
   * Replaces the level tiers and recalculates every reseller's level. Existing
   * commission entries keep the rate they were created with.
   */
  async updateCommissionLevels(req: Request, input: UpdateLevelsInput) {
    const before = await getLevels()
    const resellers = await prisma.reseller.findMany({ where: { status: { in: ['ACTIVE', 'SUSPENDED'] } }, select: { id: true } })

    const changes = await prisma.$transaction(
      async (tx) => {
        await tx.commissionLevel.deleteMany({})
        await tx.commissionLevel.createMany({ data: input.levels })
        const changed: { resellerId: string; from: number | null; to: number | null }[] = []
        for (const r of resellers) {
          const result = await recalculateResellerLevel(tx, r.id)
          if (result.changed) changed.push({ resellerId: r.id, from: result.fromLevel, to: result.level })
        }
        await auditService.fromRequest(
          req,
          {
            action: 'SETTINGS_COMMISSION_LEVELS_UPDATED',
            entityType: 'CommissionLevel',
            metadata: {
              reason: input.reason,
              before: before.map(({ createdAt: _c, updatedAt: _u, ...l }) => ({ ...l, ratePercent: l.ratePercent.toString() })),
              after: input.levels,
              resellersRecalculated: resellers.length,
              levelChanges: changed,
            },
          },
          tx,
        )
        return changed
      },
      { timeout: 60_000 },
    )

    await notificationService.notifyPlatform(
      {
        type: 'SETTINGS_CHANGED',
        title: 'Commission levels changed',
        body: `${req.user!.email} updated the commission levels (${changes.length} reseller level change${changes.length === 1 ? '' : 's'}). Reason: ${input.reason}`,
        link: '/admin/settings',
      },
      ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    )
    for (const c of changes) {
      await notificationService.notifyReseller(c.resellerId, {
        type: 'LEVEL_CHANGED',
        title: 'Your reseller level changed',
        body: `Hexalyte updated the commission levels. Your level is now ${c.to ?? 'none'}. New commissions use the new rate.`,
        link: '/commissions',
      })
    }
    return { ...(await this.get()), levelChanges: changes.length }
  },
}
