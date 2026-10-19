'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { LIFECYCLE_LABELS, type LifecycleAction, type ProductDetail, type ProductImpact, type ProductStatus } from '@/lib/product-types'
import { Modal } from '@/components/ui/Modal'

interface Props {
  product: { id: string; name: string; status: ProductStatus; updatedAt: string }
  action: LifecycleAction
  onClose: () => void
  /** Called with the saved product and a one-line summary for the page. */
  onDone: (updated: ProductDetail, message: string) => void
  /** The product changed since the page loaded it (409): close and show the latest version. */
  onReload: () => void
}

const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function impactRow(label: string, value: number, note: string) {
  return (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td className="num">{value}</td>
      <td className="small muted">{note}</td>
    </tr>
  )
}

/** Wording for taking a product off sale: Retire (to Inactive) and Set coming soon (from Active). */
interface OffSaleWords {
  lead: string
  state: string
  undo: string
}
const RETIRE_WORDS: OffSaleWords = { lead: 'Retiring blocks new sales.', state: 'inactive', undo: 'restored' }
const COMING_SOON_WORDS: OffSaleWords = { lead: 'Setting coming soon blocks new sales.', state: 'coming soon', undo: 'launched' }

function offSaleImpact({ customerAccounts: a, openActivationRequests, openDemoRequests: d, unpaidCommissions: c, resellers: r }: ProductImpact, w: OffSaleWords) {
  const amounts = c.totals.map((t) => formatMoney(t.amount, t.currency)).join(', ')
  return (
    <>
      <div className="table-wrap">
        <table>
          <tbody>
            {impactRow('Paid customer accounts', a.active, 'Stay active; their subscriptions and commissions continue.')}
            {impactRow(
              'Trial accounts',
              a.trial,
              `Cannot be converted to paid while the product is ${w.state}.${a.pending > 0 ? ` ${counted(a.pending, 'more trial')} being set up.` : ''}`,
            )}
            {impactRow('Open activation requests', openActivationRequests, 'Can still be reviewed and completed.')}
            {impactRow('Open demo requests', d.total, d.awaitingConfirmation > 0 ? `${d.awaitingConfirmation} waiting for confirmation.` : 'Can still be reviewed.')}
            {impactRow('Unpaid commissions', c.count, `${amounts ? `${amounts}. ` : ''}Unchanged; approve and pay them as usual.`)}
            {impactRow('Partners with access', r.withAccess, 'Kept as they are; nothing is revoked.')}
          </tbody>
        </table>
      </div>
      <div className="alert warning">
        <strong>{w.lead}</strong> Partners can no longer request trials or demos or submit paid activations for
        this product, and existing trial accounts cannot be converted to paid until it is {w.undo}.
        {d.awaitingConfirmation > 0 && (
          <p style={{ margin: '0.5rem 0 0' }}>
            {counted(d.awaitingConfirmation, 'demo request')} {d.awaitingConfirmation === 1 ? 'is' : 'are'} waiting for
            confirmation. Confirmation is blocked while the product is {w.state}.
          </p>
        )}
      </div>
      <p className="small muted">Nothing is deleted. Partner access and the integration settings are not changed.</p>
    </>
  )
}

/** Setting an inactive product to coming soon: it is already off sale, so there is no impact to review. */
function alreadyOffSale() {
  return (
    <>
      <div className="alert info">This product is already off sale, so nothing changes for partners, trials or customers.</div>
      <p className="small muted">Nothing is deleted. Partner access and the integration settings are not changed.</p>
    </>
  )
}

/** Wording for putting a product on sale: Restore (from Inactive) and Launch (from Coming soon). */
interface OnSaleWords {
  gerund: string
  after: string
  was: string
  again: string
}
const RESTORE_WORDS: OnSaleWords = { gerund: 'Restoring', after: 'restoring', was: 'inactive', again: ' again' }
const LAUNCH_WORDS: OnSaleWords = { gerund: 'Launching', after: 'launching', was: 'coming soon', again: '' }

function onSaleImpact({ customerAccounts: a, resellers: r }: ProductImpact, w: OnSaleWords) {
  return (
    <>
      <div className="table-wrap">
        <table>
          <tbody>
            {impactRow('Partners with active access', r.withAccess, `Can sell it${w.again} straight away.`)}
            {impactRow('Trial accounts', a.trial, `Can be converted to paid${w.again}.`)}
          </tbody>
        </table>
      </div>
      {r.approvedWithoutAccess > 0 ? (
        <div className="alert warning">
          {counted(r.approvedWithoutAccess, 'approved partner')} {r.approvedWithoutAccess === 1 ? 'has' : 'have'} no access record for this
          product, for example partners approved while it was {w.was}. {w.gerund} does not give them access. After {w.after},
          review them under “Partner access” on this page and grant access partner by partner.
        </div>
      ) : (
        <p className="small muted">Every approved partner has an access record for this product.</p>
      )}
    </>
  )
}

/**
 * Confirms a lifecycle change of a SaaS product: retire or set coming soon (take it off sale, reason required), restore or
 * launch (put it on sale, note optional). What it affects is loaded first, and the action can only be confirmed once that
 * is shown (setting an inactive product to coming soon affects nothing, so nothing is loaded for it). The page's copy of
 * the product (its `updatedAt`) goes with the request, so a product changed in the meantime is refused (409) instead of
 * being acted on unseen.
 */
