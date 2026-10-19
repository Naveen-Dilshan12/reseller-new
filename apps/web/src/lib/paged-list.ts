/**
 * The logic behind a filterable, paged admin list, kept free of React and imports so it can be tested without a DOM.
 * A "view" is what the user has chosen; every change to it is a new object, or the same object when nothing changed
 * (so React does not reload the list for a no-op click).
 */

export interface ListView {
  status: string
  query: string
  page: number
}

export const INITIAL_LIST_VIEW: ListView = { status: '', query: '', page: 1 }

/** Choosing a status tab starts again from page 1. */
export function withStatus(view: ListView, status: string): ListView {
  return view.status === status && view.page === 1 ? view : { ...view, status, page: 1 }
}

/** Submitting a search starts again from page 1; a blank search clears it. */
export function withSearch(view: ListView, search: string): ListView {
  const query = search.trim()
  return view.query === query && view.page === 1 ? view : { ...view, query, page: 1 }
}

/** Moves within the current filter; never below page 1. */
export function withPage(view: ListView, page: number): ListView {
  const next = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : view.page
  return next === view.page ? view : { ...view, page: next }
}

/** Query string for the list endpoint. The All tab and an empty search send no `status` / `search`. */
export function listQuery(view: ListView, limit: number): URLSearchParams {
  const params = new URLSearchParams({ page: String(view.page), limit: String(limit) })
  if (view.status) params.set('status', view.status)
  if (view.query) params.set('search', view.query)
  return params
}

/**
 * If the list shrank while the user was on a later page (e.g. they reactivated the only row on page 2), the
 * server answers with an empty page past the end. Returns the last real page to go to, or null when the
 * response is fine, including a genuinely empty result.
 */
export function outOfRangePage(page: number, total: number | undefined, totalPages: number | undefined): number | null {
  if (!total || !totalPages || page <= totalPages) return null
  return totalPages
}

/**
 * Starts requests but lets only the most recently started one deliver its outcome. A slower, older response
 * (or error) can never overwrite what a newer request has shown or is about to show.
 */
export function createLatestLoader() {
  let latest = 0
  return function load<T>(request: () => Promise<T>, handlers: { onSuccess: (value: T) => void; onError: (error: unknown) => void }): void {
    const mine = ++latest
    let pending: Promise<T>
    try {
      pending = request()
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending.then(
      (value) => {
        if (mine === latest) handlers.onSuccess(value)
      },
      (error) => {
        if (mine === latest) handlers.onError(error)
      },
    )
  }
}
