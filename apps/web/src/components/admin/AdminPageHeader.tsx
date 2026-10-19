import type { ReactNode } from 'react'

/** Consistent page title block for every Admin page: title, one-line purpose, optional actions. */
export function AdminPageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="admin-page-header">
      <div className="admin-page-header-text">
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="admin-page-header-actions">{actions}</div>}
    </header>
  )
}
