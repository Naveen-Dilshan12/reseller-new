'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'

/** Fired by the inbox after read/read-all so the bell updates immediately. */
export const NOTIFICATIONS_CHANGED = 'hxr:notifications-changed'

const POLL_MS = 60_000

/**
 * Header bell showing the signed-in user's unread count (GET /notifications/unread-count,
 * which the backend scopes to the caller). Refreshes on mount, every minute while the tab is
 * visible, when the tab regains focus, and right after the inbox changes read state.
 * If the count can't be loaded the badge is simply hidden — never a made-up number.
 */
export function NotificationBell({ href, label = 'Notifications' }: { href: string; label?: string }) {
  const [unread, setUnread] = useState<number | null>(null)

  const refresh = useCallback(() => {
    api<{ count: number }>('/notifications/unread-count')
      .then((r) => setUnread(typeof r.count === 'number' ? r.count : null))
      .catch(() => setUnread(null))
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener(NOTIFICATIONS_CHANGED, onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(NOTIFICATIONS_CHANGED, onFocus)
    }
  }, [refresh])

  const count = unread ?? 0
  return (
    <Link
      href={href}
      className="header-bell"
      aria-label={unread === null ? label : `${label}, ${count} unread`}
      title={label}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 && (
        <span className="header-bell-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  )
}
