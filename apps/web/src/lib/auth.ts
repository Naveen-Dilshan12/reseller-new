'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError, api, tokens } from './api'

export type UserRole = 'ADMIN' | 'SELLER'

export interface CurrentUser {
  id: string
  email: string
  name: string
  role: UserRole
  emailVerified: boolean
  resellerId: string | null
  /** The user's own WhatsApp number (+<country code><number>), or null when none is linked. */
  whatsappNumber: string | null
  /** True once the first-login welcome popup has been shown to this user (stored on the server). */
  welcomeSeen: boolean
  permissions: string[]
  reseller: {
    id: string
    code: string
    businessName: string
    status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED'
    rejectionReason?: string | null
    createdAt?: string
  } | null
}

export const PLATFORM_ROLES: UserRole[] = ['ADMIN']

export const isPlatformUser = (user: Pick<CurrentUser, 'role'>) => PLATFORM_ROLES.includes(user.role)

/**
 * `remember` decides where the session is kept: checked → survives closing the browser,
 * unchecked → only for this tab/window. The password is only ever sent to the API, never stored.
 */
export async function login(email: string, password: string, remember = false) {
  const data = await api<{ accessToken: string; refreshToken: string; user: Pick<CurrentUser, 'role'> }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  tokens.set(data.accessToken, data.refreshToken, remember)
  return data.user
}

export async function verifyEmail(email: string, otp: string): Promise<string> {
  const res = await api<{ message?: string } | null>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ email, otp }),
  })
  return res?.message ?? 'Email address successfully verified. You can now log in.'
}

export async function resendVerification(email: string): Promise<string> {
  const res = await api<{ message?: string } | null>('/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  return res?.message ?? 'If an unverified account exists with that email, a verification link has been sent.'
}

export async function fetchDevOtp(email: string): Promise<{ debugMode: boolean; otp: string | null }> {
  try {
    if (process.env.NODE_ENV === 'production') {
      return { debugMode: false, otp: null }
    }
    const data = await api<{ debugMode: boolean; otp: string | null }>(`/auth/dev-otp?email=${encodeURIComponent(email)}`, {
      method: 'GET',
    })
    return { debugMode: !!data?.debugMode, otp: data?.otp || null }
  } catch {
    return { debugMode: false, otp: null }
  }
}

export async function requestPasswordReset(email: string): Promise<string> {
  const res = await api<{ message?: string } | null>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  return res?.message ?? 'If an account exists with that email address, password reset instructions have been sent.'
}

export async function completePasswordReset(token: string, newPassword: string): Promise<string> {
  const res = await api<{ message?: string } | null>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  })
  return res?.message ?? 'Your password has been successfully reset. You can now log in.'
}

let cachedUser: CurrentUser | null = null

export function getCachedUser(): CurrentUser | null {
  return cachedUser
}

export function setCachedUser(user: CurrentUser | null) {
  cachedUser = user
}

const USER_UPDATED_EVENT = 'hxr:user-updated'

/**
 * Reloads the signed-in user from the server (e.g. to pick up an approved reseller application)
 * and tells every mounted `useCurrentUser` to re-render with it. Returns null if the request fails.
 */
export async function refreshCurrentUser(): Promise<CurrentUser | null> {
  try {
    const me = await api<CurrentUser>('/auth/me')
    cachedUser = me
    window.dispatchEvent(new Event(USER_UPDATED_EVENT))
    return me
  } catch {
    return null
  }
}

export async function logout() {
  cachedUser = null
  try {
    await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: tokens.refresh }) })
  } catch {
    // A failing revoke must never trap the user in an authenticated shell.
  } finally {
    tokens.clear()
  }
}

/** Loads the current user; redirects to /login when unauthenticated or not allowed. */
export function useCurrentUser(allow?: (user: CurrentUser) => boolean) {
  const router = useRouter()
  // Initialize with cached user if present to prevent blank screen flicker during navigation
  const [user, setUser] = useState<CurrentUser | null>(() => {
    if (cachedUser && (!allow || allow(cachedUser))) {
      return cachedUser
    }
    return null
  })
  const [error, setError] = useState<Error | null>(null)

  if (error) throw error

  // Re-render when refreshCurrentUser() loaded a newer copy of the user
  useEffect(() => {
    const onUpdated = () => {
      if (cachedUser && (!allow || allow(cachedUser))) setUser(cachedUser)
    }
    window.addEventListener(USER_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(USER_UPDATED_EVENT, onUpdated)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!tokens.access) {
      cachedUser = null
      router.replace('/login')
      return
    }

    let cancelled = false
    api<CurrentUser>('/auth/me')
      .then((me) => {
        if (cancelled) return
        cachedUser = me
        if (allow && !allow(me)) {
          router.replace(isPlatformUser(me) ? '/admin' : '/dashboard')
          return
        }
        setUser(me)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Only an authentication failure logs the user out; transient errors keep the session.
        const isAuthFailure = err instanceof ApiError && (err.status === 401 || err.status === 403)
        if (!isAuthFailure) {
          if (!cachedUser) {
            setError(err instanceof Error ? err : new Error('Could not reach the server'))
          }
          return
        }
        cachedUser = null
        tokens.clear()
        router.replace('/login')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return user
}
