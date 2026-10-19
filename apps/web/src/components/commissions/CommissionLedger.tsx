'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, apiRequest, ApiError } from '@/lib/api'
import { formatDate, formatMoney, monthLabel } from '@/lib/format'
import type { CommissionEntry } from '@/lib/commission-types'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'

const STATUSES = ['', 'PENDING', 'APPROVED', 'PAYABLE', 'PAID', 'REVERSED']
const REASON_MIN = 5
const REASON_MAX = 500

interface Props {
  resellerId?: string
  /** Enables approve / reverse actions. */
  manage?: boolean
  showReseller?: boolean
  /** Adds a "Reseller" filter (all-resellers admin view). Ignored when `resellerId` already fixes the reseller. */
  filterByReseller?: boolean
  initialStatus?: string
  /** Changing this value reloads the table. */
  refreshKey?: number
  onChanged?: () => void
}

interface ResellerOption {
  id: string
  code: string
  businessName: string
  status: string
}

/** The admin resellers list answers at most 100 per page; a handful of pages is far more than the network has. */
const RESELLER_PAGE_SIZE = 100
const RESELLER_MAX_PAGES = 20

interface Loaded {
  /** Which page + filters this answer is for; an answer is only shown while it still matches the screen. */
  key: string
  items: CommissionEntry[]
  meta: { total: number; totalPages: number; netAmount: string }
}

/** What the server said, in plain words: validation errors list the offending rule instead of just "Validation error". */
const problemOf = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.status === 422 && err.errors.length ? err.errors.map((e) => e.replace(/^[\w.]+: /, '')).join(' ') : err.message) : fallback

