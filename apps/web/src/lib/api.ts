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

export const tokens = {
  get access() {
    return typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY)
  },
  get refresh() {
    return typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY)
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access)
    localStorage.setItem(REFRESH_KEY, refresh)
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
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
      if (!res.ok) return false
      const body = (await res.json()) as Envelope<{ accessToken: string; refreshToken: string }>
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

  if (res.status === 401 && retry && tokens.refresh && !path.startsWith('/auth/')) {
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
