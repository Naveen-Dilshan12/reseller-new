'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api, apiRequest, ApiError } from '@/lib/api'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination, type PaginationMeta } from '@/components/ui/Pagination'
import { NOTIFICATIONS_CHANGED } from './NotificationBell'

interface Notification {
  id: string
  type: string
  title: string
  body: string
  link: string | null
  readAt: string | null
  createdAt: string
}

const LIMIT = 30

/**
 * Notification links are server-generated in-app paths; refuse anything else (e.g. `//host`, `https:`).
 * A backslash is refused too: browsers read `/\host` as `//host`.
 */
function internalLink(link: string | null): string | null {
  return link && link.startsWith('/') && !link.startsWith('//') && !link.includes('\\') ? link : null
}

/**
 * The signed-in user's notifications. Shared by the seller inbox (/notifications) and the admin
 * inbox (/admin/notifications): both use the same endpoints, which the backend scopes to the
 * caller (a user can only ever read or mark their own notifications).
 */
export function NotificationInbox() {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Notification[] | null>(null)
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [loading, setLoading] = useState(true)
  /** Loading the list failed. */
  const [error, setError] = useState<string | null>(null)
  /** Marking something as read failed (the list itself is fine). */
  const [actionError, setActionError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)

  const reload = () => setAttempt((n) => n + 1)

  useEffect(() => {
    let stale = false
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) })
    if (unreadOnly) params.set('unread', 'true')
    setLoading(true)
    setError(null)
    setActionError(null)
    apiRequest<Notification[]>(`/notifications?${params}`)
      .then((r) => {
        if (stale) return
        setItems(r.data)
        setMeta((r.meta as unknown as PaginationMeta) ?? null)
        setLoading(false)
      })
      .catch((err) => {
        if (stale) return
        setItems(null)
        setMeta(null)
        setError(err instanceof ApiError ? err.message : 'Failed to load notifications')
        setLoading(false)
      })
    // An answer for a view the user has already left (filter or page changed) must not replace the current one.
    return () => {
      stale = true
    }
  }, [unreadOnly, page, attempt])

  const announceChange = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

  const markRead = async (n: Notification) => {
    if (n.readAt) return
    try {
      await api(`/notifications/${n.id}/read`, { method: 'POST' })
      setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null)
      announceChange()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not mark the notification as read')
    }
  }

  const markAll = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await api('/notifications/read-all', { method: 'POST' })
      reload()
      announceChange()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not mark notifications as read')
    } finally {
      setBusy(false)
    }
  }

  // "Mark all as read" marks every unread notification, wherever it is listed, so it is only pointless when there is nothing at all.
  const nothingToMark = items !== null && (meta?.total ?? items.length) === 0

  return (
    <>
      <div className="filter-bar" style={{ justifyContent: 'space-between' }}>
        <label className="checkbox" style={{ margin: 0 }}>
          <input
            id="ni-unread"
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => {
              setUnreadOnly(e.target.checked)
              setPage(1)
            }}
          />
          Unread only
        </label>
        <button className="btn secondary small" onClick={markAll} disabled={busy || nothingToMark}>
          {busy ? 'Marking…' : 'Mark all as read'}
        </button>
      </div>

      {error && (
        <div className="alert error" role="alert">
          {error}{' '}
          <button className="btn secondary small" onClick={reload} disabled={loading}>
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div className="alert error" role="alert">
          {actionError}
        </div>
      )}

      {!items ? (
        error ? null : (
          <p className="muted" role="status">
            Loading…
          </p>
        )
      ) : items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          hint="Updates about your requests, approvals and commissions will appear here."
        />
      ) : (
        <div className="table-wrap">
          <ul className="notification-list">
            {items.map((n) => {
              const href = internalLink(n.link)
              return (
                <li key={n.id} className={n.readAt ? '' : 'unread'}>
                  <span className="notification-dot" aria-hidden="true" />
                  <div className="notification-main">
                    <strong>
                      {n.title}
                      {!n.readAt && <span className="visually-hidden"> (unread)</span>}
                    </strong>
                    <span className="small">{n.body}</span>
                    <span className="muted small">{new Date(n.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="notification-actions">
                    {href && (
                      <Link href={href} className="btn secondary small" onClick={() => markRead(n)}>
                        Open
                      </Link>
                    )}
                    {!n.readAt && (
                      <button className="btn link small" onClick={() => markRead(n)}>
                        Mark read
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <Pagination meta={meta} onPage={setPage} noun="notifications" busy={loading} />
        </div>
      )}
    </>
  )
}
