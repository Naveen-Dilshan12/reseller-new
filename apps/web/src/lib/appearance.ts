'use client'

import { useEffect, useState } from 'react'
import { api, apiBlob } from './api'
import type { AppearanceSettings } from './appearance-utils'
import { useTheme } from './theme'

/**
 * Client side of the admin-managed portal appearance. The settings are fetched once and shared by every component
 * (and re-fetched at most once a minute as pages change). If the request fails, the portal simply keeps its
 * built-in look: nothing here throws or blocks rendering.
 */

const REFRESH_AFTER_MS = 60_000

let current: AppearanceSettings | null = null
let fetchedAt = 0
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): Promise<void> {
  inFlight ??= api<AppearanceSettings>('/appearance')
    .then((settings) => {
      current = settings
      fetchedAt = Date.now()
      listeners.forEach((notify) => notify())
    })
    .catch(() => {
      // Keep whatever is already shown (or the built-in defaults) and try again on the next page.
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Fetches the settings again right away, e.g. after an admin saved a change. */
export const refreshAppearance = () => load()

/**
 * The shared appearance settings (null until they have loaded, or when they could not be loaded). Also applies the
 * admin's default color mode, which only takes effect for users who have not picked a mode themselves.
 */
export function useAppearance(): AppearanceSettings | null {
  const [settings, setSettings] = useState<AppearanceSettings | null>(current)
  const { setDefaultTheme } = useTheme()

  useEffect(() => {
    const sync = () => setSettings(current)
    listeners.add(sync)
    if (!current || Date.now() - fetchedAt > REFRESH_AFTER_MS) void load()
    sync()
    return () => {
      listeners.delete(sync)
    }
  }, [])

  const defaultTheme = settings?.defaultTheme
  useEffect(() => {
    // setDefaultTheme only wraps a ref and a state setter, so it is left out of the dependencies on purpose.
    if (defaultTheme) setDefaultTheme(defaultTheme)
  }, [defaultTheme])

  return settings
}

// ── Private images ─────────────────────────────────────────────────────────────
// The hero image and logo are not public files: they are fetched with the user's token and shown from a blob: URL
// (the same approach as bank slips). The URL is kept for the page's lifetime so moving between pages does not refetch.

const blobUrls = new Map<string, { version: string; url: string }>()
const downloads = new Map<string, Promise<string | null>>()

function fetchImage(path: string, version: string): Promise<string | null> {
  const hit = blobUrls.get(path)
  if (hit?.version === version) return Promise.resolve(hit.url)
  const key = `${path}@${version}`
  let download = downloads.get(key)
  if (!download) {
    download = apiBlob(path)
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        blobUrls.set(path, { version, url })
        return url
      })
      .catch(() => null)
      .finally(() => downloads.delete(key))
    downloads.set(key, download)
  }
  return download
}

export type ProtectedImage = { url: string | null; status: 'none' | 'loading' | 'ready' | 'failed' }

/**
 * `path` null means "no custom image": the caller shows its built-in one. `failed` (e.g. the file could not be read on
 * the server) also means the built-in image should be shown; `loading` lets the caller avoid flashing the built-in
 * image just before the custom one arrives.
 */
export function useProtectedImage(path: string | null, version: string | undefined): ProtectedImage {
  const cached = path && version && blobUrls.get(path)?.version === version ? blobUrls.get(path)!.url : null
  const [result, setResult] = useState<{ key: string; url: string | null } | null>(null)
  const key = path && version ? `${path}@${version}` : null

  useEffect(() => {
    if (!path || !version) return
    let active = true
    fetchImage(path, version).then((url) => active && setResult({ key: `${path}@${version}`, url }))
    return () => {
      active = false
    }
  }, [path, version])

  if (!key) return { url: null, status: 'none' }
  if (cached) return { url: cached, status: 'ready' }
  if (result?.key !== key) return { url: null, status: 'loading' }
  return result.url ? { url: result.url, status: 'ready' } : { url: null, status: 'failed' }
}
