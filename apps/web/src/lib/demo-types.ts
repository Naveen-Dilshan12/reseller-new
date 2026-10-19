export type DemoStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEMO_CREATED' | 'CONFIRMED'

export const DEMO_STATUS_LABELS: Record<DemoStatus, string> = {
  PENDING: 'Pending review',
  APPROVED: 'Approved — creating demo',
  REJECTED: 'Rejected',
  DEMO_CREATED: 'Demo ready',
  CONFIRMED: 'Confirmed',
}

export interface DemoPipelineCounts {
  total: number
  pending: number
  approved: number
  demoCreated: number
  confirmed: number
}

export const ACTION_LABELS: Record<string, string> = {
  SUBMITTED: 'Request submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DEMO_CREATED: 'Welcome message saved',
  CONFIRMED: 'Confirmed complete',
}

export interface DemoHistoryEntry {
  id: string
  fromStatus: DemoStatus | null
  toStatus: DemoStatus
  action: string
  note: string | null
  createdAt: string
  internal?: boolean
  actor?: { name: string; email: string } | null
}

export interface DemoListItem {
  id: string
  status: DemoStatus
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
  submittedAt: string
  decidedAt: string | null
  product: { id: string; code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
}

/** Reseller view: admin-only fields and internal notes are never sent to resellers. */
export interface ResellerDemoRequest {
  id: string
  status: DemoStatus
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
  notes: string | null
  submittedAt: string
  decidedAt: string | null
  rejectionReason: string | null
  demoCreatedAt: string | null
  confirmedAt: string | null
  product: { id: string; code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
  // Only present once an admin has saved it (status DEMO_CREATED or CONFIRMED).
  welcomeMessage: string | null
  /** Opening this only *opens* WhatsApp with the message pre-filled — it is never proof of delivery. */
  whatsappLink: string | null
  history: DemoHistoryEntry[]
}

type Person = { name: string; email: string } | null

export interface AdminDemoRequest {
  id: string
  resellerId: string
  productId: string
  status: DemoStatus
  businessName: string
  contactName: string
  contactEmail: string
  contactPhone: string
  notes: string | null
  requestedById: string
  submittedAt: string
  reviewedById: string | null
  decidedAt: string | null
  rejectionReason: string | null
  demoCreatedAt: string | null
  demoCreatedById: string | null
  welcomeMessage: string | null
  confirmedAt: string | null
  confirmedById: string | null
  createdAt: string
  updatedAt: string
  product: { id: string; code: string; name: string }
  reseller: { id: string; code: string; businessName: string }
  people: { requestedBy: Person; reviewedBy: Person; demoCreatedBy: Person; confirmedBy: Person }
  history: DemoHistoryEntry[]
  /** Only present on the response to a confirm: the customer + trial account that was created or linked. */
  linkedAccount?: { customerId: string; customerCode: string | null; displayName: string; accountId: string; accountCreated: boolean }
}

export const STEPS: DemoStatus[] = ['PENDING', 'APPROVED', 'DEMO_CREATED', 'CONFIRMED']
