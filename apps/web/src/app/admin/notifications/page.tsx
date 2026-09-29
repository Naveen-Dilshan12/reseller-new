'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api, apiRequest, ApiError } from '@/lib/api'

interface Notification {
  id: string
  type: string
  title: string
  body: string
  link: string | null
  readAt: string | null
  createdAt: string
}

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Notification[] | null>(null)
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 })
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '30' })
    if (unreadOnly) params.set('unread', 'true')
    apiRequest<Notification[]>(`/notifications?${params}`)
      .then((r) => {
        setItems(r.data)
        setMeta({ total: r.meta?.total ?? 0, totalPages: r.meta?.totalPages || 1 })
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load notifications'))
  }, [unreadOnly, page])
  useEffect(load, [load])

  const markRead = async (n: Notification) => {
    if (n.readAt) return
    await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined)
    setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null)
  }

  const markAll = async () => {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => undefined)
    load()
  }

  return (
    <main className="container">
      <div className="row" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Notifications</h1>
        <span className="spacer" />
        <label className="checkbox" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => {
              setUnreadOnly(e.target.checked)
              setPage(1)
            }}
          />
          Unread only
        </label>
        <button className="btn secondary" onClick={markAll}>
          Mark all as read
        </button>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No notifications.</p>
        ) : (
          <ul className="notification-list">
            {items.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'unread'}>
                <div className="recent-main">
                  <strong>{n.title}</strong>
                  <span className="small">{n.body}</span>
                  <span className="muted small">{new Date(n.createdAt).toLocaleString()}</span>
                </div>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  {n.link && (
                    <Link href={n.link} className="small" onClick={() => markRead(n)}>
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
            ))}
          </ul>
        )}
        {meta.totalPages > 1 && (
          <div className="row" style={{ marginTop: '1rem' }}>
            <span className="muted small">
              Page {page} of {meta.totalPages}
            </span>
            <span className="spacer" />
            <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button className="btn secondary" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