export function ProductLifecycleDialog({ product, action, onClose, onDone, onReload }: Props) {
  const reasonRequired = action === 'retire' || action === 'coming-soon'
  const wasOnSale = product.status === 'ACTIVE'
  const needsImpact = !(action === 'coming-soon' && !wasOnSale)
  const confirmLabel = LIFECYCLE_LABELS[action]
  const title = {
    retire: `Retire ${product.name}`,
    restore: `Restore ${product.name}`,
    'coming-soon': `Set ${product.name} to coming soon`,
    launch: `Launch ${product.name}`,
  }[action]
  const intro = {
    retire: 'Retiring takes the product off sale by setting it to Inactive. It can be restored later.',
    restore: 'Restoring sets the product back to Active.',
    'coming-soon': wasOnSale
      ? 'Setting a product to coming soon takes it off sale until it is launched. Launching sets it to Active.'
      : 'Setting a product to coming soon marks it as not launched yet. It stays off sale until it is launched.',
    launch: 'Launching sets a coming-soon product to Active, putting it on sale.',
  }[action]
  // Taking a product off sale is the risky direction; putting it on sale is the confirming one.
  const buttonTone = action === 'retire' || (action === 'coming-soon' && wasOnSale) ? 'danger' : action === 'coming-soon' ? '' : 'success'

  const [impact, setImpact] = useState<ProductImpact | null>(null)
  const [impactError, setImpactError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  const loadImpact = useCallback(() => {
    if (!needsImpact) return
    setImpactError(null)
    api<ProductImpact>(`/admin/saas-products/${product.id}/impact`)
      .then(setImpact)
      .catch((err) => setImpactError(err instanceof ApiError ? err.message : 'Request failed'))
  }, [product.id, needsImpact])

  useEffect(loadImpact, [loadImpact])

  const summary = (i: ProductImpact | null) => {
    if (action === 'retire') return `${product.name} retired. New sales and trial-to-paid conversions are blocked; paid subscriptions and commissions continue.`
    if (action === 'coming-soon') {
      return wasOnSale
        ? `${product.name} set to coming soon. New sales and trial-to-paid conversions are blocked; paid subscriptions and commissions continue.`
        : `${product.name} set to coming soon. It was already off sale, so nothing changed for partners or customers.`
    }
    const missing = i?.resellers.approvedWithoutAccess ?? 0
    return (
      `${product.name} ${action === 'launch' ? 'launched' : 'restored'}. Partners with active access can sell it${action === 'launch' ? '' : ' again'}.` +
      (missing > 0
        ? ` ${counted(missing, 'approved partner')} without an access record ${missing === 1 ? 'was' : 'were'} not given access; review them under “Partner access”.`
        : '')
    )
  }

  const submit = async () => {
    if (needsImpact && !impact) return
    const value = text.trim()
    if (reasonRequired && value.length < 10) return setError('Give a reason of at least 10 characters.')
    setBusy(true)
    setError(null)
    try {
      const body = reasonRequired ? { reason: value, expectedUpdatedAt: product.updatedAt } : { ...(value ? { note: value } : {}), expectedUpdatedAt: product.updatedAt }
      const updated = await api<ProductDetail>(`/admin/saas-products/${product.id}/${action}`, { method: 'POST', body: JSON.stringify(body) })
      onDone(updated, summary(impact))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(err.message)
      else setError(err instanceof ApiError ? (err.errors[0] ?? err.message) : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  // Only rendered once there is something to show: the impact has loaded, or the product is already off sale.
  const review = !needsImpact
    ? alreadyOffSale()
    : impact &&
      (action === 'retire'
        ? offSaleImpact(impact, RETIRE_WORDS)
        : action === 'coming-soon'
          ? offSaleImpact(impact, COMING_SOON_WORDS)
          : onSaleImpact(impact, action === 'launch' ? LAUNCH_WORDS : RESTORE_WORDS))

  return (
    <Modal label={title} onClose={busy ? () => undefined : onClose} wide>
      <h2>{title}</h2>
      <p className="small muted">{intro}</p>

      {impactError ? (
        <div className="alert error">
          Could not load what this affects: {impactError}{' '}
          <button className="btn secondary small" onClick={loadImpact}>
            Retry
          </button>
        </div>
      ) : needsImpact && !impact ? (
        <p className="muted">Checking what this affects…</p>
      ) : (
        review
      )}

      <div className="field">
        <label htmlFor={reasonRequired ? 'pl-reason' : 'pl-note'}>{reasonRequired ? 'Reason (recorded in the audit log)' : 'Note (optional, recorded in the audit log)'}</label>
        <textarea id={reasonRequired ? 'pl-reason' : 'pl-note'} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        {reasonRequired && <span className="hint">At least 10 characters.</span>}
      </div>

      {conflict && (
        <div className="alert error">
          {conflict}
          <div style={{ marginTop: '0.5rem' }}>
            <button className="btn secondary small" onClick={onReload}>
              Reload product
            </button>
          </div>
        </div>
      )}
      {error && <div className="alert error">{error}</div>}

      <div className="row">
        <span className="spacer" />
        <button className="btn secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className={`btn ${buttonTone}`.trim()} onClick={submit} disabled={busy || (needsImpact && !impact) || Boolean(conflict)}>
          {busy ? 'Saving…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