export function CommissionLedger({ resellerId: fixedResellerId, manage, showReseller, filterByReseller, initialStatus = '', refreshKey, onChanged }: Props) {
  const [status, setStatus] = useState(initialStatus)
  const [chosenReseller, setChosenReseller] = useState('')
  const [resellers, setResellers] = useState<ResellerOption[] | null>(null)
  const [resellersError, setResellersError] = useState<string | null>(null)
  const canPick = Boolean(filterByReseller && !fixedResellerId)
  // The reseller the table is about: fixed by the page, or picked in the filter (empty = all).
  const resellerId = fixedResellerId ?? (canPick && chosenReseller ? chosenReseller : undefined)
  const [month, setMonth] = useState('')
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [reversing, setReversing] = useState<CommissionEntry | null>(null)
  const [reason, setReason] = useState('')
  const [reverseError, setReverseError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Only the newest request may update the screen: a slow answer for an old filter must not replace a newer one.
  const latestRequest = useRef(0)

  const loadResellers = useCallback(() => {
    if (!canPick) return
    setResellersError(null)
    ;(async () => {
      const all: ResellerOption[] = []
      for (let page = 1; page <= RESELLER_MAX_PAGES; page++) {
        const res = await apiRequest<ResellerOption[]>(`/admin/resellers?page=${page}&limit=${RESELLER_PAGE_SIZE}`)
        all.push(...res.data)
        if (page >= (res.meta?.totalPages || 1)) break
      }
      setResellers(all.sort((a, b) => a.businessName.localeCompare(b.businessName) || a.code.localeCompare(b.code)))
    })().catch((err) => setResellersError(err instanceof ApiError ? err.message : 'Could not load the partner list'))
  }, [canPick])
  useEffect(() => {
    loadResellers()
  }, [loadResellers])

  const key = [page, status, month, resellerId ?? ''].join('|')

  const load = useCallback(() => {
    const requestKey = [page, status, month, resellerId ?? ''].join('|')
    const request = ++latestRequest.current
    const params = new URLSearchParams({ page: String(page), limit: '25' })
    if (status) params.set('status', status)
    if (month) params.set('periodMonth', month)
    if (resellerId) params.set('resellerId', resellerId)
    setLoadError(null)
    apiRequest<CommissionEntry[]>(`/commissions?${params}`)
      .then((res) => {
        if (request !== latestRequest.current) return
        const totalPages = res.meta?.totalPages || 1
        // The last entries of a page were approved or reversed, so the page no longer exists: go to the last real one.
        if (res.data.length === 0 && page > totalPages) {
          setPage(totalPages)
          return
        }
        setLoaded({
          key: requestKey,
          items: res.data,
          meta: { total: res.meta?.total ?? 0, totalPages, netAmount: String(res.meta?.netAmount ?? '0') },
        })
        setSelected(new Set())
      })
      .catch((err) => {
        if (request !== latestRequest.current) return
        // Rows that may be out of date are not left on screen next to an error.
        setLoaded(null)
        setLoadError({ key: requestKey, message: err instanceof ApiError ? err.message : 'Failed to load commissions' })
      })
  }, [page, status, month, resellerId])

  useEffect(load, [load, refreshKey])

  const current = loaded?.key === key ? loaded : null
  const failed = loadError?.key === key ? loadError.message : null
  const items = current?.items ?? []
  const meta = current?.meta ?? { total: 0, totalPages: 1, netAmount: '0' }

  const pendingIds = items.filter((i) => i.status === 'PENDING').map((i) => i.id)
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** A different filter or page shows different rows, so a selection made on the old ones is dropped at once. */
  const changeView = (apply: () => void) => {
    apply()
    setSelected(new Set())
    setNotice(null)
  }

  const approve = async () => {
    if (busy || selected.size === 0) return
    setBusy(true)
    setNotice(null)
    try {
      const r = await api<{ approved: number; payable: number; skipped: number }>('/commissions/approve', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected] }),
      })
      const skipped = r.skipped > 0 ? ` ${r.skipped} selected ${r.skipped === 1 ? 'entry was' : 'entries were'} no longer pending and left unchanged.` : ''
      setNotice({
        kind: 'success',
        text: `Approved ${r.approved + r.payable} commission(s): ${r.payable} payable now, ${r.approved} on refund hold.${skipped}`,
      })
      load()
      onChanged?.()
    } catch (err) {
      setNotice({ kind: 'error', text: problemOf(err, 'Approval failed') })
      // "No pending commissions" means someone else already dealt with them: show the list as it is now.
      if (err instanceof ApiError && err.status === 409) load()
    } finally {
      setBusy(false)
    }
  }

  const openReverse = (entry: CommissionEntry) => {
    setReversing(entry)
    setReason('')
    setReverseError(null)
  }

  const reverse = async () => {
    if (!reversing || busy || reason.trim().length < REASON_MIN) return
    setBusy(true)
    setReverseError(null)
    try {
      await api(`/commissions/${reversing.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) })
      setNotice({
        kind: 'success',
        text: reversing.status === 'PAID' ? 'Paid commission reversed: a clawback was added to the next payout.' : 'Commission reversed.',
      })
      setReversing(null)
      setReason('')
      load()
      onChanged?.()
    } catch (err) {
      // Shown inside the dialog: an alert on the page behind it would not be seen.
      setReverseError(problemOf(err, 'Reversal failed'))
      if (err instanceof ApiError && err.status === 409) load() // it was changed elsewhere (paid / reversed already)
    } finally {
      setBusy(false)
    }
  }

  const filtered = Boolean(status || month || resellerId)

  return (
    <div>
      <div className="filter-bar">
        {canPick && (
          <div className="field inline">
            <label htmlFor="ledger-reseller">Partner</label>
            <select
              id="ledger-reseller"
              value={chosenReseller}
              disabled={!resellers && !resellersError}
              onChange={(e) =>
                changeView(() => {
                  setChosenReseller(e.target.value)
                  setPage(1)
                })
              }
            >
              <option value="">{resellers || resellersError ? 'All partners' : 'Loading partners…'}</option>
              {(resellers ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.businessName} ({r.code}){r.status === 'ACTIVE' ? '' : ` · ${r.status.toLowerCase()}`}
                </option>
              ))}
            </select>
            {resellersError && (
              <>
                <span className="small negative">{resellersError}</span>
                <button className="btn link small" onClick={loadResellers}>
                  Retry loading partners
                </button>
              </>
            )}
          </div>
        )}
        <div className="field inline">
          <label htmlFor="ledger-status">Status</label>
          <select
            id="ledger-status"
            value={status}
            onChange={(e) =>
              changeView(() => {
                setStatus(e.target.value)
                setPage(1)
              })
            }
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div className="field inline">
          <label htmlFor="ledger-month">Month</label>
          <input
            id="ledger-month"
            type="month"
            value={month}
            onChange={(e) =>
              changeView(() => {
                setMonth(e.target.value)
                setPage(1)
              })
            }
          />
        </div>
        <span className="spacer" />
        {current && (
          <span className="small muted">
            {meta.total} entries · net {formatMoney(meta.netAmount)}
          </span>
        )}
        {manage && (
          <button className="btn" disabled={selected.size === 0 || busy} onClick={approve}>
            Approve selected ({selected.size})
          </button>
        )}
      </div>

      {notice && <div className={`alert ${notice.kind}`}>{notice.text}</div>}

      {failed ? (
        <div>
          <div className="alert error">{failed}</div>
          <button className="btn secondary small" onClick={load}>
            Retry
          </button>
        </div>
      ) : !current ? (
        <p className="muted">Loading commissions…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No commission entries match' : 'No commission entries'}
          hint={
            filtered
              ? canPick
                ? 'Try another status, month or partner.'
                : 'Try another status or month.'
              : 'Commission entries will appear here once customer subscriptions are activated and verified.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {manage && (
                  <th>
                    <input
                      id="select-all-pending"
                      type="checkbox"
                      aria-label="Select all pending"
                      disabled={pendingIds.length === 0}
                      checked={pendingIds.length > 0 && pendingIds.every((id) => selected.has(id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(pendingIds) : new Set())}
                    />
                  </th>
                )}
                <th>Month</th>
                {showReseller && <th>Partner</th>}
                <th>Customer</th>
                <th>Level / rate</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Status</th>
                <th>Details</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  {manage && (
                    <td>
                      {c.status === 'PENDING' && (
                        <input id={`select-${c.id}`} type="checkbox" aria-label="Select" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      )}
                    </td>
                  )}
                  <td>{monthLabel(c.periodMonth)}</td>
                  {showReseller && (
                    <td>
                      {c.reseller.businessName}
                      <div className="muted small mono">{c.reseller.code}</div>
                    </td>
                  )}
                  <td>
                    {c.customerAccount.customer.displayName}
                    <div className="muted small">{c.product.name}</div>
                  </td>
                  <td className="small">
                    {c.entryType === 'CLAWBACK' ? 'Clawback' : `L${c.level} · ${Number(c.rate)}% of ${formatMoney(c.baseAmount, c.currency)}`}
                  </td>
                  <td style={{ textAlign: 'right' }} className={Number(c.amount) < 0 ? 'negative' : undefined}>
                    {formatMoney(c.amount, c.currency)}
                  </td>
                  <td>
                    <span className={`badge ${c.status}`}>{c.status}</span>
                    {c.reversedAt && c.status === 'PAID' && <div className="small negative">clawed back</div>}
                  </td>
                  <td className="small muted">
                    {c.status === 'APPROVED' && `Payable from ${formatDate(c.payableAt)}`}
                    {c.payout && `Ref ${c.payout.paymentReference} · ${formatDate(c.payout.paidAt)}`}
                    {c.reversalReason && <div>{c.reversalReason}</div>}
                  </td>
                  {manage && (
                    <td>
                      {c.entryType === 'EARNING' && c.status !== 'REVERSED' && !c.reversedAt && (
                        <button className="btn link small" onClick={() => openReverse(c)}>
                          Reverse
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current && meta.totalPages > 1 && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <span className="spacer" />
          <button className="btn secondary" disabled={page <= 1} onClick={() => changeView(() => setPage((p) => p - 1))}>
            Previous
          </button>
          <span className="small muted">
            {page} / {meta.totalPages}
          </span>
          <button className="btn secondary" disabled={page >= meta.totalPages} onClick={() => changeView(() => setPage((p) => p + 1))}>
            Next
          </button>
        </div>
      )}

      {reversing && (
        <Modal
          label={'Reverse commission'}
          onClose={() => {
            if (!busy) setReversing(null) // Escape is ignored while the request is in flight
          }}
        >
            <h2>Reverse commission</h2>
            <p className="small muted">
              {reversing.customerAccount.customer.displayName} · {monthLabel(reversing.periodMonth)} ·{' '}
              {formatMoney(reversing.amount, reversing.currency)}
            </p>
            {reversing.status === 'PAID' && (
              <div className="alert warning">
                This commission was already paid. A clawback of {formatMoney(reversing.amount, reversing.currency)} will be
                deducted from the partner&apos;s next payout.
              </div>
            )}
            <div className="field">
              <label htmlFor="reverse-reason">Reason</label>
              <textarea
                id="reverse-reason"
                rows={3}
                maxLength={REASON_MAX}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value)
                  setReverseError(null)
                }}
              />
              <span className="hint">Minimum {REASON_MIN} characters. Visible to the partner.</span>
            </div>
            {reverseError && <div className="alert error">{reverseError}</div>}
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setReversing(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={reverse} disabled={busy || reason.trim().length < REASON_MIN}>
                {busy ? 'Reversing…' : 'Reverse commission'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )
}
