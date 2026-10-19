'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function OnboardingResellerRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/dashboard/become-reseller')
  }, [router])

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0B1220',
        color: '#94A3B8',
        fontSize: '0.9rem',
        gap: '0.75rem',
      }}
    >
      <div className="login-spinner" />
      <span>Loading Partner Onboarding...</span>
    </div>
  )
}
