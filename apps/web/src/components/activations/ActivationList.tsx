'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import {
  ACTIVATION_STATUS_LABELS,
  type ActivationListItem,
  type ActivationPipelineCounts,
  type ActivationStatus,
} from '@/lib/activation-types'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHero, type PageHeroProps } from '@/components/PageHero'
import { KpiGrid, KpiRefCard } from '@/components/ui/KpiRefCard'
import { Pagination } from '@/components/ui/Pagination'

interface Props {
  basePath: '/activations' | '/admin/activations'
  showReseller?: boolean
  /** Comma-separated statuses selected initially. */
  defaultStatus?: string
  heroProps?: Omit<PageHeroProps, 'children'>
}

interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
  pipelineCounts?: ActivationPipelineCounts
}

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'PENDING_REVIEW,UNDER_REVIEW', label: 'Needs review' },
  { value: 'APPROVED', label: 'Approved – awaiting activation' },
  ...(['PENDING_REVIEW', 'UNDER_REVIEW', 'ACTIVATION_COMPLETED', 'REJECTED', 'CANCELLED'] as ActivationStatus[]).map((s) => ({
    value: s,
    label: ACTIVATION_STATUS_LABELS[s],
  })),
]

export function ActivationList({ basePath, showReseller, defaultStatus = '', heroProps }: Props) {
  const [items, setItems] = useState<ActivationListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [status, setStatus] = useState(defaultStatus)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  // Any filter change returns to page 1 of the new result set
  const changeStatus = (value: string) => {
    setStatus(value)
    setPage(1)
  }

  /** `searchOverride` lets "Clear filters" reload with the search it has just emptied (the state is not updated yet). */
  const load = useCallback(
    (searchOverride?: string) => {
      const term = (searchOverride ?? search).trim()
      const params = new URLSearchParams({ limit: '25', page: String(page) })
      if (status) params.set('status', status)
      if (term) params.set('search', term)
      setLoading(true)
      setError(null)
      apiRequest<ActivationListItem[]>(`/activation-requests?${params}`)
        .then((r) => {
          const next = (r.meta as unknown as PaginationMeta) ?? null
          // The page asked for no longer exists (its rows moved on): go to the last real page instead of showing
          // "no requests" with no way back. `loading` stays on until that page arrives.
          if (next && r.data.length === 0 && next.total > 0 && page > next.totalPages) {
            setPage(next.totalPages)
            return
          }
          setItems(r.data)
          setTotal(r.meta?.total ?? r.data.length)
          setMeta(next)
          setLoading(false)
        })
        .catch((err) => {
          setItems(null)
          setMeta(null)
          setTotal(0)
          setError(err instanceof ApiError ? err.message : 'Failed to load activation requests')
          setLoading(false)
        })
    },
    [status, search, page],
  )

  useEffect(load, [status, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtering = Boolean(status) || Boolean(search.trim())
  const clearFilters = () => {
    setSearch('')
    // A status or page change reloads the list by itself; only when neither changes does it need an explicit reload.
    if (status === '' && page === 1) load('')
    else changeStatus('')
  }
  const emptyHint = filtering
    ? 'No requests match the current filters. Clear the filters to see every request.'
    : basePath === '/admin/activations'
      ? 'Requests submitted by partners will appear here.'
      : 'Submit customer payment slips to activate SaaS subscriptions and track verification.'

  const totalCount = meta?.pipelineCounts?.total ?? meta?.total ?? total ?? items?.length ?? 0
  const pendingReviewCount =
    meta?.pipelineCounts?.pendingReview ?? (items ? items.filter((a) => a.status === 'PENDING_REVIEW').length : 0)
  const underReviewCount =
    meta?.pipelineCounts?.underReview ?? (items ? items.filter((a) => a.status === 'UNDER_REVIEW').length : 0)
  const completedCount =
    meta?.pipelineCounts?.completed ?? (items ? items.filter((a) => a.status === 'ACTIVATION_COMPLETED').length : 0)

  const kpiGrid = (
    <KpiGrid count={4}>
      <KpiRefCard
        label="Total Requests"
        value={!items ? '—' : totalCount}
        badge="All Time"
        desc="Activation requests recorded"
        accent="indigo"
        active={status === ''}
        onClick={() => changeStatus('')}
        title="Filter by all activation requests"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>}
      />
      <KpiRefCard
        label="Pending Review"
        value={!items ? '—' : pendingReviewCount}
        badge="Queue"
        desc="Awaiting admin review"
        accent="amber"
        active={status === 'PENDING_REVIEW'}
        onClick={() => changeStatus('PENDING_REVIEW')}
        title="Filter by Pending Review"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}
      />
      <KpiRefCard
        label="Under Review"
        value={!items ? '—' : underReviewCount}
        badge="In Review"
        desc="Payment under verification"
        accent="violet"
        active={status === 'UNDER_REVIEW'}
        onClick={() => changeStatus('UNDER_REVIEW')}
        title="Filter by Under Review"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>}
      />
      <KpiRefCard
        label="Completed"
        value={!items ? '—' : completedCount}
        badge="Activated"
        badgeTone="positive"
        desc="Subscriptions live in SaaS"
        accent="emerald"
        active={status === 'ACTIVATION_COMPLETED'}
        onClick={() => changeStatus('ACTIVATION_COMPLETED')}
        title="Filter by Completed"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>}
      />
    </KpiGrid>
  )

  return (
    <>
      {heroProps ? <PageHero {...heroProps}>{kpiGrid}</PageHero> : kpiGrid}

      {error && (
        <div className="alert error">
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
          <label htmlFor="ar-search">Search</label>
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
              id="ar-search"
              type="text"
              placeholder="Reference, bank reference or customer…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="field inline" style={{ flex: '1 1 200px', minWidth: '160px', maxWidth: '240px' }}>
          <label htmlFor="ar-status">Status</label>
          <select id="ar-status" value={status} onChange={(e) => changeStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-actions">
          {filtering && (
            <button
              type="button"
              className="btn link small"
              onClick={clearFilters}
              style={{ padding: '0.4rem 0.5rem', whiteSpace: 'nowrap' }}
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
        <>
          <EmptyState title="No activation requests found" hint={emptyHint}>
            {basePath === '/activations' && (
              <Link href="/activations/new" className="btn primary">
                New Activation Request
              </Link>
            )}
          </EmptyState>
          {meta && meta.totalPages > 1 && (
            <div className="table-wrap">
              <Pagination meta={meta} onPage={setPage} noun="requests" busy={loading} />
            </div>
          )}
        </>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Product</th>
                {showReseller && <th>Partner</th>}
                <th>Month</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="mono">
                    <Link href={`${basePath}/${a.id}`}>{a.reference}</Link>
                  </td>
                  <td>{a.customerAccount.customer.displayName}</td>
                  <td>{a.product.name}</td>
                  {showReseller && (
                    <td className="small">
                      {a.reseller.businessName}
                      <div className="muted mono">{a.reseller.code}</div>
                    </td>
                  )}
                  <td>{monthLabel(a.periodMonth)}</td>
                  <td className="num">{formatMoney(a.amount, a.currency)}</td>
                  <td>
                    <span className={`badge act-${a.status}`}>{ACTIVATION_STATUS_LABELS[a.status]}</span>
                    {a.status === 'UNDER_REVIEW' && a.paymentVerifiedAt && <div className="small muted">Payment verified</div>}
                  </td>
                  <td className="small">{formatDate(a.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination meta={meta} onPage={setPage} noun="requests" busy={loading} />
        </div>
      )}
    </>
  )
}
