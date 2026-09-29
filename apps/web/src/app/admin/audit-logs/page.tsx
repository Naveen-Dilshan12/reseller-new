'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, apiRequest, ApiError } from '@/lib/api'
import { humanizeAction, type AuditLogEntry } from '@/lib/admin-types'

interface Facets {
  actions: { value: string; count: number }[]
  entityTypes: { value: string; count: number }[]
}

export default function AuditLogsPage() {
  const [facets, setFacets] = useState<Facets | null>(null)
  const [action, setAction] = useState('')
  const [entityType, setEntityType] = useState('')
  const [actorType, setActorType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AuditLogEntry[] | null>(null)
  const [meta, setMeta] = useState({ total: 0, totalPages: 1 })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Facets>('/audit-logs/facets').then(setFacets).catch(() => setFacets({ actions: [], entityTypes: [] }))
  }, [])

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '50' })
    if (action) params.set('action', action)
    if (entityType) params.set('entityType', entityType)
    if (actorType) params.set('actorType', actorType)
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString())
    if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString())
    if (search.trim()) params.set('search', search.trim())
    apiRequest<AuditLogEntry[]>(`/audit-logs?${params}`)
      .then((r) => {
        setItems(r.data)
        setMeta({ total: r.meta?.total ?? 0, totalPages: r.meta?.totalPages || 1 })
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the audit log'))
  }, [action, entityType, actorType, from, to, search, page])

  useEffect(load, [action, entityType, actorType, from, to, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPage(1)
  }

  return (
    <main className="container wide">
      <h1>Audit logs</h1>
      <p className="muted">
        Every important action (approvals, rejections, activations, payment verification, bank slip and bank account
        access, commission changes, settings changes, logins) is recorded here. The log is append-only: entries cannot be
        edited or deleted.
      </p>
      <div className="card">
        <form
          className="filter-bar plain"
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            load()
          }}
        >
          <div className="field inline">
            <label htmlFor="al-action">Action</label>
            <select id="al-action" value={action} onChange={(e) => resetPage(setAction)(e.target.value)}>
              <option value="">All actions</option>
              {facets?.actions.map((a) => (
                <option key={a.value} value={a.value}>
                  {humanizeAction(a.value)} ({a.count})
                </option>
              ))}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="al-entity">Record type</label>
            <select id="al-entity" value={entityType} onChange={(e) => resetPage(setEntityType)(e.target.value)}>
              <option value="">All</option>
              {facets?.entityTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.value}
                </option>
              ))}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="al-actor">Actor</label>
            <select id="al-actor" value={actorType} onChange={(e) => resetPage(setActorType)(e.target.value)}>
              <option value="">All</option>
              <option value="USER">Users</option>
              <option value="SYSTEM">System</option>
              <option value="SAAS">SaaS</option>
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="al-from">From</label>
            <input id="al-from" type="date" value={from} max={to || undefined} onChange={(e) => resetPage(setFrom)(e.target.value)} />
          </div>
          <div className="field inline">
            <label htmlFor="al-to">To</label>
            <input id="al-to" type="date" value={to} min={from || undefined} onChange={(e) => resetPage(setTo)(e.target.value)} />
          </div>
          <div className="field inline" style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="al-search">Search</label>
            <input id="al-search" placeholder="Actor email, action or record ID" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>

        {error && <div className="alert error">{error}</div>}
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No entries match these filters.</p>
        ) : (
          <div className="table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Record</th>
                  <th>IP</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <Fragment key={a.id}>
                    <tr>
                      <td className="small nowrap">{new Date(a.createdAt).toLocaleString()}</td>
                      <td>
                        <strong className="small">{humanizeAction(a.action)}</strong>
                        <div className="muted small mono">{a.action}</div>
                      </td>
                      <td className="small">
                        {a.actorEmail ?? '—'}
                        <div className="muted">{a.actorType.toLowerCase()}</div>
                      </td>
                      <td className="small">
                        {a.entityType}
                        {a.entityId && <div className="muted mono">{a.entityId}</div>}
                      </td>
                      <td className="small mono">{a.ip ?? '—'}</td>
                      <td>
                        {a.metadata != null && (
                          <button className="btn link small" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                            {expanded === a.id ? 'Hide' : 'Details'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === a.id && (
                      <tr className="audit-details">
                        <td colSpan={6}>
                          <pre>{JSON.stringify(a.metadata, null, 2)}</pre>
                          {a.userAgent && <div className="small muted">User agent: {a.userAgent}</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {meta.totalPages > 1 && (
          <div className="row" style={{ marginTop: '1rem' }}>
            <span className="muted small">
              Page {page} of {meta.totalPages} · {meta.total} entries
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
