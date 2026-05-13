const BASE = import.meta.env.VITE_API_URL
if (!BASE) console.error('[ACR ERP] VITE_API_URL is not set — all API calls will fail. Add it to .env.local (dev) or Vercel env vars (prod).')

// In-memory CSRF token — survives SPA navigation, lost on hard reload.
// Restored via /api/auth/csrf on startup (see AuthContext) o lazy on demand.
let _csrfToken = null
let _csrfBootstrap = null

export function setCsrfToken(token) {
  _csrfToken = token ?? null
}

/**
 * Garantiza que tengamos un CSRF token en memoria antes de una mutación.
 * Si AuthContext aún no terminó de hidratar tras un hard reload, o si la
 * cookie csrf expiró y se renovó, esto lo recupera del backend.
 * Sólo se ejecuta una vez en paralelo (memoizado en _csrfBootstrap).
 */
async function ensureCsrf() {
  if (_csrfToken) return _csrfToken
  if (_csrfBootstrap) return _csrfBootstrap
  _csrfBootstrap = (async () => {
    try {
      const r = await fetch(`${BASE}/api/auth/csrf`, { credentials: 'include' })
      if (r.ok) {
        const j = await r.json()
        _csrfToken = j?.csrfToken ?? null
      }
    } catch {}
    finally { _csrfBootstrap = null }
    return _csrfToken
  })()
  return _csrfBootstrap
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

  // Para mutaciones, asegurar que el token CSRF está cargado (race con AuthContext).
  if (mutating && !_csrfToken) { await ensureCsrf() }

  const doFetch = () => fetch(`${BASE}${path}`, {
    ...rest,
    body,
    credentials: 'include',
    headers: {
      ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
      ...(mutating && _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {}),
      ...headers,
    },
  })

  let res = await doFetch()

  // Recuperación automática: si fue rechazado por CSRF, refrescar token y reintentar 1 vez.
  if (res.status === 403 && mutating) {
    let csrfFail = false
    try {
      const clone = res.clone()
      const j = await clone.json()
      if (j?.error && /csrf/i.test(j.error)) csrfFail = true
    } catch {}
    if (csrfFail) {
      _csrfToken = null
      await ensureCsrf()
      if (_csrfToken) res = await doFetch()
    }
  }

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:logout'))
  }
  return res
}
