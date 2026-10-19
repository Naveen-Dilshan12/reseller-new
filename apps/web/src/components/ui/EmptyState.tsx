export function EmptyState({ title, hint, children }: { title: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '3.5rem 2rem',
      background: 'var(--surface)',
      borderRadius: 'var(--radius)',
      border: '1px dashed var(--border)',
      textAlign: 'center',
      gap: '0.85rem'
    }}>
      <span style={{ color: 'var(--primary-light)', background: 'var(--surface-hover)', padding: '0.75rem', borderRadius: '12px', display: 'inline-flex' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" />
        </svg>
      </span>
      <div>
        <strong style={{ color: 'var(--text-heading)', fontSize: '1.05rem', display: 'block', marginBottom: '0.25rem' }}>{title}</strong>
        {hint && <span style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>{hint}</span>}
      </div>
      {children && <div style={{ marginTop: '0.75rem' }}>{children}</div>}
    </div>
  )
}
