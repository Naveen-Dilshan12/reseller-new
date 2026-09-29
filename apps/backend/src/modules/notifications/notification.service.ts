import type { UserRole } from '@prisma/client'
import { prisma } from '../../config/database'
import { PLATFORM_ROLES } from '../../rbac/permissions'

export interface NotificationInput {
  type: string
  title: string
  body: string
  link?: string
}

async function createFor(userIds: string[], input: NotificationInput) {
  if (userIds.length === 0) return
  await prisma.notification.createMany({ data: userIds.map((userId) => ({ userId, ...input })) })
}

/**
 * In-app notifications. Failures are logged and swallowed so a notification
 * problem never rolls back the business action that triggered it.
 */
export const notificationService = {
  async notifyUsers(userIds: string[], input: NotificationInput) {
    try {
      await createFor(userIds, input)
    } catch (err) {
      console.error('[notifications] failed to create', err)
    }
  },

  async notifyReseller(resellerId: string, input: NotificationInput) {
    const users = await prisma.user.findMany({ where: { resellerId, status: 'ACTIVE' }, select: { id: true } })
    await this.notifyUsers(users.map((u) => u.id), input)
  },

  async notifyPlatform(input: NotificationInput, roles: readonly UserRole[] = PLATFORM_ROLES) {
    const users = await prisma.user.findMany({
      where: { role: { in: [...roles] }, status: 'ACTIVE' },
      select: { id: true },
    })
    await this.notifyUsers(users.map((u) => u.id), input)
  },
}
