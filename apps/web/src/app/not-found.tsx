import Link from 'next/link'

/**
 * Shown for every unknown address. Next's built-in 404 sets its own text and background colours, which clash with the portal's
 * dark default (white text on a white page). This one only uses the portal's theme classes, so it is readable in both modes.
 */
export default function NotFound() {
  return (
    <main className="container narrow" style={{ minHeight: '70vh', display: 'grid', placeItems: 'center' }}>
      <section className="card" style={{ textAlign: 'center', width: '100%', maxWidth: 480 }}>
        <p className="small muted" style={{ margin: '0 0 0.25rem', fontWeight: 700, letterSpacing: '0.08em' }}>
          404
        </p>
        <h1>Page not found</h1>
        <p className="muted">The page you are looking for does not exist or may have moved.</p>
        <Link href="/dashboard" className="btn">
          Go to dashboard
        </Link>
      </section>
    </main>
  )
}
