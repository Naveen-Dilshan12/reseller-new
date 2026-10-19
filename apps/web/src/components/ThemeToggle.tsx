'use client'

import React from 'react'
import { useTheme } from '@/lib/theme'

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme()

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px',
        borderRadius: '10px',
        background: 'var(--toggle-bg)',
        border: '1px solid var(--toggle-border)',
        gap: '2px',
      }}
      role="group"
      aria-label="Theme Selection"
    >
      <button
        type="button"
        onClick={() => setTheme('light')}
        title="Light theme"
        aria-label="Light theme"
        aria-pressed={theme === 'light'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: theme === 'light' ? 'var(--surface)' : 'transparent',
          color: theme === 'light' ? 'var(--primary)' : 'var(--muted)',
          boxShadow: theme === 'light' ? 'var(--shadow-sm)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      </button>

      <button
        type="button"
        onClick={() => setTheme('dark')}
        title="Dark theme"
        aria-label="Dark theme"
        aria-pressed={theme === 'dark'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: theme === 'dark' ? 'var(--surface)' : 'transparent',
          color: theme === 'dark' ? 'var(--primary-light)' : 'var(--muted)',
          boxShadow: theme === 'dark' ? 'var(--shadow-sm)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      </button>

      <button
        type="button"
        onClick={() => setTheme('system')}
        title="Follow system preference"
        aria-label="Follow system preference"
        aria-pressed={theme === 'system'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: theme === 'system' ? 'var(--surface)' : 'transparent',
          color: theme === 'system' ? 'var(--primary)' : 'var(--muted)',
          boxShadow: theme === 'system' ? 'var(--shadow-sm)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="14" x="2" y="3" rx="2" />
          <line x1="8" x2="16" y1="21" y2="21" />
          <line x1="12" x2="12" y1="17" y2="21" />
        </svg>
      </button>
    </div>
  )
}
