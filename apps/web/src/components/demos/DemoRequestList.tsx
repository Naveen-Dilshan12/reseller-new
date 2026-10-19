'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { DEMO_STATUS_LABELS, type DemoListItem, type DemoPipelineCounts, type DemoStatus } from '@/lib/demo-types'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHero, type PageHeroProps } from '@/components/PageHero'
import { KpiGrid, KpiRefCard } from '@/components/ui/KpiRefCard'
import { Pagination } from '@/components/ui/Pagination'

interface Props {
  basePath: '/demo-requests' | '/admin/demo-requests'
  showReseller?: boolean
  defaultStatus?: string
  heroProps?: Omit<PageHeroProps, 'children'>
  /** Admin view only: adds a "Next step" column; `canReview` (demos:review) decides whether it offers an action or just View. */
  adminActions?: { canReview: boolean }
}

/** The admin action available for each status, matching the buttons on the request's detail page. */
const ADMIN_NEXT_STEP: Partial<Record<DemoStatus, string>> = {
  PENDING: 'Review',
  APPROVED: 'Add welcome message',
  DEMO_CREATED: 'Confirm',
}

interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
  pipelineCounts?: DemoPipelineCounts
}

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  ...(['PENDING', 'APPROVED', 'DEMO_CREATED', 'CONFIRMED', 'REJECTED'] as DemoStatus[]).map((s) => ({
    value: s,
    label: DEMO_STATUS_LABELS[s],
  })),
]

