import app from './app'
import { env } from './config/env'
import { prisma } from './config/database'
import { promotePayable } from './modules/commissions/commission-ledger.service'

const server = app.listen(env.PORT, () => {
  console.log(`Hexalyte Reseller API listening on :${env.PORT}/${env.API_PREFIX}`)
})

// Commission reads also promote on demand; this keeps totals current between requests.
const promoteTimer = setInterval(() => {
  promotePayable().catch((err) => console.error('[commissions] promotePayable failed', err))
}, 60 * 60 * 1000)
promoteTimer.unref()

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`)
  clearInterval(promoteTimer)
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
