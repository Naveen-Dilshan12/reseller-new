'use client'

export interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
}

interface Props {
  meta: PaginationMeta | null | undefined
  onPage: (page: number) => void
  /** Plural noun for the summary, e.g. "requests". */
  noun?: string
  /** Disable the buttons while a page is loading. */
  busy?: boolean
}

/**
 * Prev/Next controls driven by the backend's `meta` (total / page / limit / totalPages),
 * which every paginated list endpoint already returns. Renders nothing for a single page.
 */
export function Pagination({ meta, onPage, noun = 'items', busy = false }: Props) {
  if (!meta || meta.totalPages <= 1) return null
  const { page, totalPages, total, limit } = meta
  const from = (page - 1) * limit + 1
  const to = Math.min(page * limit, total)

  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted small" aria-live="polite">
        Showing {from}–{to} of {total} {noun}
      </span>
      <div className="pagination-controls">
        <button className="btn secondary small" disabled={busy || page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          ← Prev
        </button>
        <span className="pagination-position" aria-current="page">
          {page} / {totalPages}
        </span>
        <button className="btn secondary small" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next →
        </button>
      </div>
    </nav>
  )
}
