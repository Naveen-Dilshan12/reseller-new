'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isPlatformUser, useCurrentUser } from '@/lib/auth'
import { AdminUserContext } from '@/lib/admin-context'
import { TopBar } from '@/components/TopBar'

interface NavItem {
  href: string
  label: string
  permission?: string
  /** Extra paths that highlight this item. */
  match?: string[]
}

const NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/resellers', label: 'Resellers', permission: 'resellers:read', match: ['/admin/reseller-applications'] },
  { href: '/admin/products', label: 'SaaS Products', permission: 'products:manage' },
  { href: '/admin/customer-accounts', label: 'Customers', permission: 'accounts:read' },
  { href: '/admin/trials', label: 'Trial Requests', permission: 'trials:read' },
  { href: '/admin/activations', label: 'Activation Requests', permission: 'activations:read' },
  { href: '/admin/bank-slips', label: 'Bank Slips', permission: 'bankslips:read' },
  { href: '/admin/commissions', label: 'Commissions', permission: 'commissions:read' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/audit-logs', label: 'Audit Logs', permission: 'audit:read' },
  { href: '/admin/settings', label: 'Settings', permission: 'settings:read' },
]

function isActive(pathname: string, item: NavItem) {
  if (item.href === '/admin') return pathname === '/admin'
  return [item.href, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser(isPlatformUser)
  const pathname = usePathname()
  if (!user) return null

  const items = NAV.filter((n) => !n.permission || user.permissions.includes(n.permission))
  return (
    <AdminUserContext.Provider value={user}>
      <TopBar user={user} notificationsHref="/admin/notifications" wide />
      <div className="admin-shell">
        <nav className="admin-nav" aria-label="Admin sections">
          {items.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(pathname, item) ? 'active' : undefined} aria-current={isActive(pathname, item) ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="admin-content">{children}</div>
      </div>
    </AdminUserContext.Provider>
  )
}
