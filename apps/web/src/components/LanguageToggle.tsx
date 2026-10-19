'use client'

import React from 'react'
import { useLanguage } from '@/lib/i18n'

export function LanguageToggle({ className }: { className?: string }) {
  const { language, setLanguage } = useLanguage()

  return (
    <div
      className={className}
      role="group"
      aria-label="Language selection"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px',
        borderRadius: '10px',
        background: 'var(--toggle-bg)',
        border: '1px solid var(--toggle-border)',
        gap: '2px',
      }}
    >
      <button
        type="button"
        onClick={() => setLanguage('en')}
        aria-pressed={language === 'en'}
        title="English"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 0.55rem',
          height: '28px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: language === 'en' ? 'var(--surface)' : 'transparent',
          color: language === 'en' ? 'var(--primary)' : 'var(--muted)',
          boxShadow: language === 'en' ? 'var(--shadow-sm)' : 'none',
          fontWeight: language === 'en' ? 700 : 500,
          fontSize: '0.74rem',
          letterSpacing: '0.02em',
          transition: 'all 0.15s ease',
        }}
      >
        EN
      </button>

      <button
        type="button"
        onClick={() => setLanguage('si')}
        aria-pressed={language === 'si'}
        title="සිංහල (Sinhala)"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 0.65rem',
          height: '28px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: language === 'si' ? 'var(--surface)' : 'transparent',
          color: language === 'si' ? 'var(--primary)' : 'var(--muted)',
          boxShadow: language === 'si' ? 'var(--shadow-sm)' : 'none',
          fontWeight: language === 'si' ? 700 : 500,
          fontSize: '0.74rem',
          letterSpacing: '0.01em',
          transition: 'all 0.15s ease',
        }}
      >
        සිංහල
      </button>
    </div>
  )
}
