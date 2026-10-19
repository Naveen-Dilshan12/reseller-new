'use client'

import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'

interface SmsGatewayConfig {
  provider: 'SMSLENZ'
  status: 'NOT_CONFIGURED' | 'DISABLED' | 'READY'
  enabled: boolean
  /** Maximum OTP SMS per rolling 24 hours, all users together. */
  dailyLimit: number
  /** OTP SMS sent in the last 24 hours (test SMS are not counted). */
  usage24h: number
  userId: string
  senderId: string
  apiKeyConfigured: boolean
  /** Masked by the server: the real key never reaches the browser. */
  apiKeyMasked: string | null
  updatedAt: string | null
  lastTest: { at: string; ok: boolean; code: string | null } | null
}

const STATUS_LABEL: Record<SmsGatewayConfig['status'], string> = {
  NOT_CONFIGURED: 'Not configured',
  DISABLED: 'Configured, disabled',
  READY: 'Enabled',
}

const problemOf = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.status === 422 && err.errors.length ? err.errors.map((e) => e.replace(/^[\w.]+: /, '')).join(' ') : err.message) : fallback

/** Admin > Settings > SMS Gateway: SMSlenz credentials used for partner-registration verification codes. */
export function SmsGatewaySettings({ canManage }: { canManage: boolean }) {
  const [config, setConfig] = useState<SmsGatewayConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [userId, setUserId] = useState('')
  const [senderId, setSenderId] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [dailyLimit, setDailyLimit] = useState('500')
  const [updateApiKey, setUpdateApiKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string } | null>(null)

  const [testPhone, setTestPhone] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const apply = (c: SmsGatewayConfig) => {
    setConfig(c)
    setUserId(c.userId)
    setSenderId(c.senderId)
    setEnabled(c.enabled)
    setDailyLimit(String(c.dailyLimit))
    setUpdateApiKey(false)
    setApiKey('')
  }

  useEffect(() => {
    api<SmsGatewayConfig>('/admin/settings/sms-gateway')
      .then(apply)
      .catch((err) => setLoadError(problemOf(err, 'Could not load the SMS gateway settings.')))
  }, [])

  const needsKey = !config?.apiKeyConfigured || updateApiKey

  const save = async () => {
    setSaveResult(null)
    if (!userId.trim()) return setSaveResult({ ok: false, text: 'User ID is required.' })
    if (!senderId.trim()) return setSaveResult({ ok: false, text: 'Sender ID is required.' })
    const limit = Number(dailyLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) return setSaveResult({ ok: false, text: 'Daily limit must be a whole number between 1 and 100000.' })
    if (needsKey && apiKey.trim().length < 8) return setSaveResult({ ok: false, text: 'Enter the API key.' })
    setSaving(true)
    try {
      const saved = await api<SmsGatewayConfig>('/admin/settings/sms-gateway', {
        method: 'PUT',
        body: JSON.stringify({
          provider: 'SMSLENZ',
          userId: userId.trim(),
          senderId: senderId.trim(),
          enabled,
          dailyLimit: limit,
          updateApiKey: needsKey,
          ...(needsKey ? { apiKey: apiKey.trim() } : {}),
        }),
      })
      apply(saved)
      setSaveResult({ ok: true, text: 'SMS gateway settings saved.' })
    } catch (err) {
      setSaveResult({ ok: false, text: problemOf(err, 'Could not save the SMS gateway settings.') })
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTestResult(null)
    if (!testPhone.trim()) return setTestResult({ ok: false, text: 'Enter the mobile number to send the test SMS to.' })
    setTesting(true)
    try {
      const updated = await api<SmsGatewayConfig>('/admin/settings/sms-gateway/test', { method: 'POST', body: JSON.stringify({ phone: testPhone.trim() }) })
      setConfig(updated)
      setTestResult({ ok: true, text: 'The provider accepted the test SMS. Check the handset to confirm delivery.' })
    } catch (err) {
      setTestResult({ ok: false, text: problemOf(err, 'The test SMS could not be sent.') })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="card" aria-labelledby="sms-gateway-heading">
      <h2 id="sms-gateway-heading">SMS Gateway</h2>
      <p className="small muted">
        SMSlenz sends the 6-digit verification code during partner registration. Credentials are stored encrypted on the server and are never shown again after saving.
      </p>

      {loadError && <div className="alert error small">{loadError}</div>}
      {!config && !loadError && <p className="muted small">Loading…</p>}

      {config && (
        <>
          <dl className="details">
            <dt>Provider</dt>
            <dd>SMSlenz</dd>
            <dt>Status</dt>
            <dd>
              <span className={`badge ${config.status === 'READY' ? 'ACTIVE' : 'PENDING'}`}>{STATUS_LABEL[config.status]}</span>
            </dd>
            <dt>Verification SMS (last 24 h)</dt>
            <dd>
              {config.usage24h} of {config.dailyLimit}
              {config.usage24h >= config.dailyLimit && <strong> — limit reached, registration SMS are paused</strong>}
            </dd>
            <dt>Last test</dt>
            <dd>
              {config.lastTest
                ? `${config.lastTest.ok ? 'Accepted' : `Failed (${config.lastTest.code ?? 'error'})`} · ${new Date(config.lastTest.at).toLocaleString()}`
                : 'No test sent yet'}
            </dd>
          </dl>

          {canManage ? (
            <>
              <div className="field">
                <label htmlFor="sms-user-id">User ID</label>
                <input id="sms-user-id" value={userId} maxLength={40} autoComplete="off" onChange={(e) => setUserId(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="sms-api-key">API key</label>
                {needsKey ? (
                  <input
                    id="sms-api-key"
                    type="password"
                    value={apiKey}
                    maxLength={200}
                    autoComplete="new-password"
                    placeholder="Paste the API key from your SMSlenz settings"
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                ) : (
                  <div className="row">
                    <input id="sms-api-key" value={config.apiKeyMasked ?? ''} readOnly aria-readonly="true" />
                    <button type="button" className="btn secondary small" onClick={() => setUpdateApiKey(true)}>
                      Update API key
                    </button>
                  </div>
                )}
                {updateApiKey && config.apiKeyConfigured && (
                  <button
                    type="button"
                    className="btn link small"
                    onClick={() => {
                      setUpdateApiKey(false)
                      setApiKey('')
                    }}
                  >
                    Keep the current key
                  </button>
                )}
              </div>
              <div className="field">
                <label htmlFor="sms-sender-id">Sender ID</label>
                <input id="sms-sender-id" value={senderId} maxLength={20} autoComplete="off" onChange={(e) => setSenderId(e.target.value)} />
                <span className="muted small">Case sensitive. Must be a Sender ID approved on your SMSlenz account.</span>
              </div>
              <div className="field">
                <label htmlFor="sms-daily-limit">Daily verification SMS limit</label>
                <input id="sms-daily-limit" type="number" min={1} max={100000} step={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
                <span className="muted small">All users together, over a rolling 24 hours. Test SMS are not counted. Default 500.</span>
              </div>
              <label className="row" style={{ marginBottom: '0.75rem' }}>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span>Enable SMS gateway (registration needs this on)</span>
              </label>
              {saveResult && (
                <div className={`alert ${saveResult.ok ? 'success' : 'error'} small`} role="status">
                  {saveResult.text}
                </div>
              )}
              <div className="row">
                <span className="spacer" />
                <button className="btn" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : 'Save SMS settings'}
                </button>
              </div>

              <hr />
              <h3>Send test SMS</h3>
              <p className="small muted">Sends one real message using the saved settings and uses SMS credit. Nothing is sent until you press the button.</p>
              <div className="field">
                <label htmlFor="sms-test-phone">Destination mobile number</label>
                <input id="sms-test-phone" type="tel" inputMode="tel" placeholder="0771234567" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
              </div>
              {testResult && (
                <div className={`alert ${testResult.ok ? 'success' : 'error'} small`} role="status">
                  {testResult.text}
                </div>
              )}
              <div className="row">
                <span className="spacer" />
                <button className="btn secondary" onClick={sendTest} disabled={testing || config.status === 'NOT_CONFIGURED'}>
                  {testing ? 'Sending…' : 'Send test SMS'}
                </button>
              </div>
              {config.status === 'NOT_CONFIGURED' && <p className="small muted">Save the User ID, API key and Sender ID before sending a test.</p>}
            </>
          ) : (
            <p className="small muted">You can view the gateway status but not change it.</p>
          )}
        </>
      )}
    </section>
  )
}
