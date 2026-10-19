'use client'

import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { BUILT_IN_THEME, THEME_DEFAULT_KEY, THEME_STORAGE_KEY, parseThemeMode, resolveThemeMode, type ThemeMode } from './appearance-utils'

export type Theme = ThemeMode
export type ResolvedTheme = 'dark' | 'light'

interface ThemeContextType {
  theme: Theme
  resolvedTheme: ResolvedTheme
  /** The user's own choice: remembered, and from then on it wins over the admin default. */
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  /** The admin's default color mode. Used only while the user has made no choice of their own. */
  setDefaultTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextType>({
  theme: BUILT_IN_THEME,
  resolvedTheme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
  setDefaultTheme: () => {},
})

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(BUILT_IN_THEME)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('dark')
  const [mounted, setMounted] = useState(false)
  // True once the user has picked a mode in this browser (also when storage is blocked and the pick only lives in memory).
  const chosenByUser = useRef(false)

  // Initialize from the user's own choice, else the admin default last seen on this browser, else the built-in mode
  useEffect(() => {
    const own = parseThemeMode(readStorage(THEME_STORAGE_KEY))
    chosenByUser.current = own !== null
    setThemeState(resolveThemeMode(own, readStorage(THEME_DEFAULT_KEY)))
    setMounted(true)
  }, [])

  // Resolve active theme when theme or system preferences change
  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const computeResolved = (t: Theme): ResolvedTheme => {
      if (t === 'system') {
        return mediaQuery.matches ? 'dark' : 'light'
      }
      return t
    }

    const currentResolved = computeResolved(theme)
    setResolvedTheme(currentResolved)

    // Update document element class and data-theme attribute
    const root = document.documentElement
    root.setAttribute('data-theme', currentResolved)
    if (currentResolved === 'light') {
      root.classList.add('light-theme')
      root.classList.remove('dark-theme')
    } else {
      root.classList.add('dark-theme')
      root.classList.remove('light-theme')
    }

    // Listener for system preference changes if in 'system' mode
    const handler = () => {
      if (theme === 'system') {
        const nextResolved = mediaQuery.matches ? 'dark' : 'light'
        setResolvedTheme(nextResolved)
        root.setAttribute('data-theme', nextResolved)
        if (nextResolved === 'light') {
          root.classList.add('light-theme')
          root.classList.remove('dark-theme')
        } else {
          root.classList.add('dark-theme')
          root.classList.remove('light-theme')
        }
      }
    }

    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [theme])

  const setTheme = (newTheme: Theme) => {
    chosenByUser.current = true
    setThemeState(newTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme)
    } catch {
      // Storage unavailable or disabled
    }
  }

  const setDefaultTheme = (adminDefault: Theme) => {
    try {
      localStorage.setItem(THEME_DEFAULT_KEY, adminDefault)
    } catch {
      // Storage unavailable or disabled
    }
    if (!chosenByUser.current) setThemeState(adminDefault)
  }

  const toggleTheme = () => {
    const next: Theme = resolvedTheme === 'dark' ? 'light' : 'dark'
    setTheme(next)
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme, setDefaultTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
