import { PrismaClient } from '@prisma/client'
import { env } from './env'

// Configure database URL with connection pooling
function getDatabaseUrlWithPool(): string {
  const baseUrl = env.DATABASE_URL
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}connection_limit=${env.DATABASE_POOL_MAX}&pool_timeout=20`
}

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  datasources: {
    db: {
      url: getDatabaseUrlWithPool(),
    },
  },
})

// Graceful shutdown handling
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
}

// Health check for database connection
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch (error) {
    console.error('Database health check failed:', error)
    return false
  }
}
