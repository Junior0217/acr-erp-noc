const BASE = import.meta.env.VITE_API_URL
if (!BASE) console.error('[ACR ERP] VITE_API_URL is not set — all API calls will fail. Add it to .env.local (dev) or Vercel env vars (prod).')

// In-memory CSRF token — survives SPA navigation, lost on hard reload.
// Restored via /api/auth/csrf on startup (see AuthContext).
let _csrfToken = null

export function setCsrfToken(token) {
  _csrfToken = token ?? null
}

export async function apiFetch(path, options = {}) {
  const { headers, body, ...rest } = options
  const method   = (rest.method || 'GET').toUpperCase()
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  // Si el body es FormData o Blob/File, NO forzar Content-Type:
  // el browser debe ponerlo con su boundary multipart correcto.
  const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData
  const isBlob      = typeof Blob !== 'undefined' && body instanceof Blob
  const skipContentType = isMultipart || isBlob

  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    body,
    credentials: 'include',
    headers: {
      ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
      ...(mutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
      ...headers,
    },
  })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:logout'))
  }
  return res
}
