'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { useAdminUser } from '@/lib/admin-context'
import { AppearanceSettings } from '@/components/admin/AppearanceSettings'
import { SmsGatewaySettings } from '@/components/admin/SmsGatewaySettings'

interface Level {
  level: number
  name: string
  minActiveCustomers: number
  maxActiveCustomers: number | null
  ratePercent: string | number
}

interface Settings {
  commissionLevels: Level[]
  companyBankDetails: {
    value: string | null
    source: 'database' | 'environment' | 'not-set'
    updatedAt: string | null
    updatedBy: { name: string; email: string } | null
  }
  system: { commissionHoldDays: number; maxUploadMb: number; businessTimezone: string; environment: string }
  integrations: { id: string; code: string; name: string; status: string; integrationStatus: string; provider: string | null; lastCheckedAt: string | null }[]
}

type EditLevel = { level: number; name: string; min: string; max: string; rate: string }

const toEdit = (levels: Level[]): EditLevel[] =>
  levels.map((l) => ({
    level: l.level,
    name: l.name,
    min: String(l.minActiveCustomers),
    max: l.maxActiveCustomers === null ? '' : String(l.maxActiveCustomers),
    rate: String(Number(l.ratePercent)),
  }))

export default function SettingsPage() {
  const admin = useAdminUser()
  const canManage = admin.permissions.includes('settings:manage')
  const [data, setData] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [editingBank, setEditingBank] = useState(false)
  const [bankValue, setBankValue] = useState('')
  const [bankReason, setBankReason] = useState('')
  const [bankError, setBankError] = useState<string | null>(null)

  const [editingLevels, setEditingLevels] = useState(false)
  const [levels, setLevels] = useState<EditLevel[]>([])
  const [levelReason, setLevelReason] = useState('')
  const [levelErrors, setLevelErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Settings>('/admin/settings')
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load settings'))
  }, [])

  const saveBank = async () => {
    setBankError(null)
    if (bankValue.trim().length < 10) return setBankError('Enter the full bank details.')
    if (bankReason.trim().length < 5) return setBankError('Give a reason for the change.')
    if (!confirm('Partners will immediately tell customers to pay into this account. Save the new bank details?')) return
    setBusy(true)
    try {
      setData(await api<Settings>('/admin/settings/company-bank-details', { method: 'PUT', body: JSON.stringify({ value: bankValue.trim(), reason: bankReason.trim() }) }))
      setEditingBank(false)
      setMessage('Company bank details updated. All admins have been notified.')
    } catch (err) {
      setBankError(err instanceof ApiError ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const updateLevel = (i: number, patch: Partial<EditLevel>) => setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLevel = () =>
    setLevels((ls) => {
      const last = ls[ls.length - 1]
      const nextMin = last ? Number(last.max || last.min) + 1 : 1
      const updated = last && !last.max ? [...ls.slice(0, -1), { ...last, max: String(nextMin - 1) }] : ls
      return [...updated, { level: ls.length + 1, name: `Level ${ls.length + 1}`, min: String(nextMin), max: '', rate: last?.rate ?? '10' }]
    })
  const removeLast = () => setLevels((ls) => (ls.length > 1 ? ls.slice(0, -1).map((l, i, arr) => (i === arr.length - 1 ? { ...l, max: '' } : l)) : ls))

  const saveLevels = async () => {
    setLevelErrors([])
    if (levelReason.trim().length < 5) return setLevelErrors(['Give a reason for the change.'])
    if (!confirm('Partner levels will be recalculated now. New commissions use the new rates; existing commissions are not changed. Continue?')) return
    setBusy(true)
    try {
      const body = {
        reason: levelReason.trim(),
        levels: levels.map((l) => ({
          level: l.level,
          name: l.name.trim(),
          minActiveCustomers: Number(l.min),
          maxActiveCustomers: l.max === '' ? null : Number(l.max),
          ratePercent: Number(l.rate),
        })),
      }
      const res = await api<Settings & { levelChanges: number }>('/admin/settings/commission-levels', { method: 'PUT', body: JSON.stringify(body) })
      setData(res)
      setEditingLevels(false)
      setMessage(`Commission levels updated. ${res.levelChanges} partner level(s) changed.`)
    } catch (err) {
      setLevelErrors(err instanceof ApiError ? (err.errors.length ? err.errors : [err.message]) : ['Save failed'])
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <main className="container">
        <div className="alert error">{error}</div>
      </main>
    )
  }
  if (!data) {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  const bank = data.companyBankDetails
  return (
    <main className="container">
      <h1>Settings</h1>
      {!canManage && <p className="muted">Read-only. Only an Admin can change settings.</p>}
      {message && <div className="alert success">{message}</div>}

      <section className="card">
        <div className="panel-head">
          <h2>Company bank account</h2>
          <span className="spacer" />
          {canManage && !editingBank && (
            <button
              className="btn secondary small"
              onClick={() => {
                setBankValue(bank.value ?? '')
                setBankReason('')
                setBankError(null)
                setEditingBank(true)
              }}
            >
              Edit
            </button>
          )}
        </div>
        <p className="small muted">
          Shown to partners on the activation request form and on their Our Bank Details page. Customers pay subscription fees into this
          account. Write one <strong>Label: value</strong> line each for Bank Name, Account Holder, Account Number and Branch so partners
          get a separate copy button for every detail; any other lines are shown as they are.
        </p>
        {editingBank ? (
          <>
            <div className="field">
              <label htmlFor="bank-value">Bank details</label>
              <textarea id="bank-value" rows={4} maxLength={1000} value={bankValue} onChange={(e) => setBankValue(e.target.value)} placeholder={'Bank Name: Bank of Ceylon\nAccount Holder: Hexalyte (Pvt) Ltd\nAccount Number: 0000000000\nBranch: Colombo Fort'} />
            </div>
            <div className="field">
              <label htmlFor="bank-reason">Reason for change (audited)</label>
              <input id="bank-reason" maxLength={300} value={bankReason} onChange={(e) => setBankReason(e.target.value)} />
            </div>
            {bankError && <div className="alert error small">{bankError}</div>}
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setEditingBank(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={saveBank} disabled={busy}>
                {busy ? 'Saving…' : 'Save bank details'}
              </button>
            </div>
          </>
        ) : bank.value ? (
          <>
            <div className="pre-line bank-box">{bank.value}</div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {bank.source === 'environment'
                ? 'From the server configuration (COMPANY_BANK_DETAILS).'
                : `Last changed ${bank.updatedAt ? new Date(bank.updatedAt).toLocaleString() : ''}${bank.updatedBy ? ` by ${bank.updatedBy.name}` : ''}.`}
            </p>
          </>
        ) : (
          <div className="alert warning">Not set. Partners are told to pay into the official Hexalyte account without details.</div>
        )}
      </section>

      <section className="card">
        <div className="panel-head">
          <h2>Commission levels</h2>
          <span className="spacer" />
          {canManage && !editingLevels && (
            <button
              className="btn secondary small"
              onClick={() => {
                setLevels(toEdit(data.commissionLevels))
                setLevelReason('')
                setLevelErrors([])
                setEditingLevels(true)
              }}
            >
              Edit
            </button>
          )}
        </div>
        <p className="small muted">
          A partner&apos;s level depends on their number of active subscriptions. Changing tiers recalculates every partner&apos;s
          level; commissions already created keep their original rate.
        </p>
        <p className="small muted">
          <strong>Commission %</strong> is the share of a product&apos;s monthly subscription price that the partner earns; the rest stays
          with Hexalyte. Partners see their level, badge, progress and commission split from these values. Level 1–5 each have their own
          badge style (Bronze, Silver, Gold, Platinum, Diamond); any level above 5 reuses the Diamond badge. Only an Admin can change
          these settings.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>Name</th>
                <th>From (active)</th>
                <th>To (active)</th>
                <th>Commission %</th>
              </tr>
            </thead>
            <tbody>
              {editingLevels
                ? levels.map((l, i) => (
                    <tr key={l.level}>
                      <td>{l.level}</td>
                      <td>
                        <input className="cell-input" value={l.name} maxLength={40} onChange={(e) => updateLevel(i, { name: e.target.value })} aria-label={`Level ${l.level} name`} />
                      </td>
                      <td>
                        <input className="cell-input num" type="number" min={0} value={l.min} onChange={(e) => updateLevel(i, { min: e.target.value })} aria-label={`Level ${l.level} minimum`} />
                      </td>
                      <td>
                        {i === levels.length - 1 ? (
                          <span className="muted small">and above</span>
                        ) : (
                          <input className="cell-input num" type="number" min={0} value={l.max} onChange={(e) => updateLevel(i, { max: e.target.value })} aria-label={`Level ${l.level} maximum`} />
                        )}
                      </td>
                      <td>
                        <input className="cell-input num" type="number" min={0} max={100} step="0.01" value={l.rate} onChange={(e) => updateLevel(i, { rate: e.target.value })} aria-label={`Level ${l.level} rate`} />
                      </td>
                    </tr>
                  ))
                : data.commissionLevels.map((l) => (
                    <tr key={l.level}>
                      <td>{l.level}</td>
                      <td>{l.name}</td>
                      <td>{l.minActiveCustomers}</td>
                      <td>{l.maxActiveCustomers ?? 'and above'}</td>
                      <td>{Number(l.ratePercent)}%</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {editingLevels && (
          <>
            <div className="row" style={{ margin: '0.75rem 0' }}>
              <button className="btn link small" onClick={addLevel} disabled={levels.length >= 20}>
                + Add level
              </button>
              <button className="btn link small negative" onClick={removeLast} disabled={levels.length <= 1}>
                Remove last level
              </button>
            </div>
            <div className="field">
              <label htmlFor="lvl-reason">Reason for change (audited)</label>
              <input id="lvl-reason" maxLength={300} value={levelReason} onChange={(e) => setLevelReason(e.target.value)} />
            </div>
            {levelErrors.length > 0 && (
              <div className="alert error small">
                {levelErrors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
            <div className="row">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setEditingLevels(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={saveLevels} disabled={busy}>
                {busy ? 'Saving…' : 'Save levels'}
              </button>
            </div>
          </>
        )}
      </section>

      <AppearanceSettings canManage={canManage} />

      <SmsGatewaySettings canManage={canManage} />

      <div className="grid-2 gap">
        <section className="card">
          <h2>System</h2>
          <dl className="details">
            <dt>Commission hold period</dt>
            <dd>{data.system.commissionHoldDays} days</dd>
            <dt>Bank slip upload limit</dt>
            <dd>{data.system.maxUploadMb} MB (JPG, PNG, WEBP, PDF)</dd>
            <dt>Bank slip storage</dt>
            <dd>Encrypted private storage, access audited</dd>
            <dt>Business timezone</dt>
            <dd>{data.system.businessTimezone}</dd>
            <dt>Environment</dt>
            <dd>{data.system.environment}</dd>
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            These values come from the server configuration and are changed by redeploying.
          </p>
        </section>
        <section className="card">
          <h2>SaaS integrations</h2>
          <table>
            <tbody>
              {data.integrations.map((p) => (
                <tr key={p.id}>
                  <td>
                    {admin.permissions.includes('products:manage') ? <Link href={`/admin/products/${p.id}`}>{p.name}</Link> : p.name}
                    <div className="muted small">{p.provider ?? 'No provider'}</div>
                  </td>
                  <td>
                    <span className={`badge ${p.integrationStatus}`}>{p.integrationStatus}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginBottom: 0 }}>
            API credentials are configured per product and are never shown after saving.
          </p>
        </section>
      </div>
    </main>
  )
}
