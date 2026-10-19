import { redirect } from 'next/navigation'

/**
 * Free trials are no longer part of the Seller panel (demo request → welcome message →
 * confirmation replaces them). The Seller `/trials` pages are kept in the repo but are no
 * longer reachable: every request under /trials is sent back to the dashboard.
 *
 * The backend /trials API and the admin console (/admin/trials) are unaffected. To restore
 * the Seller pages, delete this file.
 */
export default function RetiredSellerTrialsLayout() {
  redirect('/dashboard')
}
