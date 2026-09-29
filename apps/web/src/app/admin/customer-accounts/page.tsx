'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api, apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { currentPeriod, formatDate, formatMoney, monthLabel } from '@/lib/format'

interface Account {
  id: string
  externalTenantId: string | null
  externalAccountId: string | null
  status: string
  activatedAt: string | null
  customer: { id: string; displayName: string }
  product: { id: string; code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
  resellerId: string
}

type LiveStatus =
  | { available: false; reason: string }
  | { available: true; fetchedAt: string; status: { status: string; rawStatus: string | null; plan: string | null; trialEndsAt: string | null } }

interface Option {
  id: string
  label: string
}

type EventType = 'PAYMENT_VERIFIED' | 'CANCELLED' | 'REFUNDED'

const EVENT_LABELS: Record<EventType, string> = {
  PAYMENT_VERIFIED: 'Payment verified (subscription active)',
  CANCELLED: 'Subscription cancelled (no refund)',
  REFUNDED: 'Payment refunded',
}

const emptyLink = {
  resellerId: '',
  productId: '',
  customerId: '',
  customerName: '',
  externalTenantId: '',
  externalAccountId: '',
  status: 'TRIAL',
}

export default function CustomerAccountsPage() {
  const admin = useAdminUser()
  const canLink = admin.permissions.includes('accounts:manage')
  const canRecord = admin.permissions.includes('subscriptions:record')

  const [items, setItems] = useState<Account[]>([])
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [resellers, setResellers] = useState<Option[]>([])
  const [products, setProducts] = useState<Option[]>([])
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState(emptyLink)
  const [customers, setCustomers] = useState<Option[]>([])
  const [live, setLive] = useState<Record<string, LiveStatus | 'loading' | { error: string }>>({})

  useEffect(() => {
    setCustomers([])
    if (!link.resellerId) return
    api<{ id: string; displayName: string }[]>(`/customers?resellerId=${link.resellerId}&limit=100`)
      .then((r) => setCustomers(r.map((c) => ({ id: c.id, label: c.displayName }))))
      .catch(() => setCustomers([]))
  }, [link.resellerId])

  const checkLive = async (id: string) => {
    setLive((s) => ({ ...s, [id]: 'loading' }))
    try {
      const result = await api<LiveStatus>(`/customer-accounts/${id}/live-status`)
      setLive((s) => ({ ...s, [id]: result }))
    } catch (err) {
      setLive((s) => ({ ...s, [id]: { error: err instanceof ApiError ? err.message : 'Failed' } }))
    }
  }

  const [eventFor, setEventFor] = useState<Account | null>(null)
  const [event, setEvent] = useState({ type: 'PAYMENT_VERIFIED' as EventType, periodMonth: currentPeriod(), externalRef: '', note: '', endSubscription: true })
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (status) params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    apiRequest<Account[]>(`/customer-accounts?${params}`)
      .then((r) => {
        setItems(r.data)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load customers'))
  }, [status, search])

  useEffect(load, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  const openLink = async () => {
    setDialogError(null)
    setLinkOpen(true)
    if (resellers.length === 0) {
      const [r, p] = await Promise.all([
        api<{ id: string; businessName: string; code: string }[]>('/admin/reseller-applications?status=ACTIVE&limit=100'),
        api<{ id: string; name: string; status: string }[]>('/products'),
      ])
      setResellers(r.map((x) => ({ id: x.id, label: `${x.businessName} (${x.code})` })))
      setProducts(p.filter((x) => x.status === 'ACTIVE').map((x) => ({ id: x.id, label: x.name })))
    }
  }

  const submitLink = async () => {
    setBusy(true)
    setDialogError(null)
    try {
      const body: Record<string, string> = {
        resellerId: link.resellerId,
        productId: link.productId,
        externalTenantId: link.externalTenantId.trim(),
        status: link.status,
      }
      if (link.customerId) body.customerId = link.customerId
      else body.customerName = link.customerName.trim()
      if (link.externalAccountId.trim()) body.externalAccountId = link.externalAccountId.trim()
      const created = await api<Account>('/customer-accounts', { method: 'POST', body: JSON.stringify(body) })
      setMessage(`${created.customer.displayName} linked to ${created.product.name}.`)
      setLinkOpen(false)
      setLink(emptyLink)
      load()
    } catch (err) {
      setDialogError(err instanceof ApiError ? (err.errors[0] ?? err.message) : 'Failed to link account')
    } finally {
      setBusy(false)
    }
  }

  const submitEvent = async () => {
    if (!eventFor) return
    setBusy(true)
    setDialogError(null)
    try {
      const result = await api<{
        commission: { amount: string; currency: string } | null
        reversed: { id: string }[]
        level: { level: number | null; activeCustomerCount: number; changed: boolean }
      }>('/subscription-events', {
        method: 'POST',
        body: JSON.stringify({
          customerAccountId: eventFor.id,
          type: event.type,
          periodMonth: event.periodMonth,
          ...(event.externalRef.trim() ? { externalRef: event.externalRef.trim() } : {}),
          ...(event.note.trim() ? { note: event.note.trim() } : {}),
          ...(event.type === 'REFUNDED' ? { endSubscription: event.endSubscription } : {}),
        }),
      })
      const parts = [`${EVENT_LABELS[event.type]} recorded for ${eventFor.customer.displayName}.`]
      if (result.commission) parts.push(`Commission ${formatMoney(result.commission.amount, result.commission.currency)} generated (pending approval).`)
      if (result.reversed.length) parts.push(`${result.reversed.length} commission(s) reversed.`)
      parts.push(
        `Reseller now has ${result.level.activeCustomerCount} active customers${result.level.level ? ` (Level ${result.level.level})` : ''}${result.level.changed ? ' – level changed' : ''}.`,
      )
      setMessage(parts.join(' '))
      setEventFor(null)
      load()
    } catch (err) {
      setDialogError(err instanceof ApiError ? (err.errors[0] ?? err.message) : 'Failed to record event')
    } finally {
      setBusy(false)
    }
  }

  const linkField = (key: keyof typeof emptyLink, label: string, hint?: string) => (
    <div className="field">
      <label htmlFor={`link-${key}`}>{label}</label>
      <input id={`link-${key}`} value={link[key]} onChange={(e) => setLink((l) => ({ ...l, [key]: e.target.value }))} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  )

  const renderLive = (id: string) => {
    const state = live[id]
    if (!state) return null
    if (state === 'loading') return <div className="muted small">Checking…</div>
    if ('error' in state) return <div className="small negative">{state.error}</div>
    if (!state.available) return <div className="muted small">{state.reason}</div>
    return (
      <div className="small">
        SaaS: <strong>{state.status.status}</strong>
        {state.status.plan && ` · ${state.status.plan}`}
        {state.status.trialEndsAt && ` · trial ends ${formatDate(state.status.trialEndsAt)}`}
      </div>
    )
  }

  return (
    <main className="container">
      <div className="row" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Customer accounts</h1>
        <span className="spacer" />
        {canLink && (
          <button className="btn" onClick={openLink}>
            Link SaaS account
          </button>
        )}
      </div>
      <p className="muted">
        Each row maps a reseller&apos;s customer to a tenant in a Hexalyte SaaS. Only identifiers are stored here; the
        customer&apos;s business data stays in the SaaS. Record subscription outcomes only after the payment has been verified
        and the account activated in the SaaS.
      </p>

      {message && <div className="alert success">{message}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <form
          className="row"
          style={{ marginBottom: '0.75rem' }}
          onSubmit={(e) => {
            e.preventDefault()
            load()
          }}
        >
          <div className="field inline">
            <label htmlFor="acc-status">Status</label>
            <select id="acc-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {['', 'PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'].map((s) => (
                <option key={s} value={s}>
                  {s || 'All'}
                </option>
              ))}
            </select>
          </div>
          <div className="field inline" style={{ flex: 1 }}>
            <label htmlFor="acc-search">Search</label>
            <input id="acc-search" placeholder="Customer name, tenant ID or account ID" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>

        {items.length === 0 ? (
          <p className="muted">No customer accounts.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Product / external IDs</th>
                  <th>Reseller</th>
                  <th>Status</th>
                  <th>Active since</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>{a.customer.displayName}</td>
                    <td>
                      {a.product.name}
                      <div className="muted small mono">tenant {a.externalTenantId ?? '—'}</div>
                      {a.externalAccountId && <div className="muted small mono">account {a.externalAccountId}</div>}
                    </td>
                    <td>
                      <Link href={`/admin/resellers/${a.resellerId}/commissions`}>{a.reseller.businessName}</Link>
                    </td>
                    <td>
                      <span className={`badge sub-${a.status}`}>{a.status}</span>
                      {renderLive(a.id)}
                    </td>
                    <td className="small">{formatDate(a.activatedAt)}</td>
                    <td>
                      {a.externalTenantId && (
                        <button className="btn link small" onClick={() => checkLive(a.id)}>
                          Live status
                        </button>
                      )}
                      {canRecord && (
                        <button
                          className="btn link small"
                          onClick={() => {
                            setDialogError(null)
                            setEvent({ type: 'PAYMENT_VERIFIED', periodMonth: currentPeriod(), externalRef: '', note: '', endSubscription: true })
                            setEventFor(a)
                          }}
                        >
                          Record subscription event
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {linkOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <h2>Link SaaS account to reseller</h2>
            {dialogError && <div className="alert error">{dialogError}</div>}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="link-reseller">Reseller</label>
                <select
                  id="link-reseller"
                  value={link.resellerId}
                  onChange={(e) => setLink((l) => ({ ...l, resellerId: e.target.value, customerId: '' }))}
                >
                  <option value="">Select…</option>
                  {resellers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="link-product">Product</label>
                <select id="link-product" value={link.productId} onChange={(e) => setLink((l) => ({ ...l, productId: e.target.value }))}>
                  <option value="">Select…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="link-customer">Customer</label>
                <select
                  id="link-customer"
                  value={link.customerId}
                  disabled={!link.resellerId}
                  onChange={(e) => setLink((l) => ({ ...l, customerId: e.target.value }))}
                >
                  <option value="">New customer…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              {link.customerId ? (
                <div />
              ) : (
                linkField('customerName', 'New customer name', 'Reseller-side reference only')
              )}
              {linkField('externalTenantId', 'External tenant ID', 'Tenant ID inside the SaaS')}
              {linkField('externalAccountId', 'External account ID (optional)', 'Owner / admin user ID inside the SaaS')}
              <div className="field">
                <label htmlFor="link-status">Current status</label>
                <select id="link-status" value={link.status} onChange={(e) => setLink((l) => ({ ...l, status: e.target.value }))}>
                  <option value="TRIAL">Trial</option>
                  <option value="PENDING">Pending</option>
                </select>
                <span className="hint">Paid accounts become ACTIVE via a “Payment verified” event.</span>
              </div>
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setLinkOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={submitLink} disabled={busy}>
                Link account
              </button>
            </div>
          </div>
        </div>
      )}

      {eventFor && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Record subscription event</h2>
            <p className="small muted">
              {eventFor.customer.displayName} · {eventFor.product.name} · {eventFor.reseller.businessName}
            </p>
            {dialogError && <div className="alert error">{dialogError}</div>}
            <div className="field">
              <label htmlFor="ev-type">Event</label>
              <select id="ev-type" value={event.type} onChange={(e) => setEvent((s) => ({ ...s, type: e.target.value as EventType }))}>
                {(Object.keys(EVENT_LABELS) as EventType[]).map((t) => (
                  <option key={t} value={t}>
                    {EVENT_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ev-month">Billing month</label>
              <input id="ev-month" type="month" value={event.periodMonth} onChange={(e) => setEvent((s) => ({ ...s, periodMonth: e.target.value }))} />
              <span className="hint">{event.periodMonth && monthLabel(event.periodMonth)}</span>
            </div>
            <div className="field">
              <label htmlFor="ev-ref">SaaS payment / invoice reference</label>
              <input id="ev-ref" value={event.externalRef} onChange={(e) => setEvent((s) => ({ ...s, externalRef: e.target.value }))} />
            </div>
            {event.type === 'REFUNDED' && (
              <label className="row small" style={{ marginBottom: '1rem' }}>
                <input
                  type="checkbox"
                  checked={event.endSubscription}
                  onChange={(e) => setEvent((s) => ({ ...s, endSubscription: e.target.checked }))}
                />
                Refund also ends the subscription (customer no longer counts as active)
              </label>
            )}
            <div className="field">
              <label htmlFor="ev-note">Note (optional)</label>
              <textarea id="ev-note" rows={2} value={event.note} onChange={(e) => setEvent((s) => ({ ...s, note: e.target.value }))} />
            </div>
            {event.type === 'PAYMENT_VERIFIED' && (
              <div className="alert info small">
                Only record this after the payment has been verified and the subscription activated in the SaaS. A monthly
                commission will be generated at the reseller&apos;s level rate.
              </div>
            )}
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setEventFor(null)} disabled={busy}>
                Cancel
              </button>
              <button className={`btn ${event.type === 'PAYMENT_VERIFIED' ? 'success' : 'danger'}`} onClick={submitEvent} disabled={busy}>
                Record
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
