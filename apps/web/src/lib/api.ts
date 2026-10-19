const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100/api/v1'

const ACCESS_KEY = 'hxr_access_token'
const REFRESH_KEY = 'hxr_refresh_token'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public errors: string[] = [],
  ) {
    super(message)
  }

  /** Maps server validation errors like `personal.email: Invalid` to `{ 'personal.email': 'Invalid' }`. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {}
    for (const e of this.errors) {
      const idx = e.indexOf(': ')
      if (idx > 0) map[e.slice(0, idx)] ??= e.slice(idx + 2)
    }
    return map
  }
}

/**
 * Where the session lives is the user's "Remember me" choice at login:
 * - checked   → localStorage (survives closing the browser; same as before this option existed)
 * - unchecked → sessionStorage (gone when the tab/window is closed)
 *
 * Only the short-lived access token and the rotating refresh token are ever stored — never a
 * password. The backend is unchanged: its refresh token keeps its normal server-side lifetime,
 * but an unchecked session simply never persists it in the browser past the tab.
 * Reads check sessionStorage first, then localStorage, so sessions created before this option
 * existed (localStorage) keep working.
 */
function store(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null // storage blocked (private mode / policy): behave as logged-out rather than throwing
  }
}

function read(key: string): string | null {
  for (const kind of ['session', 'local'] as const) {
    try {
      const value = store(kind)?.getItem(key)
      if (value) return value
    } catch {
      /* ignore */
    }
  }
  return null
}

export const tokens = {
  get access() {
    return read(ACCESS_KEY)
  },
  get refresh() {
    return read(REFRESH_KEY)
  },
  /** True when the current session was started without "Remember me" (tab-lifetime only). */
  get isSessionOnly() {
    try {
      return Boolean(store('session')?.getItem(REFRESH_KEY))
    } catch {
      return false
    }
  },
  /**
   * `remember` is passed at login. Token rotation (refresh) omits it so the session stays in
   * whichever store it started in.
   */
  set(access: string, refresh: string, remember?: boolean) {
    const sessionOnly = remember === undefined ? this.isSessionOnly : !remember
    const target = store(sessionOnly ? 'session' : 'local')
    const other = store(sessionOnly ? 'local' : 'session')
    if (!target) return
    target.setItem(ACCESS_KEY, access)
    target.setItem(REFRESH_KEY, refresh)
    other?.removeItem(ACCESS_KEY)
    other?.removeItem(REFRESH_KEY)
  },
  clear() {
    for (const kind of ['session', 'local'] as const) {
      const s = store(kind)
      s?.removeItem(ACCESS_KEY)
      s?.removeItem(REFRESH_KEY)
    }
  },
}

interface Envelope<T> {
  success: boolean
  data: T
  message?: string
  code?: string
  errors?: string[]
  meta?: { total: number; page: number; limit: number; totalPages: number; [k: string]: unknown }
}

/** Endpoints that must never trigger the refresh-and-retry loop. */
const NO_REFRESH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout']

const canRefresh = (path: string) => !NO_REFRESH_PATHS.some((p) => path === p || path.startsWith(`${p}?`))

let refreshing: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  const refreshToken = tokens.refresh
  if (!refreshToken) return false
  refreshing ??= fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
    .then(async (res) => {
      if (!res.ok) {
        tokens.clear()
        return false
      }
      const body = (await res.json()) as Envelope<{ accessToken: string; refreshToken: string }>
      if (!body?.data?.accessToken) {
        tokens.clear()
        return false
      }
      tokens.set(body.data.accessToken, body.data.refreshToken)
      return true
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

export async function apiRequest<T>(path: string, init: RequestInit = {}, retry = true): Promise<Envelope<T>> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const access = tokens.access
  if (access) headers.set('Authorization', `Bearer ${access}`)

  const res = await fetch(`${API_URL}${path}`, { ...init, headers, cache: 'no-store' })

  if (res.status === 401 && retry && tokens.refresh && canRefresh(path)) {
    if (await tryRefresh()) return apiRequest<T>(path, init, false)
    tokens.clear()
  }

  const body = (await res.json().catch(() => null)) as Envelope<T> | null
  if (!res.ok || !body?.success) {
    throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status, body?.code, body?.errors ?? [])
  }
  return body
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiRequest<T>(path, init)).data
}

/** Authenticated download of a private file (e.g. a bank slip); never exposed as a public URL. */
export async function apiBlob(path: string, retry = true): Promise<Blob> {
  const headers = new Headers()
  const access = tokens.access
  if (access) headers.set('Authorization', `Bearer ${access}`)
  const res = await fetch(`${API_URL}${path}`, { headers, cache: 'no-store' })
  if (res.status === 401 && retry && tokens.refresh) {
    if (await tryRefresh()) return apiBlob(path, false)
    tokens.clear()
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Envelope<unknown> | null
    throw new ApiError(body?.message ?? `Download failed (${res.status})`, res.status, body?.code)
  }
  return res.blob()
}
