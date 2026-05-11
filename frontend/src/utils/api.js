const BASE = import.meta.env.VITE_API_URL
if (!BASE) console.error('[ACR ERP] VITE_API_URL is not set — all API calls will fail. Add it to .env.local (dev) or Vercel env vars (prod).')

// In-memory CSRF token — survives SPA navigation, lost on hard reload.
// Restored via /api/auth/csrf on startup (see AuthContext).
let _csrfToken = null

export function setCsrfToken(token) {
  _csrfToken = token ?? null
}

export async function apiFetch(path, options = {}) {
  const { headers, ...rest } = options
  const method   = (rest.method || 'GET').toUpperCase()
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(mutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
      ...headers,
    },
  })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:logout'))
  }
  return res
}
