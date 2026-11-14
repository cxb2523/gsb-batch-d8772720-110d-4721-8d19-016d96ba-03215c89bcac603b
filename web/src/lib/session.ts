import { ApiError } from './errors'

/**
 * Session token handling.
 *
 * `mecha serve` opens `http://127.0.0.1:<port>/#t=<token>`. On load we read the token from
 * the fragment, keep it in sessionStorage (so a reload does not end in 401), and strip it
 * from the address bar. The fragment is never sent to the server, and sessionStorage dies
 * with the tab.
 */

export const STORAGE_KEY = 'mecha.session-token'

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Read the token from `#t=…` (preferred) or sessionStorage, and clean the URL. */
export function initSessionToken(loc: Location = window.location): string | null {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''))
  const fromHash = params.get('t')
  const store = storage()

  if (fromHash) {
    try {
      store?.setItem(STORAGE_KEY, fromHash)
    } catch {
      // Storage full or blocked: the token still works for this page load.
    }
    params.delete('t')
    const rest = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}`,
    )
    return fromHash
  }

  try {
    return store?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function clearSessionToken(): void {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export { ApiError }

/** fetch() against the local API with the session token attached. */
export async function apiFetch<T>(
  token: string | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'omit' })
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const err = (body ?? {}) as { code?: string; message?: string }
    throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? res.statusText)
  }
  return body as T
}
