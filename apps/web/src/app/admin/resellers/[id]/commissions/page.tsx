'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { businessDate, formatMoney } from '@/lib/format'
import type { CommissionSummary } from '@/lib/commission-types'
import { Tabs } from '@/components/Tabs'
import { LevelSummary } from '@/components/commissions/LevelSummary'
import { CommissionLedger } from '@/components/commissions/CommissionLedger'
import { CustomerCommissions } from '@/components/commissions/CustomerCommissions'
import { MonthlyReport } from '@/components/commissions/MonthlyReport'
import { PayoutHistory } from '@/components/commissions/PayoutHistory'
import { Modal } from '@/components/ui/Modal'

type Tab = 'history' | 'customers' | 'monthly' | 'payouts'

export default function ResellerCommissionsAdminPage() {
  const { id } = useParams<{ id: string }>()
  const admin = useAdminUser()
  const canManage = admin.permissions.includes('commissions:manage')

  const [summary, setSummary] = useState<CommissionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('history')
  const [refreshKey, setRefreshKey] = useState(0)
  const [payOpen, setPayOpen] = useState(false)
  const [payment, setPayment] = useState({ reference: '', paidAt: businessDate(), note: '' })
  const [payError, setPayError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api<CommissionSummary>(`/commissions/summary?resellerId=${id}`)
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load'))
  }, [id])

  useEffect(load, [load, refreshKey])

  const refresh = () => setRefreshKey((k) => k + 1)

  const pay = async () => {
    setPayError(null)
    if (payment.reference.trim().length < 3) {
      setPayError('Enter the bank transfer / payment reference.')
      return
    }
    if (!payment.paidAt) {
      setPayError('Enter the date the payment was made.')
      return
    }
    if (payment.paidAt > businessDate()) {
      setPayError('Payment date cannot be in the future.')
      return
    }
    setBusy(true)
    try {
      const result = await api<{ totalAmount: string; entries: number }>('/commissions/payouts', {
        method: 'POST',
        body: JSON.stringify({
          resellerId: id,
          paymentReference: payment.reference.trim(),
          paidAt: payment.paidAt,
          ...(payment.note.trim() ? { note: payment.note.trim() } : {}),
        }),
      })
      setMessage(`Payout of ${formatMoney(result.totalAmount)} recorded for ${result.entries} commission entries.`)
      setPayOpen(false)
      setPayment({ reference: '', paidAt: businessDate(), note: '' })
      refresh()
    } catch (err) {
      setPayError(
        err instanceof ApiError
          ? err.status === 422 && err.errors.length
            ? err.errors.map((e) => e.replace(/^[\w.]+: /, '')).join(' ')
            : err.message
          : 'Payout failed',
      )
    } finally {
      setBusy(false)
    }
  }

  if (error) return <main className="container"><div className="alert error">{error}</div></main>
  if (!summary) return <main className="container muted">Loading…</main>

  const payable = Number(summary.totals.payable)

  return (
    <main className="container">
      <Link href={`/admin/reseller-applications/${id}`} className="small">
        ← Partner profile
      </Link>
      {' · '}
      <Link href={`/admin/resellers/${id}/products`} className="small">
        Product access
      </Link>
      <div className="row" style={{ margin: '0.75rem 0 1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>{summary.reseller.businessName}</h1>
          <span className="muted small mono">{summary.reseller.code}</span>
        </div>
        <span className="spacer" />
        {canManage && (
          <button className="btn success" disabled={payable <= 0} onClick={() => setPayOpen(true)}>
            Pay {formatMoney(summary.totals.payable)}
          </button>
        )}
      </div>

      {message && <div className="alert success">{message}</div>}

      <LevelSummary summary={summary} />

      <div className="card">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'history', label: 'Commission history' },
            { key: 'customers', label: 'By customer' },
            { key: 'monthly', label: 'Monthly' },
            { key: 'payouts', label: 'Payouts' },
          ]}
        />
        {tab === 'history' && <CommissionLedger resellerId={id} manage={canManage} refreshKey={refreshKey} onChanged={refresh} />}
        {tab === 'customers' && <CustomerCommissions resellerId={id} />}
        {tab === 'monthly' && <MonthlyReport resellerId={id} />}
        {tab === 'payouts' && <PayoutHistory resellerId={id} refreshKey={refreshKey} />}
      </div>

      {payOpen && (
        <Modal label={'Record commission payout'} onClose={() => setPayOpen(false)}>
            <h2>Record commission payout</h2>
            <p>
              All payable entries (net of clawbacks) will be marked as paid:{' '}
              <strong>{formatMoney(summary.totals.payable)}</strong>
            </p>
            {payError && <div className="alert error">{payError}</div>}
            <div className="field">
              <label htmlFor="pay-ref">Payment reference</label>
              <input
                id="pay-ref"
                placeholder="Bank transfer reference"
                value={payment.reference}
                onChange={(e) => setPayment((p) => ({ ...p, reference: e.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="pay-date">Paid on</label>
              <input
                id="pay-date"
                type="date"
                max={businessDate()}
                value={payment.paidAt}
                onChange={(e) => setPayment((p) => ({ ...p, paidAt: e.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="pay-note">Note (optional)</label>
              <textarea id="pay-note" rows={2} value={payment.note} onChange={(e) => setPayment((p) => ({ ...p, note: e.target.value }))} />
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setPayOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn success" onClick={pay} disabled={busy}>
                {busy ? 'Saving…' : 'Mark as paid'}
              </button>
            </div>
        </Modal>
      )}
    </main>
  )
}
