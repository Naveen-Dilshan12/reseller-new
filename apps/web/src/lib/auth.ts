'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, tokens } from './api'

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'FINANCE' | 'RESELLER_ADMIN' | 'RESELLER_AGENT'

export interface CurrentUser {
  id: string
  email: string
  name: string
  role: UserRole
  resellerId: string | null
  permissions: string[]
  reseller: { id: string; code: string; businessName: string; status: string } | null
}

export const PLATFORM_ROLES: UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCE']

export const isPlatformUser = (user: Pick<CurrentUser, 'role'>) => PLATFORM_ROLES.includes(user.role)

export async function login(email: string, password: string) {
  const data = await api<{ accessToken: string; refreshToken: string; user: Pick<CurrentUser, 'role'> }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  tokens.set(data.accessToken, data.refreshToken)
  return data.user
}

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: tokens.refresh }) })
  } finally {
    tokens.clear()
  }
}

/** Loads the current user; redirects to /login when unauthenticated or not allowed. */
export function useCurrentUser(allow?: (user: CurrentUser) => boolean) {
  const router = useRouter()
  const [user, setUser] = useState<CurrentUser | null>(null)

  useEffect(() => {
    if (!tokens.access) {
      router.replace('/login')
      return
    }
    api<CurrentUser>('/auth/me')
      .then((me) => {
        if (allow && !allow(me)) {
          router.replace(isPlatformUser(me) ? '/admin' : '/dashboard')
          return
        }
        setUser(me)
      })
      .catch(() => {
        tokens.clear()
        router.replace('/login')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return user
}
