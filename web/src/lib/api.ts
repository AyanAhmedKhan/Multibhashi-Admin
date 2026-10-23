/**
 * Fetch wrapper for /api. It adds the session's CSRF token to state-changing requests,
 * sends JSON, and turns error bodies into ApiError. Two errors are handled centrally:
 * - STEP_UP_REQUIRED: asks the step-up handler (a code dialog) and retries once;
 * - UNAUTHENTICATED: tells the auth layer the session is gone (back to sign-in).
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>
  ) {
    super(message)
  }
}

let csrfToken = ''
let stepUpHandler: (() => Promise<boolean>) | null = null
let unauthenticatedHandler: (() => void) | null = null

export function setCsrfToken(token: string) {
  csrfToken = token
}
export function onStepUp(handler: () => Promise<boolean>) {
  stepUpHandler = handler
}
export function onUnauthenticated(handler: () => void) {
  unauthenticatedHandler = handler
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function request<T>(method: Method, path: string, body?: unknown, retried = false, background = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // Auto-refreshes don't count as activity: an unattended console still times out.
  if (background) headers['X-Background'] = '1'
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    headers['X-CSRF-Token'] = csrfToken
  }
  const res = await fetch(`/api/${path.replace(/^\//, '')}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (res.ok) return data as T

  const error = data?.error ?? {}
  const code = error.code ?? 'REQUEST'
  if (code === 'STEP_UP_REQUIRED' && !retried && stepUpHandler) {
    if (await stepUpHandler()) return request<T>(method, path, body, true)
  }
  if (res.status === 401 && code === 'UNAUTHENTICATED' && !path.startsWith('auth/login')) {
    unauthenticatedHandler?.()
  }
  throw new ApiError(res.status, code, error.message ?? `Request failed (${res.status})`, error.fields)
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | undefined | null>, opts?: { background?: boolean }) => {
    const qs = query
      ? new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return request<T>('GET', qs ? `${path}?${qs}` : path, undefined, false, opts?.background)
  },
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}

export interface Paginated<T> {
  meta: { total: number; perPage: number; currentPage: number; lastPage: number }
  data: T[]
}