export function DemoRequestList({ basePath, showReseller, defaultStatus = '', heroProps, adminActions }: Props) {
  const [items, setItems] = useState<DemoListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [status, setStatus] = useState(defaultStatus)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const changeStatus = (value: string) => {
    setStatus(value)
    setPage(1)
  }

  /** `searchOverride` lets "Clear filters" reload with the search it has just emptied (the state is not updated yet). */
  const load = useCallback((searchOverride?: string) => {
    const term = (searchOverride ?? search).trim()
    const params = new URLSearchParams({ limit: '25', page: String(page) })
    if (status) params.set('status', status)
    if (term) params.set('search', term)
    setLoading(true)
    setError(null)
    apiRequest<DemoListItem[]>(`/demo-requests?${params}`)
      .then((r) => {
        setItems(r.data)
        setTotal(r.meta?.total ?? r.data.length)
        setMeta((r.meta as unknown as PaginationMeta) ?? null)
        setLoading(false)
      })
      .catch((err) => {
        // No stale rows next to the error, and no "Loading…" left behind: the alert offers Retry instead.
        setItems(null)
        setMeta(null)
        setTotal(0)
        setError(err instanceof ApiError ? err.message : 'Failed to load demo requests')
        setLoading(false)
      })
  }, [status, search, page])

  useEffect(load, [status, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const clearFilters = () => {
    setSearch('')
    // A status or page change reloads the list by itself; only when neither changes does it need an explicit reload.
    if (status === '' && page === 1) load('')
    else changeStatus('')
  }

  const totalCount = meta?.pipelineCounts?.total ?? meta?.total ?? total ?? items?.length ?? 0
  const pendingCount = meta?.pipelineCounts?.pending ?? (items ? items.filter((d) => d.status === 'PENDING').length : 0)
  const approvedCount = meta?.pipelineCounts?.approved ?? (items ? items.filter((d) => d.status === 'APPROVED').length : 0)
  const demoCreatedCount = meta?.pipelineCounts?.demoCreated ?? (items ? items.filter((d) => d.status === 'DEMO_CREATED').length : 0)
  const confirmedCount = meta?.pipelineCounts?.confirmed ?? (items ? items.filter((d) => d.status === 'CONFIRMED').length : 0)

  const kpiGrid = (
    <KpiGrid count={5}>
      <KpiRefCard
        label="Total Requests"
        value={!items ? '—' : totalCount}
        badge="All Time"
        badgeTone="neutral"
        desc="Demo requests recorded"
        accent="indigo"
        active={status === ''}
        onClick={() => changeStatus('')}
        title="Filter by all demo requests"
      />
      <KpiRefCard
        label="Pending Review"
        value={!items ? '—' : pendingCount}
        badge="Queue"
        badgeTone="neutral"
        desc="Awaiting admin decision"
        accent="amber"
        active={status === 'PENDING'}
        onClick={() => changeStatus('PENDING')}
        title="Filter by Pending"
      />
      <KpiRefCard
        label="Approved"
        value={!items ? '—' : approvedCount}
        badge="In progress"
        badgeTone="neutral"
        desc="Awaiting manual demo creation"
        accent="violet"
        active={status === 'APPROVED'}
        onClick={() => changeStatus('APPROVED')}
        title="Filter by Approved"
      />
      <KpiRefCard
        label="Demo Ready"
        value={!items ? '—' : demoCreatedCount}
        badge="Ready to share"
        badgeTone="positive"
        desc="Welcome message prepared"
        accent="emerald"
        active={status === 'DEMO_CREATED'}
        onClick={() => changeStatus('DEMO_CREATED')}
        title="Filter by Demo ready"
      />
      <KpiRefCard
        label="Confirmed"
        value={!items ? '—' : confirmedCount}
        badge="Done"
        badgeTone="positive"
        desc="Delivery confirmed"
        accent="emerald"
        active={status === 'CONFIRMED'}
        onClick={() => changeStatus('CONFIRMED')}
        title="Filter by Confirmed"
      />
    </KpiGrid>
  )

  return (
    <>
      {heroProps ? <PageHero {...heroProps}>{kpiGrid}</PageHero> : kpiGrid}

      {error && (
        <div className="alert error" role="alert">
          {error}{' '}
          <button className="btn secondary small" onClick={() => load()} disabled={loading}>
            Retry
          </button>
        </div>
      )}

      <form
        className="filter-bar"
        onSubmit={(e) => {
          e.preventDefault()
          if (page !== 1) setPage(1)
          else load()
        }}
      >
        <div className="field inline search-field">
          <label htmlFor="dr-search">Search</label>
          <div className="filter-search-wrap">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ position: 'absolute', left: '0.75rem', color: 'var(--text-secondary)', pointerEvents: 'none', zIndex: 1 }}
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              id="dr-search"
              type="text"
              placeholder="Business, contact name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="field inline" style={{ flex: '1 1 200px', minWidth: '160px', maxWidth: '240px' }}>
          <label htmlFor="dr-status">Status</label>
          <select id="dr-status" value={status} onChange={(e) => changeStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-actions">
          {(status || search.trim()) && (
            <button
              type="button"
              className="btn link small"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          )}
          <button className="btn secondary small" type="submit">
            Search
          </button>
        </div>
      </form>

      {!items ? (
        error ? null : <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No demo requests found"
          hint={
            basePath === '/admin/demo-requests'
              ? 'No requests match the current filters. New partner demo requests will appear here for review.'
              : 'Request a demo shop for a prospective customer and Hexalyte will set it up for you.'
          }
        >
          {basePath === '/demo-requests' && (
            <Link href="/demo-requests/new" className="btn primary">
              New Demo Request
            </Link>
          )}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Business / Customer</th>
                <th>Contact</th>
                <th>Product</th>
                {showReseller && <th>Partner</th>}
                <th>Status</th>
                <th>Submitted</th>
                {adminActions && <th>Next step</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`${basePath}/${d.id}`}>{d.businessName}</Link>
                  </td>
                  <td className="small">
                    {d.contactName}
                    <div className="muted">{d.contactEmail}</div>
                  </td>
                  <td>{d.product.name}</td>
                  {showReseller && (
                    <td className="small">
                      {d.reseller.businessName}
                      <div className="muted mono">{d.reseller.code}</div>
                    </td>
                  )}
                  <td>
                    <span className={`badge dem-${d.status}`}>{DEMO_STATUS_LABELS[d.status]}</span>
                  </td>
                  <td className="small">{formatDate(d.submittedAt)}</td>
                  {adminActions && (
                    <td>
                      <Link href={`${basePath}/${d.id}`} className="btn secondary small">
                        {(adminActions.canReview && ADMIN_NEXT_STEP[d.status]) || 'View'}
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination meta={meta} onPage={setPage} noun="requests" />
        </div>
      )}
    </>
  )
}
