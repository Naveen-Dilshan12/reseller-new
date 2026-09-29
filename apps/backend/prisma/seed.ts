import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * None of the SaaS products exposes the partner API yet, so they start in
 * MANUAL fulfilment. A super admin switches the provider (e.g. MOBILE_SHOP)
 * and enters credentials in the admin UI once the partner API is live.
 */
const PRODUCTS = [
  { code: 'MOBILE_SHOP', name: 'Hexalyte Mobile Shop', description: 'Mobile shop POS & management SaaS', status: 'ACTIVE', trialAvailable: true },
  { code: 'FASHION_ERP', name: 'HexaOne Clothing ERP', description: 'Clothing / fashion retail ERP SaaS', status: 'ACTIVE', trialAvailable: true },
  { code: 'SALON', name: 'Hexalyte Salon', description: 'Salon management SaaS', status: 'ACTIVE', trialAvailable: true },
  { code: 'SUPERMARKET', name: 'Hexalyte Supermarket', description: 'Supermarket POS SaaS', status: 'COMING_SOON', trialAvailable: false },
] as const

const COMMISSION_LEVELS = [
  { level: 1, name: 'Level 1', minActiveCustomers: 1, maxActiveCustomers: 10, ratePercent: 10 },
  { level: 2, name: 'Level 2', minActiveCustomers: 11, maxActiveCustomers: 30, ratePercent: 15 },
  { level: 3, name: 'Level 3', minActiveCustomers: 31, maxActiveCustomers: 60, ratePercent: 20 },
  { level: 4, name: 'Level 4', minActiveCustomers: 61, maxActiveCustomers: 100, ratePercent: 25 },
  { level: 5, name: 'Level 5', minActiveCustomers: 101, maxActiveCustomers: null, ratePercent: 30 },
]

async function main() {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD
  if (!email || !password || password.length < 10) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD (10+ chars) are required')
  }

  await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: {
      email: email.toLowerCase(),
      name: process.env.SEED_SUPER_ADMIN_NAME || 'Hexalyte Admin',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'SUPER_ADMIN',
    },
  })

  for (const product of PRODUCTS) {
    await prisma.saasProduct.upsert({
      where: { code: product.code },
      update: {},
      create: {
        ...product,
        monthlyPrice: 5500,
        currency: 'LKR',
        integrationStatus: 'CONFIGURED',
        integration: { create: { provider: 'MANUAL' } },
      },
    })
  }

  for (const level of COMMISSION_LEVELS) {
    await prisma.commissionLevel.upsert({ where: { level: level.level }, update: {}, create: level })
  }

  console.log(`Seeded super admin ${email}, ${PRODUCTS.length} SaaS products and ${COMMISSION_LEVELS.length} commission levels`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
