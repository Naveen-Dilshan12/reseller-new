/**
 * Display name of a user's role for header chips, e.g. 'ADMIN' → 'Admin', 'SELLER' → 'Seller'.
 * Derived from the role the server returned (`/auth/me`), so a chip can never claim more than the account has.
 * Dependency-free so it can be tested without a DOM.
 */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return ''
  return role
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}
