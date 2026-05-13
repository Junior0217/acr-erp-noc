const BASE = import.meta.env.VITE_API_URL
if (!BASE) console.error('[ACR ERP] VITE_API_URL is not set — all API calls will fail. Add it to .env.local (dev) or Vercel env vars (prod).')

// ─── Version sync ────────────────────────────────────────────────────────────
// El backend inyecta X-App-Version en cada respuesta /api/*. Si el frontend
// detecta un valor distinto al que vio en la primera respuesta de esta sesión,
// significa que el backend fue redeployed -> contratos pueden haber cambiado.
// Reload duro + limpieza de caches de SW para tomar el bundle nuevo.
let _knownBackendVersion = null
let _reloadScheduled     = false

async function purgeSwCaches() {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
  } catch {}
}

function checkVersionDrift(res) {
  try {
    const v = res.headers.get('X-App-Version')
    if (!v) return
    if (!_knownBackendVersion) {
      _knownBackendVersion = v
      // Compare with persisted version from prior session (catches stale bundle on hard reload too).
      const persisted = localStorage.getItem('acr_backend_version')
      if (persisted && persisted !== v) {
        localStorage.setItem('acr_backend_version', v)
        scheduleReload()
        return
      }
      localStorage.setItem('acr_backend_version', v)
      return
    }
    if (v !== _knownBackendVersion) {
      _knownBackendVersion = v
      localStorage.setItem('acr_backend_version', v)
      scheduleReload()
    }
  } catch {}
}

function scheduleReload() {
  if (_reloadScheduled) return
  _reloadScheduled = true
  // Pequeño delay para mostrar toast si la app lo escucha; igual recarga forzado.
  window.dispatchEvent(new CustomEvent('app:version-mismatch', { detail: { version: _knownBackendVersion } }))
  setTimeout(async () => {
    await purgeSwCaches()
    // location.reload(true) está deprecado pero sigue funcionando en Chrome/Edge;
    // forzamos invalidación del HTTP cache con un query bust antes del reload.
    const u = new URL(window.location.href)
    u.searchParams.set('_v', _knownBackendVersion ?? Date.now())
    window.location.replace(u.toString())
  }, 1500)
}

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
  checkVersionDrift(res)

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
