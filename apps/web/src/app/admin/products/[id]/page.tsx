'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatDate, formatMoney } from '@/lib/format'
import {
  INTEGRATION_STATUS_LABELS,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_LABELS,
  PRODUCT_STATUS_DESCRIPTIONS,
  PRODUCT_STATUS_LABELS,
  trialLabel,
  type IntegrationProviderInfo,
  type LifecycleAction,
  type ProductDetail,
  type ResellerWithoutAccess,
} from '@/lib/product-types'
import { Modal } from '@/components/ui/Modal'
import { ProductLifecycleDialog } from '@/components/admin/ProductLifecycleDialog'

interface IntegrationLog {
  id: string
  operation: string
  entityId: string | null
  success: boolean
  httpStatus: number | null
  durationMs: number | null
  errorMessage: string | null
  createdAt: string
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.errors[0] ?? err.message) : fallback)

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>()
  const admin = useAdminUser()
  const canConfigure = admin.permissions.includes('integrations:manage')
  const canManageProducts = admin.permissions.includes('products:manage')
  // The review lists reseller names, so it also needs resellers:read (as the endpoint does).
  const canReviewAccess = canManageProducts && admin.permissions.includes('resellers:read')

  const [product, setProduct] = useState<ProductDetail | null>(null)
  // `null` means "not loaded yet", so an empty list is only ever shown for a request that really succeeded.
  const [providers, setProviders] = useState<IntegrationProviderInfo[] | null>(null)
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [logs, setLogs] = useState<IntegrationLog[] | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'info' | 'success' | 'error'; text: string } | null>(null)

  const [editing, setEditing] = useState(false)
  // `baseUpdatedAt` is the product version the form was opened on; it is sent with the save so that an edit based on
  // an older copy is refused (409) instead of overwriting what someone else saved. It must not move while editing.
  // Status is not part of the form: it changes only through Retire / Restore (the server refuses it in a general edit).
  const [details, setDetails] = useState({ name: '', description: '', monthlyPrice: '', trialAvailable: false, trialDays: '', baseUpdatedAt: '' })
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  const [configOpen, setConfigOpen] = useState(false)
  const [config, setConfig] = useState({ provider: 'MANUAL', enabled: true, baseUrl: '', apiKey: '', signingSecret: '', clearCredentials: false })
  const [configError, setConfigError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [lifecycle, setLifecycle] = useState<LifecycleAction | null>(null)
  const [missingAccess, setMissingAccess] = useState<{ total: number; limit: number; items: ResellerWithoutAccess[] } | null>(null)
  const [missingAccessError, setMissingAccessError] = useState<string | null>(null)
  const [missingAccessLoading, setMissingAccessLoading] = useState(false)

  /** Read-only: lists approved resellers without access so an admin can grant it explicitly, reseller by reseller. */
  const loadMissingAccess = useCallback(() => {
    setMissingAccessError(null)
    setMissingAccessLoading(true)
    api<{ total: number; limit: number; items: ResellerWithoutAccess[] }>(`/admin/saas-products/${id}/resellers-without-access`)
      .then(setMissingAccess)
      .catch((err) => setMissingAccessError(errorText(err, 'Failed to load partners without access')))
      .finally(() => setMissingAccessLoading(false))
  }, [id])

  const loadLogs = useCallback(() => {
    setLogsError(null)
    apiRequest<IntegrationLog[]>(`/admin/saas-products/${id}/integration/logs?limit=20`)
      .then((r) => setLogs(r.data))
      .catch((err) => setLogsError(errorText(err, 'Failed to load integration calls')))
  }, [id])

  const loadProviders = useCallback(() => {
    setProvidersError(null)
    api<IntegrationProviderInfo[]>('/admin/saas-products/providers')
      .then(setProviders)
      .catch((err) => setProvidersError(errorText(err, 'Failed to load the available integration implementations')))
  }, [])

  const load = useCallback(() => {
    setError(null)
    api<ProductDetail>(`/admin/saas-products/${id}`)
      .then(setProduct)
      .catch((err) => setError(errorText(err, 'Failed to load product')))
    loadLogs()
  }, [id, loadLogs])

  useEffect(() => {
    load()
    loadProviders()
  }, [load, loadProviders])

  // First load failed: nothing to show yet, so offer a way back and a retry.
  if (error && !product) {
    return (
      <main className="container">
        <Link href="/admin/products" className="small">
          ← All products
        </Link>
        <div className="alert error" style={{ marginTop: '0.75rem' }}>
          {error}
        </div>
        <button className="btn secondary" onClick={load}>
          Retry
        </button>
      </main>
    )
  }
  if (!product) return <main className="container muted">Loading…</main>

  const integration = product.integration
  const selectedProvider = providers?.find((p) => p.key === config.provider)

  const openEditor = (p: ProductDetail) => {
    setDetails({
      name: p.name,
      description: p.description ?? '',
      monthlyPrice: p.monthlyPrice,
      trialAvailable: p.trialAvailable,
      trialDays: p.trialDays ? String(p.trialDays) : '',
      baseUpdatedAt: p.updatedAt,
    })
    setDetailsError(null)
    setConflict(false)
    setEditing(true)
  }
  const startEdit = () => openEditor(product)

  /** After a conflict: fetch the product as it is now and start a fresh edit from it. Nothing is saved or merged. */
  const reloadLatest = async () => {
    setBusy(true)
    try {
      const fresh = await api<ProductDetail>(`/admin/saas-products/${id}`)
      setProduct(fresh)
      openEditor(fresh)
    } catch (err) {
      setDetailsError(errorText(err, 'Failed to reload the product'))
    } finally {
      setBusy(false)
    }
  }

  const saveDetails = async () => {
    setBusy(true)
    setDetailsError(null)
    try {
      const updated = await api<ProductDetail>(`/admin/saas-products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: details.name.trim(),
          description: details.description.trim() || null,
          monthlyPrice: Number(details.monthlyPrice),
          trialAvailable: details.trialAvailable,
          trialDays: details.trialAvailable && details.trialDays ? Number(details.trialDays) : null,
          expectedUpdatedAt: details.baseUpdatedAt,
        }),
      })
      setProduct(updated)
      setEditing(false)
      setMessage({ tone: 'info', text: 'Product updated.' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true)
      else setDetailsError(errorText(err, 'Failed to save'))
    } finally {
      setBusy(false)
    }
  }

  const openConfig = () => {
    setConfig({
      provider: integration?.provider ?? 'MANUAL',
      enabled: product.integrationStatus !== 'DISABLED',
      baseUrl: integration?.baseUrl ?? '',
      apiKey: '',
      signingSecret: '',
      clearCredentials: false,
    })
    setConfigError(null)
    setConfigOpen(true)
  }

  const saveConfig = async () => {
    setBusy(true)
    setConfigError(null)
    try {
      const body: Record<string, unknown> = { provider: config.provider, enabled: config.enabled }
      if (selectedProvider?.requiresCredentials) body.baseUrl = config.baseUrl.trim() || null
      if (config.clearCredentials) body.clearCredentials = true
      else {
        if (config.apiKey.trim()) body.apiKey = config.apiKey.trim()
        if (config.signingSecret.trim()) body.signingSecret = config.signingSecret.trim()
      }
      const updated = await api<ProductDetail>(`/admin/saas-products/${id}/integration`, { method: 'PUT', body: JSON.stringify(body) })
      setProduct(updated)
      setConfigOpen(false)
      setMessage({ tone: 'info', text: 'Integration settings saved. Run “Test connection” to verify.' })
    } catch (err) {
      setConfigError(errorText(err, 'Failed to save integration'))
    } finally {
      // Clear secrets from memory whatever the outcome.
      setConfig((c) => ({ ...c, apiKey: '', signingSecret: '' }))
      setBusy(false)
    }
  }

  const testConnection = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api<{ ok: boolean; message: string | null }>(`/admin/saas-products/${id}/integration/test`, { method: 'POST' })
      setMessage(
        result.ok
          ? { tone: 'success', text: `Connection OK${result.message ? ` – ${result.message}` : ''}.` }
          : { tone: 'error', text: `Connection failed: ${result.message ?? 'unknown error'}` },
      )
      load()
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err, 'Connection test failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="container">
      <Link href="/admin/products" className="small">
        ← All products
      </Link>
      <div className="row" style={{ margin: '0.75rem 0 1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>{product.name}</h1>
          <span className="muted small mono">{product.code}</span>
        </div>
        <span className={`badge ${product.status}`}>{PRODUCT_STATUS_LABELS[product.status]}</span>
        <span className="spacer" />
        {!editing && (
          <button className="btn secondary" onClick={startEdit}>
            Edit details
          </button>
        )}
        {!editing &&
          canManageProducts &&
          LIFECYCLE_ACTIONS[product.status].map((a) => (
            <button key={a} className="btn secondary" onClick={() => setLifecycle(a)}>
              {LIFECYCLE_LABELS[a]}
            </button>
          ))}
      </div>
      <p className="small muted" style={{ margin: '-0.5rem 0 1rem' }}>
        {PRODUCT_STATUS_DESCRIPTIONS[product.status]}
      </p>

      {error && (
        <div className="alert error">
          {error}{' '}
          <button className="btn secondary small" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {message && <div className={`alert ${message.tone}`}>{message.text}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Product details</h2>
        {!editing ? (
          <div className="grid-2">
            <div>
              <div className="muted small">Monthly price</div>
              {formatMoney(product.monthlyPrice, product.currency)}
            </div>
            <div>
              <div className="muted small">Trial</div>
              {trialLabel(product)}
            </div>
            <div className="span-2">
              <div className="muted small">Description</div>
              {product.description || '—'}
            </div>
            <div>
              <div className="muted small">Partners with access</div>
              {product._count.resellerAccess}
            </div>
            <div>
              <div className="muted small">Linked customer accounts</div>
              {product._count.accounts}
            </div>
          </div>
        ) : (
          <>
            {conflict && (
              <div className="alert error">
                <strong>This product was changed by someone else.</strong> Your changes were not saved. Reload the latest version to
                see what changed, then make your edit again.
                <div style={{ marginTop: '0.5rem' }}>
                  <button className="btn secondary small" onClick={reloadLatest} disabled={busy}>
                    Reload latest version
                  </button>
                </div>
              </div>
            )}
            {detailsError && <div className="alert error">{detailsError}</div>}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="pd-name">Name</label>
                <input id="pd-name" value={details.name} onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="field">
                <div className="muted small">Status</div>
                <span className={`badge ${product.status}`}>{PRODUCT_STATUS_LABELS[product.status]}</span>
                <span className="hint">
                  Status is not changed here. Save or cancel this edit, then use the status buttons at the top of the page:
                  “Retire product” and “Set coming soon” need a reason, and “Launch product” and “Restore product” put a product
                  on sale. Each shows what it affects before you confirm, and is recorded.
                </span>
              </div>
              <div className="field span-2">
                <label htmlFor="pd-desc">Description</label>
                <textarea id="pd-desc" rows={2} value={details.description} onChange={(e) => setDetails((d) => ({ ...d, description: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="pd-price">Monthly price ({product.currency})</label>
                <input id="pd-price" type="number" min="1" step="0.01" value={details.monthlyPrice} onChange={(e) => setDetails((d) => ({ ...d, monthlyPrice: e.target.value }))} />
                <span className="hint">Applies to commissions generated from now on.</span>
              </div>
              <div>
                <label className="row small" style={{ marginBottom: '0.5rem' }}>
                  <input type="checkbox" checked={details.trialAvailable} onChange={(e) => setDetails((d) => ({ ...d, trialAvailable: e.target.checked }))} />
                  Free trial available
                </label>
                {details.trialAvailable && (
                  <div className="field">
                    <label htmlFor="pd-trial">Trial days (optional)</label>
                    <input id="pd-trial" type="number" min="1" max="90" value={details.trialDays} onChange={(e) => setDetails((d) => ({ ...d, trialDays: e.target.value }))} />
                  </div>
                )}
              </div>
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={saveDetails} disabled={busy || conflict}>
                Save
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Partner access</h2>
        <p className="small muted">
          {product._count.resellerAccess} {product._count.resellerAccess === 1 ? 'partner has' : 'partners have'} active access.
          Access is never granted automatically: partners approved while this product was inactive, or before it was added,
          have no access until it is granted for each partner from their product access page.
        </p>
        {canReviewAccess && (
          <>
            {missingAccessError ? (
              <div className="alert error">
                {missingAccessError}{' '}
                <button className="btn secondary small" onClick={loadMissingAccess}>
                  Retry loading partners
                </button>
              </div>
            ) : missingAccessLoading ? (
              <p className="muted">Loading…</p>
            ) : !missingAccess ? (
              <button className="btn secondary" onClick={loadMissingAccess}>
                Review approved partners without access
              </button>
            ) : missingAccess.total === 0 ? (
              <p className="muted">Every approved partner has an access record for this product.</p>
            ) : (
              <>
                <p className="small">
                  {missingAccess.total} approved {missingAccess.total === 1 ? 'partner has' : 'partners have'} no access record for this
                  product. Nothing is granted from here: open a partner’s product access to grant it. Partners whose access was
                  suspended or revoked are not listed.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Partner</th>
                        <th>Approved</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {missingAccess.items.map((r) => (
                        <tr key={r.id}>
                          <td>
                            {r.businessName}
                            <div className="muted small mono">{r.code}</div>
                          </td>
                          <td className="small">{formatDate(r.approvedAt)}</td>
                          <td>
                            <Link href={`/admin/resellers/${r.id}/products`} className="small">
                              Open product access
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {missingAccess.total > missingAccess.items.length && (
                  <p className="small muted">
                    Showing the first {missingAccess.items.length} of {missingAccess.total}.
                  </p>
                )}
                <button className="btn secondary small" onClick={loadMissingAccess}>
                  Refresh list
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>Integration</h2>
          <span className={`badge ${product.integrationStatus}`}>{INTEGRATION_STATUS_LABELS[product.integrationStatus]}</span>
          <span className="spacer" />
          {canConfigure && (
            <>
              <button className="btn secondary" onClick={testConnection} disabled={busy || !integration}>
                Test connection
              </button>
              <button className="btn" onClick={openConfig} disabled={busy || !providers}>
                Configure
              </button>
            </>
          )}
        </div>
        {canConfigure && providersError && (
          <div className="alert error">
            {providersError}{' '}
            <button className="btn secondary small" onClick={loadProviders}>
              Retry loading implementations
            </button>
          </div>
        )}
        <p className="small muted">
          Connection settings are stored encrypted on the server and are never sent to partners. Secrets cannot be viewed
          again after saving – only replaced.
        </p>
        {!integration ? (
          <p className="muted">No integration configured.</p>
        ) : (
          <div className="grid-2">
            <div>
              <div className="muted small">Implementation</div>
              {integration.providerLabel} <span className="muted small mono">({integration.provider})</span>
            </div>
            <div>
              <div className="muted small">Base URL</div>
              <span className="mono small">{integration.requiresCredentials ? (integration.baseUrl ?? '—') : 'n/a'}</span>
            </div>
            {integration.requiresCredentials && (
              <div>
                <div className="muted small">Credentials</div>
                <span className="secret-state">API key: {integration.hasApiKey ? '•••••••• set' : 'missing'}</span>
                <br />
                <span className="secret-state">Signing secret: {integration.hasSigningSecret ? '•••••••• set' : 'missing'}</span>
              </div>
            )}
            <div>
              <div className="muted small">Last check</div>
              {integration.lastCheckedAt ? (
                <>
                  {new Date(integration.lastCheckedAt).toLocaleString()} – {integration.lastCheckOk ? 'OK' : 'failed'}
                  {integration.lastError && <div className="small negative">{integration.lastError}</div>}
                </>
              ) : (
                'Never'
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent integration calls</h2>
        {logsError ? (
          <div className="alert error">
            {logsError}{' '}
            <button className="btn secondary small" onClick={loadLogs}>
              Retry loading calls
            </button>
          </div>
        ) : logs === null ? (
          <p className="muted">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="muted">No calls yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Operation</th>
                  <th>Result</th>
                  <th>HTTP</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="small">{new Date(l.createdAt).toLocaleString()}</td>
                    <td className="mono small">{l.operation}</td>
                    <td>
                      <span className={`badge ${l.success ? 'CONNECTED' : 'ERROR'}`}>{l.success ? 'OK' : 'Failed'}</span>
                      {l.errorMessage && <div className="small negative">{l.errorMessage}</div>}
                    </td>
                    <td className="small">{l.httpStatus ?? '—'}</td>
                    <td className="small">{l.durationMs != null ? `${l.durationMs} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {configOpen && (
        <Modal label={'Configure integration'} onClose={() => setConfigOpen(false)} wide>
            <h2>Configure integration</h2>
            {configError && <div className="alert error">{configError}</div>}
            <div className="field">
              <label htmlFor="ic-provider">Implementation</label>
              <select id="ic-provider" value={config.provider} onChange={(e) => setConfig((c) => ({ ...c, provider: e.target.value }))}>
                {(providers ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              {selectedProvider && <span className="hint">{selectedProvider.description}</span>}
            </div>
            {selectedProvider?.requiresCredentials && (
              <>
                <div className="field">
                  <label htmlFor="ic-url">Partner API base URL</label>
                  <input id="ic-url" placeholder="https://api.example.com" value={config.baseUrl} onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))} />
                  <span className="hint">Requests go to &lt;base URL&gt;/partner/v1/…</span>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="ic-key">API key</label>
                    <input
                      id="ic-key"
                      type="password"
                      autoComplete="new-password"
                      placeholder={integration?.hasApiKey ? 'Leave blank to keep current' : 'Required'}
                      disabled={config.clearCredentials}
                      value={config.apiKey}
                      onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="ic-secret">Signing secret</label>
                    <input
                      id="ic-secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder={integration?.hasSigningSecret ? 'Leave blank to keep current' : 'Required (32+ chars)'}
                      disabled={config.clearCredentials}
                      value={config.signingSecret}
                      onChange={(e) => setConfig((c) => ({ ...c, signingSecret: e.target.value }))}
                    />
                  </div>
                </div>
              </>
            )}
            {(integration?.hasApiKey || integration?.hasSigningSecret) && (
              <label className="row small" style={{ marginBottom: '0.75rem' }}>
                <input type="checkbox" checked={config.clearCredentials} onChange={(e) => setConfig((c) => ({ ...c, clearCredentials: e.target.checked }))} />
                Delete stored API key and signing secret
              </label>
            )}
            <label className="row small" style={{ marginBottom: '0.75rem' }}>
              <input type="checkbox" checked={config.enabled} onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))} />
              Integration enabled
            </label>
            <div className="alert info small">
              Only partner API connection settings are accepted. Never enter database or internal service credentials.
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setConfigOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={saveConfig} disabled={busy}>
                Save
              </button>
            </div>
        </Modal>
      )}

      {lifecycle && (
        <ProductLifecycleDialog
          product={{ id: product.id, name: product.name, status: product.status, updatedAt: product.updatedAt }}
          action={lifecycle}
          onClose={() => setLifecycle(null)}
          onDone={(updated, text) => {
            setLifecycle(null)
            setProduct(updated)
            setMessage({ tone: 'info', text })
          }}
          onReload={() => {
            setLifecycle(null)
            load()
          }}
        />
      )}
    </main>
  )
}
