'use client'

import { useState } from 'react'
import { ResellerShell } from '@/components/ResellerShell'
import { Tabs } from '@/components/Tabs'
import { CommissionLedger } from '@/components/commissions/CommissionLedger'
import { CustomerCommissions } from '@/components/commissions/CustomerCommissions'
import { MonthlyReport } from '@/components/commissions/MonthlyReport'
import { PayoutHistory } from '@/components/commissions/PayoutHistory'

type Tab = 'history' | 'customers' | 'monthly' | 'payouts'

export default function ResellerCommissionsPage() {
  const [tab, setTab] = useState<Tab>('history')

  return (
    <ResellerShell>
      {() => (
        <main className="container">
          <h1>Commissions</h1>
          <p className="muted">
            Commission is earned each month for every active customer, once their subscription payment is verified. It
            is approved by Hexalyte, held for the refund period, then paid out.
          </p>
          <div className="card">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'history', label: 'Commission history' },
                { key: 'customers', label: 'By customer' },
                { key: 'monthly', label: 'Monthly report' },
                { key: 'payouts', label: 'Payouts' },
              ]}
            />
            {tab === 'history' && <CommissionLedger />}
            {tab === 'customers' && <CustomerCommissions />}
            {tab === 'monthly' && <MonthlyReport />}
            {tab === 'payouts' && <PayoutHistory />}
          </div>
        </main>
      )}
    </ResellerShell>
  )
}
