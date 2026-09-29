'use client'

import { createContext, useContext } from 'react'
import type { CurrentUser } from './auth'

export const AdminUserContext = createContext<CurrentUser | null>(null)

export function useAdminUser(): CurrentUser {
  const user = useContext(AdminUserContext)
  if (!user) throw new Error('useAdminUser must be used inside the admin layout')
  return user
}
