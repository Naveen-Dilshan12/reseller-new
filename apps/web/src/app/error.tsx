'use client'

import { useEffect } from 'react'

/**
 * Shown when a page throws. Like not-found.tsx, it sets no colours of its own: everything comes from the portal's theme
 * classes (.card, .muted, .btn, h1), so it is readable in both dark and light mode.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="container narrow" style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>
      <section className="card" style={{ textAlign: 'center', width: '100%', maxWidth: 480 }}>
        <h1>Something went wrong</h1>
        <p className="muted">{error.message || 'The server could not be reached.'}</p>
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  )
}
