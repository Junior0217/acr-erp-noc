/**
 * portalApi — wrapper de fetch para endpoints del Portal B2C.
 * Añade automáticamente el header X-Portal-CSRF en métodos mutantes
 * leyendo la cookie pct-csrf (no httpOnly).
 *
 * Uso:
 *   import { portalFetch, getPortalCsrf } from '../utils/portalApi'
 *   await portalFetch('/api/portal/sos', { method: 'POST' })
 */
const BASE = import.meta.env.VITE_API_URL || ''

function readCookie(name) {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : null
}

export function getPortalCsrf() {
  return readCookie('pct-csrf')
}

/**
 * Si no hay cookie pct-csrf (hard reload + cookie httpOnly bloqueada via CHIPS),
 * llama al endpoint /api/portal/auth/csrf que regenera o devuelve la existente.
 * Vive in-memory entre navegaciones.
 */
let _portalCsrfInMemory = null

export async function ensurePortalCsrf() {
  let token = _portalCsrfInMemory ?? readCookie('pct-csrf')
  if (token) return token
  try {
    const r = await fetch(`${BASE}/api/portal/auth/csrf`, { credentials: 'include' })
    if (!r.ok) return null
    const j = await r.json()
    _portalCsrfInMemory = j.csrfToken ?? null
    return _portalCsrfInMemory
  } catch { return null }
}

export async function portalFetch(path, options = {}) {
  const method   = (options.method ?? 'GET').toUpperCase()
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'

  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) }

  if (mutating) {
    const csrf = await ensurePortalCsrf()
    if (csrf) headers['X-Portal-CSRF'] = csrf
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  })

  if (res.status === 403) {
    // Posible CSRF inválido tras logout → limpia y notifica
    try {
      const clone = res.clone()
      const j = await clone.json()
      if (j.code === 'PORTAL_CSRF_INVALID') {
        _portalCsrfInMemory = null
        window.dispatchEvent(new CustomEvent('portal:csrf-fail'))
      }
    } catch {}
  }
  return res
}
