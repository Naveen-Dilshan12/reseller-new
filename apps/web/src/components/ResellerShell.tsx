'use client'

import { isPlatformUser, useCurrentUser, type CurrentUser } from '@/lib/auth'
import { TopBar } from './TopBar'

/** Layout for reseller pages: requires a logged-in reseller user. */
export function ResellerShell({ children }: { children: (user: CurrentUser) => React.ReactNode }) {
  const user = useCurrentUser((u) => !isPlatformUser(u))
  if (!user) return null
  const links = [{ href: '/dashboard', label: 'Dashboard' }]
  if (user.permissions.includes('trials:read')) links.push({ href: '/trials', label: 'Trials' })
  if (user.permissions.includes('activations:read')) links.push({ href: '/activations', label: 'Activations' })
  if (user.permissions.includes('commissions:read')) links.push({ href: '/commissions', label: 'Commissions' })
  return (
    <>
      <TopBar user={user} links={links} />
      {children(user)}
    </>
  )
}
