'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, apiRequest, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { formatMoney } from '@/lib/format'
import {
  INTEGRATION_STATUS_LABELS,
  PRODUCT_STATUS_LABELS,
  trialLabel,
  type IntegrationProviderInfo,
  type ProductDetail,
} from '@/lib/product-types'

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

  const [product, setProduct] = useState<ProductDetail | null>(null)
  const [providers, setProviders] = useState<IntegrationProviderInfo[]>([])
  const [logs, setLogs] = useState<IntegrationLog[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [details, setDetails] = useState({ name: '', description: '', monthlyPrice: '', status: 'ACTIVE', trialAvailable: false, trialDays: '' })
  const [detailsError, setDetailsError] = useState<string | null>(null)

  const [configOpen, setConfigOpen] = useState(false)
  const [config, setConfig] = useState({ provider: 'MANUAL', enabled: true, baseUrl: '', apiKey: '', signingSecret: '', clearCredentials: false })
  const [configError, setConfigError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadLogs = useCallback(() => {
    apiRequest<IntegrationLog[]>(`/admin/saas-products/${id}/integration/logs?limit=20`)
      .then((r) => setLogs(r.data))
      .catch(() => setLogs([]))
  }, [id])

  const load = useCallback(() => {
    api<ProductDetail>(`/admin/saas-products/${id}`)
      .then(setProduct)
      .catch((err) => setError(errorText(err, 'Failed to load product')))
    loadLogs()
  }, [id, loadLogs])

  useEffect(() => {
    load()
    api<IntegrationProviderInfo[]>('/admin/saas-products/providers').then(setProviders).catch(() => setProviders([]))
  }, [load])

  if (error) return <main className="container"><div className="alert error">{error}</div></main>
  if (!product) return <main className="container muted">Loading…</main>

  const integration = product.integration
  const selectedProvider = providers.find((p) => p.key === config.provider)

  const startEdit = () => {
    setDetails({
      name: product.name,
      description: product.description ?? '',
      monthlyPrice: product.monthlyPrice,
      status: product.status,
      trialAvailable: product.trialAvailable,
      trialDays: product.trialDays ? String(product.trialDays) : '',
    })
    setDetailsError(null)
    setEditing(true)
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
          status: details.status,
          trialAvailable: details.trialAvailable,
          trialDays: details.trialAvailable && details.trialDays ? Number(details.trialDays) : null,
        }),
      })
      setProduct(updated)
      setEditing(false)
      setMessage('Product updated.')
    } catch (err) {
      setDetailsError(errorText(err, 'Failed to save'))
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
      setMessage('Integration settings saved. Run “Test connection” to verify.')
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
      setMessage(result.ok ? `Connection OK${result.message ? ` – ${result.message}` : ''}.` : `Connection failed: ${result.message ?? 'unknown error'}`)
      load()
    } catch (err) {
      setMessage(errorText(err, 'Connection test failed'))
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
      </div>

      {message && <div className="alert info">{message}</div>}

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
              <div className="muted small">Resellers with access</div>
              {product._count.resellerAccess}
            </div>
            <div>
              <div className="muted small">Linked customer accounts</div>
              {product._count.accounts}
            </div>
          </div>
        ) : (
          <>
            {detailsError && <div className="alert error">{detailsError}</div>}
            <div className="grid-2">
              <div className="field">
                <label htmlFor="pd-name">Name</label>
                <input id="pd-name" value={details.name} onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="pd-status">Status</label>
                <select id="pd-status" value={details.status} onChange={(e) => setDetails((d) => ({ ...d, status: e.target.value }))}>
                  {Object.entries(PRODUCT_STATUS_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <span className="hint">Only Active products can be sold. Existing customer accounts are not affected.</span>
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
              <button className="btn" onClick={saveDetails} disabled={busy}>
                Save
              </button>
            </div>
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
              <button className="btn" onClick={openConfig} disabled={busy}>
                Configure
              </button>
            </>
          )}
        </div>
        <p className="small muted">
          Connection settings are stored encrypted on the server and are never sent to resellers. Secrets cannot be viewed
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
        {logs.length === 0 ? (
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
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <h2>Configure integration</h2>
            {configError && <div className="alert error">{configError}</div>}
            <div className="field">
              <label htmlFor="ic-provider">Implementation</label>
              <select id="ic-provider" value={config.provider} onChange={(e) => setConfig((c) => ({ ...c, provider: e.target.value }))}>
                {providers.map((p) => (
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
          </div>
        </div>
      )}
    </main>
  )
}
