'use client'

import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import type { PaymentInfo } from '@/lib/activation-types'
import { hasBankDetails, hasBankField, parseBankDetails, type BankField } from '@/lib/bank-details'
import { ResellerShell } from '@/components/ResellerShell'
import { PageHero } from '@/components/PageHero'

const FIELD_ROWS: { key: BankField; label: string; mono?: boolean }[] = [
  { key: 'bankName', label: 'Bank name' },
  { key: 'accountHolder', label: 'Account holder' },
  { key: 'accountNumber', label: 'Account number', mono: true },
  { key: 'branch', label: 'Branch' },
]

interface DetailRowProps {
  id: string
  label: string
  value: string | null
  mono?: boolean
  copied: boolean
  onCopy: (id: string, text: string) => void
}

function DetailRow({ id, label, value, mono, copied, onCopy }: DetailRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '0.5rem 1rem',
        padding: '0.8rem 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 14rem' }}>
        <div className="muted small">{label}</div>
        {value ? (
          <div className={mono ? 'mono' : undefined} style={{ fontWeight: 700, fontSize: '1.02rem', color: 'var(--text-heading)', overflowWrap: 'anywhere' }}>
            {value}
          </div>
        ) : (
          <div className="muted">Not provided</div>
        )}
      </div>
      {value && (
        <button type="button" className="btn secondary small" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => onCopy(id, value)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  )
}

/**
 * The company bank account resellers' customers pay into, read from the same `payment-info` endpoint the activation form uses
 * (which in turn reads Admin → Settings). Nothing is stored or edited here, and nothing is shown that the admin has not entered.
 */
export default function BankDetailsPage() {
  const [info, setInfo] = useState<PaymentInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    let active = true
    api<PaymentInfo>('/activation-requests/payment-info')
      .then((res) => active && setInfo(res))
      .catch((err) => active && setError(err instanceof ApiError ? err.message : 'Could not load the bank details.'))
    return () => {
      active = false
    }
  }, [attempt])

  // "Copied" confirmation goes back to "Copy" by itself.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFailed(false)
      setCopied(id)
    } catch {
      // No clipboard access (e.g. a page not served over HTTPS, or permission denied).
      setCopied(null)
      setCopyFailed(true)
    }
  }

  // A setting that only holds empty "Label:" lines (an unfilled template) counts as not configured.
  const available = hasBankDetails(info?.companyBankDetails)
  const parsed = parseBankDetails(info?.companyBankDetails)
  const structured = hasBankField(parsed)
  const otherText = parsed.other.join('\n')

  return (
    <ResellerShell>
      {() => (
        <main className="container">
          <PageHero
            tag="PAYMENTS"
            title="Our Bank Details"
            subtitle="The official Hexalyte company account your customers pay their subscription fees into."
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 9 9-6 9 6" />
                <path d="M5 9v10M9.5 9v10M14.5 9v10M19 9v10" />
                <path d="M3 21h18" />
              </svg>
            }
          />

          {error ? (
            <div className="alert error" role="alert">
              <div>{error}</div>
              <button
                type="button"
                className="btn secondary small"
                style={{ marginTop: '0.6rem' }}
                onClick={() => {
                  setError(null)
                  setAttempt((n) => n + 1)
                }}
              >
                Retry
              </button>
            </div>
          ) : !info ? (
            <p className="muted">Loading…</p>
          ) : !available ? (
            <div className="card" style={{ maxWidth: '720px' }}>
              <h2 style={{ marginTop: 0 }}>Bank details are not available yet</h2>
              <p className="muted" style={{ marginBottom: 0 }}>
                Hexalyte has not published the company bank account yet. Please contact Hexalyte and wait for the account details before
                collecting a payment. Do not pay into any other account.
              </p>
            </div>
          ) : (
            <div className="card" style={{ maxWidth: '720px' }}>
              <div className="alert info" style={{ marginBottom: '0.5rem' }}>
                Customers must pay only into this official Hexalyte company account.
              </div>

              {copyFailed && (
                <div className="alert warning small" role="status">
                  Could not copy automatically. Select the text and copy it manually.
                </div>
              )}

              {structured &&
                FIELD_ROWS.map((row) => (
                  <DetailRow
                    key={row.key}
                    id={row.key}
                    label={row.label}
                    mono={row.mono}
                    value={parsed.fields[row.key]}
                    copied={copied === row.key}
                    onCopy={copy}
                  />
                ))}

              {otherText && (
                <div style={{ marginTop: structured ? '1.1rem' : '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem 1rem' }}>
                    <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{structured ? 'Additional details' : 'Account details'}</h3>
                    <button type="button" className="btn secondary small" aria-label="Copy all details" onClick={() => copy('other', otherText)}>
                      {copied === 'other' ? 'Copied' : 'Copy all'}
                    </button>
                  </div>
                  <div style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-heading)', fontWeight: 600 }}>{otherText}</div>
                  {!structured && <p className="muted small" style={{ marginBottom: 0 }}>Shown exactly as Hexalyte entered them.</p>}
                </div>
              )}
            </div>
          )}
        </main>
      )}
    </ResellerShell>
  )
}
