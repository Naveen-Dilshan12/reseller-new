'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api, apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { billingWindow, BUSINESS_TIMEZONE, businessPeriod, formatDate, formatMoney, monthLabel } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pagination, type PaginationMeta } from '@/components/ui/Pagination'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'

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

/**
 * The events worth offering for an account in this state. The server decides what is allowed; this only keeps
 * the dialog from offering what it will refuse: an unpaid trial has nothing to cancel or refund, and a cancelled
 * account is not reactivated by a manual payment event (it goes through a paid activation request).
 */
function eventTypesFor(status: string): EventType[] {
  if (status === 'TRIAL' || status === 'PENDING') return ['PAYMENT_VERIFIED']
  if (status === 'CANCELLED') return ['REFUNDED']
  return ['PAYMENT_VERIFIED', 'CANCELLED', 'REFUNDED']
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
  const [page, setPage] = useState(1)
  const [meta, setMeta] = useState<PaginationMeta | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [resellers, setResellers] = useState<Option[]>([])
  const [products, setProducts] = useState<Option[]>([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState(emptyLink)
  const [customers, setCustomers] = useState<Option[]>([])
  const [customersError, setCustomersError] = useState<string | null>(null)
  const [live, setLive] = useState<Record<string, LiveStatus | 'loading' | { error: string }>>({})

  useEffect(() => {
    setCustomers([])
    setCustomersError(null)
    if (!link.resellerId) return undefined
    let stale = false
    api<{ id: string; displayName: string }[]>(`/customers?resellerId=${link.resellerId}&limit=100`)
      .then((r) => {
        if (!stale) setCustomers(r.map((c) => ({ id: c.id, label: c.displayName })))
      })
      .catch((err) => {
        if (!stale) setCustomersError(err instanceof ApiError ? err.message : 'Failed to load customers')
      })
    return () => {
      stale = true
    }
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
  const [event, setEvent] = useState({ type: 'PAYMENT_VERIFIED' as EventType, periodMonth: businessPeriod(), externalRef: '', note: '', endSubscription: true })
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Months the server accepts for an event (last month … two months ahead, business time); recomputed on every render. */
  const billing = billingWindow()

  const openEvent = (account: Account) => {
    setDialogError(null)
    setEvent({ type: eventTypesFor(account.status)[0], periodMonth: businessPeriod(), externalRef: '', note: '', endSubscription: true })
    setEventFor(account)
  }

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '25', page: String(page) })
    if (status) params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    setLoading(true)
    setError(null)
    apiRequest<Account[]>(`/customer-accounts?${params}`)
      .then((r) => {
        const next = (r.meta as unknown as PaginationMeta) ?? null
        // The page asked for no longer exists (its rows moved or were filtered away): go to the last real page
        // instead of showing "no accounts" with no way back. `loading` stays on until that page arrives.
        if (next && r.data.length === 0 && next.total > 0 && page > next.totalPages) {
          setPage(next.totalPages)
          return
        }
        setItems(r.data)
        setMeta(next)
        setLoading(false)
      })
      .catch((err) => {
        setItems([])
        setMeta(null)
        setError(err instanceof ApiError ? err.message : 'Failed to load customers')
        setLoading(false)
      })
  }, [status, search, page])

  useEffect(load, [status, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadOptions = async () => {
    setOptionsLoading(true)
    setOptionsError(null)
    try {
      const [r, p] = await Promise.all([
        api<{ id: string; businessName: string; code: string }[]>('/admin/reseller-applications?status=ACTIVE&limit=100'),
        api<{ id: string; name: string; status: string }[]>('/products'),
      ])
      setResellers(r.map((x) => ({ id: x.id, label: `${x.businessName} (${x.code})` })))
      setProducts(p.filter((x) => x.status === 'ACTIVE').map((x) => ({ id: x.id, label: x.name })))
    } catch (err) {
      setOptionsError(err instanceof ApiError ? err.message : 'Failed to load partners and products')
    } finally {
      setOptionsLoading(false)
    }
  }

  const openLink = () => {
    setDialogError(null)
    setLinkOpen(true)
    if (resellers.length === 0) void loadOptions()
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
        subscriptionEnded: boolean
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
      if (result.subscriptionEnded) parts.push('The subscription has ended.')
      else if (event.type === 'REFUNDED') {
        parts.push(
          event.endSubscription
            ? 'The subscription was not ended: only refunding the current month ends it. Record a Cancelled event to end it.'
            : 'The subscription was kept.',
        )
      }
      parts.push(
        `Partner now has ${result.level.activeCustomerCount} active customers${result.level.level ? ` (Level ${result.level.level})` : ''}${result.level.changed ? ' – level changed' : ''}.`,
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
      <AdminPageHeader
        title="Customer accounts"
        subtitle="Each row maps a partner's customer to a tenant in a Hexalyte SaaS. Only identifiers are stored here; the customer's business data stays in the SaaS. Record subscription outcomes only after the payment has been verified and the account activated in the SaaS."
        actions={
          canLink ? (
            <button className="btn" onClick={openLink}>
              Link SaaS account
            </button>
          ) : undefined
        }
      />

      {message && <div className="alert success">{message}</div>}
      {error && (
        <div className="alert error">
          {error}{' '}
          <button className="btn secondary small" onClick={load} disabled={loading}>
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
        <div className="field inline">
          <label htmlFor="acc-status">Status</label>
          <select
            id="acc-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
          >
            {['', 'PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div className="field inline search-field">
          <label htmlFor="acc-search">Search</label>
          <div className="filter-search-wrap">
            <input id="acc-search" placeholder="Customer name, tenant ID or account ID" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="filter-actions">
          <button className="btn secondary small" type="submit">
            Search
          </button>
        </div>
      </form>

        {items.length === 0 ? (
          loading ? (
            <p className="muted">Loading…</p>
          ) : error ? null : (
            <>
              <EmptyState title="No customer accounts found" hint="Linked partner customers and their SaaS tenants will appear here." />
              {meta && meta.totalPages > 1 && (
                <div className="table-wrap">
                  <Pagination meta={meta} onPage={setPage} noun="accounts" />
                </div>
              )}
            </>
          )
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Product / external IDs</th>
                  <th>Partner</th>
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
                        <button className="btn link small" onClick={() => openEvent(a)}>
                          Record subscription event
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination meta={meta} onPage={setPage} noun="accounts" busy={loading} />
          </div>
        )}

      {linkOpen && (
        <Modal label={'Link SaaS account to partner'} onClose={() => setLinkOpen(false)} wide>
            <h2>Link SaaS account to partner</h2>
            {dialogError && <div className="alert error">{dialogError}</div>}
            {optionsError && (
              <div className="alert error">
                {optionsError}{' '}
                <button className="btn secondary small" onClick={loadOptions} disabled={optionsLoading}>
                  Retry
                </button>
              </div>
            )}
            {optionsLoading && <p className="muted small">Loading partners and products…</p>}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="link-reseller">Partner</label>
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
                {customersError && (
                  <span className="hint negative">
                    Could not load this partner&apos;s customers ({customersError}). You can still enter a new customer name.
                  </span>
                )}
              </div>
              {link.customerId ? (
                <div />
              ) : (
                linkField('customerName', 'New customer name', 'Reseller-side reference only. A customer with the same name is reused.')
              )}
              {linkField('externalTenantId', 'External tenant ID', 'Tenant ID inside the SaaS')}
              {linkField('externalAccountId', 'External account ID (optional)', 'Owner / admin user ID inside the SaaS')}
              <div className="field">
                <label htmlFor="link-status">Current status</label>
                <input id="link-status" value="Trial" readOnly disabled />
                <span className="hint">An existing tenant is always linked as a trial. Paid accounts become ACTIVE via a “Payment verified” event.</span>
              </div>
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setLinkOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={submitLink} disabled={busy || optionsLoading}>
                Link account
              </button>
            </div>
        </Modal>
      )}

      {eventFor && (
        <Modal label={'Record subscription event'} onClose={() => setEventFor(null)}>
            <h2>Record subscription event</h2>
            <p className="small muted">
              {eventFor.customer.displayName} · {eventFor.product.name} · {eventFor.reseller.businessName}
            </p>
            {dialogError && <div className="alert error">{dialogError}</div>}
            <div className="field">
              <label htmlFor="ev-type">Event</label>
              <select id="ev-type" value={event.type} onChange={(e) => setEvent((s) => ({ ...s, type: e.target.value as EventType }))}>
                {eventTypesFor(eventFor.status).map((t) => (
                  <option key={t} value={t}>
                    {EVENT_LABELS[t]}
                  </option>
                ))}
              </select>
              {(eventFor.status === 'TRIAL' || eventFor.status === 'PENDING') && (
                <span className="hint">Cancelled and Refunded events apply only to paid subscriptions, so they are not offered for an unpaid trial.</span>
              )}
              {eventFor.status === 'CANCELLED' && (
                <span className="hint">
                  This account is cancelled. A manual payment event cannot reactivate it; a cancelled subscription is reactivated through a paid
                  activation request.
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="ev-month">Billing month</label>
              <input
                id="ev-month"
                type="month"
                value={event.periodMonth}
                min={billing.from}
                max={billing.to}
                onChange={(e) => setEvent((s) => ({ ...s, periodMonth: e.target.value }))}
              />
              <span className="hint">{event.periodMonth && monthLabel(event.periodMonth)}</span>
              <span className="hint">
                Allowed billing months: {monthLabel(billing.from)} to {monthLabel(billing.to)} ({BUSINESS_TIMEZONE} time)
              </span>
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
                Refund also ends the subscription, only when refunding the current month (customer no longer counts as active). A refund of any
                other month only reverses that month&apos;s commission.
              </label>
            )}
            <div className="field">
              <label htmlFor="ev-note">Note (optional)</label>
              <textarea id="ev-note" rows={2} value={event.note} onChange={(e) => setEvent((s) => ({ ...s, note: e.target.value }))} />
            </div>
            {event.type === 'PAYMENT_VERIFIED' && (
              <div className="alert info small">
                Only record this after the payment has been verified and the subscription activated in the SaaS. The account needs a linked tenant
                and no open activation request. A monthly commission will be generated at the partner&apos;s level rate.
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
        </Modal>
      )}
    </main>
  )
}
