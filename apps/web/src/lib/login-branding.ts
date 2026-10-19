'use client'

import { useEffect, useState } from 'react'
import { api } from './api'
import type { LoginBranding } from './appearance-utils'

/**
 * Client side of the admin-managed login-page branding. Unlike the portal appearance this is read before anyone is
 * signed in, so it uses the public endpoint. Each auth page mounts its own layout, so the answer is kept for a minute
 * and shared: moving from sign-in to registration neither refetches nor flashes. If the request fails or is slow, the
 * page simply shows the built-in heading, text and image.
 */

const REFRESH_AFTER_MS = 60_000
const TIMEOUT_MS = 4_000

export type LoginBrandingState = { branding: LoginBranding | null; status: 'loading' | 'ready' | 'failed' }

let current: LoginBranding | null = null
let fetchedAt = 0
let inFlight: Promise<boolean> | null = null

function load(): Promise<boolean> {
  inFlight ??= api<LoginBranding>('/public/login-branding', { signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then((branding) => {
      current = branding
      fetchedAt = Date.now()
      return true
    })
    .catch(() => false)
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** `loading` only until the first answer: after that (or on failure) the layout can paint with what it has. */
export function useLoginBranding(): LoginBrandingState {
  const [state, setState] = useState<LoginBrandingState>(() => (current ? { branding: current, status: 'ready' } : { branding: null, status: 'loading' }))

  useEffect(() => {
    let active = true
    if (current && Date.now() - fetchedAt <= REFRESH_AFTER_MS) return
    load().then((ok) => {
      if (!active) return
      if (ok) setState({ branding: current, status: 'ready' })
      else setState((s) => (s.branding ? s : { branding: null, status: 'failed' }))
    })
    return () => {
      active = false
    }
  }, [])

  return state
}
