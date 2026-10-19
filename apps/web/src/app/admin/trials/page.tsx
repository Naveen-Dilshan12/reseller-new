import { redirect } from 'next/navigation'

/**
 * The Admin "Trial requests" list is replaced by Demo Requests (review → welcome message →
 * confirmation). Kept as a redirect so existing links (dashboard cards, bookmarks) still land
 * somewhere useful. The backend /trials API and the shared trial-account logic are untouched.
 */
export default function AdminTrialsRedirectPage() {
  redirect('/admin/demo-requests')
}
