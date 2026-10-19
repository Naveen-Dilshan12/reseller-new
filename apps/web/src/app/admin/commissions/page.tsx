'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAdminUser } from '@/lib/admin-context'
import { AdminPageHeader } from '@/components/admin/AdminPageHeader'
import { Tabs } from '@/components/Tabs'
import { CommissionLedger } from '@/components/commissions/CommissionLedger'
import { PayoutHistory } from '@/components/commissions/PayoutHistory'

type Tab = 'ledger' | 'payouts'

export default function AdminCommissionsPage() {
  const admin = useAdminUser()
  const [tab, setTab] = useState<Tab>('ledger')
  return (
    <main className="container">
      <AdminPageHeader
        title="Commissions & Payouts"
        subtitle="Commissions are generated only from verified subscription payments. Approve pending entries; approved entries become payable after the refund hold period. Payouts are recorded from each partner's commissions page."
        actions={
          <Link href="/admin/commissions/report" className="btn secondary">
            Monthly report
          </Link>
        }
      />
      <div className="card">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'ledger', label: 'Commissions' },
            { key: 'payouts', label: 'Payouts' },
          ]}
        />
        {tab === 'ledger' && (
          <CommissionLedger
            manage={admin.permissions.includes('commissions:manage')}
            showReseller
            filterByReseller={admin.permissions.includes('resellers:read')}
            initialStatus="PENDING"
          />
        )}
        {tab === 'payouts' && <PayoutHistory showReseller />}
      </div>
    </main>
  )
}
