import { bankDetailLines } from '@/lib/bank-details'

/**
 * "Pay only into …" for the New Activation form. Shows the company account exactly as Hexalyte entered it, or says it is not
 * available when the setting holds no real detail: nothing at all, or only empty "Label:" lines (an unfilled template), which
 * would otherwise read like an account with the numbers missing.
 */
export function PaymentAccountNotice({ companyBankDetails }: { companyBankDetails: string | null | undefined }) {
  const lines = bankDetailLines(companyBankDetails)

  if (lines.length === 0) {
    return (
      <div style={{ marginTop: '0.5rem' }}>
        <strong>The Hexalyte company bank account is not available yet.</strong> Contact Hexalyte before collecting a payment,
        and do not pay into any other account.
      </div>
    )
  }

  return (
    <div className="pre-line" style={{ marginTop: '0.5rem' }}>
      <strong>Pay only into the Hexalyte company account:</strong>
      <br />
      {lines.join('\n')}
    </div>
  )
}
