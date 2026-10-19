'use client'

import { createContext, useContext } from 'react'
import type { CommissionSummary } from '@/lib/commission-types'

/**
 * The signed-in seller's own commission summary, fetched once by the Seller shell and shared with
 * the pages inside it (null until loaded, for ineligible users, or if the request failed).
 */
const PartnerSummaryContext = createContext<CommissionSummary | null>(null)

export const PartnerSummaryProvider = PartnerSummaryContext.Provider

export function usePartnerSummaryContext() {
  return useContext(PartnerSummaryContext)
}
