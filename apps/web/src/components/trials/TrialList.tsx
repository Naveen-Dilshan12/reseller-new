'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiRequest, api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/format'
import {
  emptyOwner,
  TRIAL_STATUS_LABELS,
  validateOwner,
  type TrialOutcomeResult,
  type TrialOwner,
  type TrialRequest,
  type TrialStatus,
} from '@/lib/trial-types'
import { OwnerFields } from './OwnerFields'

interface Props {
  showReseller?: boolean
  /** Retry / cancel (reseller users and platform users with trials:create). */
  canAct: boolean
  refreshKey?: number
}

const canSync = (t: TrialRequest) =>
  t.status === 'SUBMITTED' || t.status === 'PENDING' || (t.status === 'FAILED' && t.errorRetryable === true)

export function TrialList({ showReseller, canAct, refreshKey }: Props) {
  const [items, setItems] = useState<TrialRequest[] | null>(null)
  const [status, setStatus] = useState<TrialStatus | ''>('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [retrying, setRetrying] = useState<TrialRequest | null>(null)
  const [owner, setOwner] = useState<TrialOwner>(emptyOwner)
  const [ownerErrors, setOwnerErrors] = useState<Record<string, string>>({})
  const [dialogError, setDialogError] = useState<string | null>(null)

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (status) params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    apiRequest<TrialRequest[]>(`/trials?${params}`)
      .then((r) => {
        setItems(r.data)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load trial requests'))
  }, [status, search])

  useEffect(load, [status, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const report = (r: TrialOutcomeResult) =>
    setMessage({ kind: r.outcome === 'PROVISIONED' ? 'success' : r.outcome === 'FAILED' ? 'error' : 'info', text: r.message })

  const sync = async (t: TrialRequest) => {
    setBusyId(t.id)
    try {
      report(await api<TrialOutcomeResult>(`/trials/${t.id}/sync`, { method: 'POST' }))
      load()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Status check failed' })
    } finally {
      setBusyId(null)
    }
  }

  const cancel = async (t: TrialRequest) => {
    if (!confirm(`Cancel the ${t.product.name} trial request for ${t.customerAccount.customer.displayName}?`)) return
    setBusyId(t.id)
    try {
      await api(`/trials/${t.id}/cancel`, { method: 'POST' })
      setMessage({ kind: 'info', text: 'Trial request cancelled.' })
      load()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Cancel failed' })
    } finally {
      setBusyId(null)
    }
  }

  const openRetry = (t: TrialRequest) => {
    setOwner({ ...emptyOwner, businessName: t.customerAccount.customer.displayName })
    setOwnerErrors({})
    setDialogError(null)
    setRetrying(t)
  }

  const submitRetry = async () => {
    if (!retrying) return
    const errors = validateOwner(owner)
    setOwnerErrors(errors)
    if (Object.keys(errors).length) return
    setBusyId(retrying.id)
    setDialogError(null)
    try {
      const result = await api<TrialOutcomeResult>(`/trials/${retrying.id}/retry`, { method: 'POST', body: JSON.stringify({ owner }) })
      report(result)
      setRetrying(null)
      setOwner(emptyOwner)
      load()
    } catch (err) {
      if (err instanceof ApiError) {
        setOwnerErrors(err.fieldErrors())
        setDialogError(err.message)
      } else setDialogError('Retry failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      {message && <div className={`alert ${message.kind}`}>{message.text}</div>}
      {error && <div className="alert error">{error}</div>}

      <form
        className="row"
        style={{ marginBottom: '0.75rem' }}
        onSubmit={(e) => {
          e.preventDefault()
          load()
        }}
      >
        <div className="field inline">
          <label htmlFor="tr-status">Status</label>
          <select id="tr-status" value={status} onChange={(e) => setStatus(e.target.value as TrialStatus | '')}>
            <option value="">All</option>
            {(Object.keys(TRIAL_STATUS_LABELS) as TrialStatus[]).map((s) => (
              <option key={s} value={s}>
                {TRIAL_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field inline" style={{ flex: 1 }}>
          <label htmlFor="tr-search">Search</label>
          <input id="tr-search" placeholder="Customer or tenant ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn secondary" type="submit">
          Search
        </button>
      </form>

      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No trial requests.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Product</th>
                {showReseller && <th>Reseller</th>}
                <th>Status</th>
                <th>SaaS tenant</th>
                <th>Requested</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.customerAccount.customer.displayName}</td>
                  <td>{t.product.name}</td>
                  {showReseller && (
                    <td className="small">
                      {t.reseller.businessName}
                      <div className="muted mono">{t.reseller.code}</div>
                    </td>
                  )}
                  <td>
                    <span className={`badge trial-${t.status}`}>{TRIAL_STATUS_LABELS[t.status]}</span>
                    {t.errorMessage && t.status === 'FAILED' && <div className="small negative">{t.errorMessage}</div>}
                    {t.attempts > 1 && <div className="muted small">{t.attempts} attempts</div>}
                  </td>
                  <td className="small mono">
                    {t.customerAccount.externalTenantId ?? '—'}
                    {t.customerAccount.externalAccountId && <div className="muted">owner {t.customerAccount.externalAccountId}</div>}
                  </td>
                  <td className="small">{formatDate(t.createdAt)}</td>
                  <td>
                    <div className="row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
                      {canSync(t) && (
                        <button className="btn link small" disabled={busyId === t.id} onClick={() => sync(t)}>
                          Check status
                        </button>
                      )}
                      {canAct && t.status === 'FAILED' && (
                        <>
                          <button className="btn link small" disabled={busyId === t.id} onClick={() => openRetry(t)}>
                            Retry
                          </button>
                          <button className="btn link small" disabled={busyId === t.id} onClick={() => cancel(t)}>
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {retrying && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <h2>Retry trial – {retrying.product.name}</h2>
            <p className="small muted">
              {retrying.customerAccount.customer.displayName}. For privacy the owner details were not stored, so please enter
              them again.
            </p>
            {retrying.errorMessage && <div className="alert warning small">Last error: {retrying.errorMessage}</div>}
            {dialogError && <div className="alert error">{dialogError}</div>}
            <OwnerFields value={owner} errors={ownerErrors} onChange={setOwner} />
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setRetrying(null)} disabled={busyId === retrying.id}>
                Close
              </button>
              <button className="btn" onClick={submitRetry} disabled={busyId === retrying.id}>
                {busyId === retrying.id ? 'Creating…' : 'Retry trial'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
