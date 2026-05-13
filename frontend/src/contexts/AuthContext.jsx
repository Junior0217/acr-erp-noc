import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { setCsrfToken } from '../utils/api'

const BASE = import.meta.env.VITE_API_URL || ''
const AuthContext = createContext(null)

// Llaves de localStorage que se limpian al forzar logout. Cualquier dato cacheado
// del usuario anterior NO debe sobrevivir al cambio de sesión (multi-tenant safe).
const LS_KEYS_TO_PURGE = [
  'cart',                  // carrito tienda legacy
  'acr_pos_cart',          // carrito POS persistente
  'acr_backend_version',   // version-sync cache
  'acr_inv_view',          // pref vista inventario
  'acr_cot_view',          // pref vista cotizaciones
]

// Evita disparos múltiples del flujo de logout en una misma ronda (varios 401
// paralelos no deben multiplicar toasts ni redirects).
let _logoutInFlight = false

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)
  // Ref espejo para que el handler de 'auth:logout' (closure) lea el valor más
  // reciente de `user` sin depender de re-suscripción del listener.
  const userRef = useRef(undefined)
  userRef.current = user

  useEffect(() => {
    fetch(`${BASE}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(async u => {
        setUser(u)
        if (u) {
          try {
            const cr = await fetch(`${BASE}/api/auth/csrf`, { credentials: 'include' })
            if (cr.ok) {
              const { csrfToken } = await cr.json()
              setCsrfToken(csrfToken)
            }
          } catch {}
        }
      })
      .catch(() => setUser(null))

    function purgeClientState() {
      setUser(null)
      setCsrfToken(null)
      for (const k of LS_KEYS_TO_PURGE) {
        try { localStorage.removeItem(k) } catch {}
      }
      // sessionStorage también — algunas vistas guardan filtros ahí.
      try { sessionStorage.clear() } catch {}
    }

    function handler(e) {
      if (_logoutInFlight) return
      _logoutInFlight = true
      // Lee el user MÁS RECIENTE via ref. wasLoggedIn=true SOLO si user es objeto
      // (no null no undefined). H10: undefined = AuthContext aún hidratando -> el
      // 401 es por sesión-nunca-iniciada, NO toast falso "Sesión cerrada por seguridad".
      const wasLoggedIn  = userRef.current !== null && userRef.current !== undefined
      const hidratando   = userRef.current === undefined
      purgeClientState()

      // Rutas públicas que NO deben redirigir (portal cliente, tracking, verify).
      const path = window.location.pathname
      const isPublic = path.startsWith('/login') || path.startsWith('/portal')
                    || path.startsWith('/track') || path.startsWith('/verify')
                    || path.startsWith('/tienda') || path.startsWith('/cotizacion-dgii')

      // Toast SOLO cuando el user estaba realmente logueado. Si hidratando o nunca
      // logueado, redirigimos silenciosamente sin alarma falsa.
      if (wasLoggedIn) {
        const reason = e?.detail?.reason ?? 'expirada'
        toast.error('Sesión cerrada por seguridad', {
          description: reason === 'csrf_persistente'
            ? 'Tu sesión ya no es válida en el servidor. Por favor inicia sesión de nuevo.'
            : reason === 'csrf_bootstrap_fail'
              ? 'No se pudo refrescar el token CSRF. Reautenticación requerida.'
              : 'Tu sesión expiró, fue revocada o el usuario fue eliminado.',
          duration: 5000,
        })
      }
      if (!isPublic) {
        // Sin toast -> redirigimos inmediato. Con toast -> esperamos 900ms para que sea visible.
        setTimeout(() => {
          window.location.replace('/login')
        }, wasLoggedIn ? 900 : 0)
      }
      // Si hidratando, permite reintentos rápidos cuando AuthContext termine de cargar.
      setTimeout(() => { _logoutInFlight = false }, hidratando ? 500 : 2500)
    }
    window.addEventListener('auth:logout', handler)
    return () => window.removeEventListener('auth:logout', handler)
  }, [])

  async function login(email, password, rememberMe = false) {
    const chalRes = await fetch(`${BASE}/api/auth/challenge`, { credentials: 'include' })
    if (!chalRes.ok) throw new Error('Error obteniendo challenge de autenticación.')
    const { cid, publicKey: pubKeyB64 } = await chalRes.json()

    const spkiDer   = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0))
    const cryptoKey = await window.crypto.subtle.importKey(
      'spki', spkiDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
    )
    const cipherBuf  = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, cryptoKey, new TextEncoder().encode(password))
    const ciphertext = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)))

    const r    = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, cid, ciphertext, rememberMe }),
    })
    const json = await r.json()
    if (!r.ok) throw new Error(json.error ?? 'Error al iniciar sesión')

    // 2FA required — token not yet issued, csrf comes after TOTP step
    if (json.requires2FA) return json

    setCsrfToken(json.csrfToken ?? null)
    setUser(json)
    return json
  }

  async function verifyTOTP(tempToken, totp) {
    const r = await fetch(`${BASE}/api/auth/2fa/verify`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, totp }),
    })
    const json = await r.json()
    if (!r.ok) throw new Error(json.error ?? 'PIN inválido')
    setCsrfToken(json.csrfToken ?? null)
    setUser(json)
    return json
  }

  async function refreshUser() {
    try {
      const r = await fetch(`${BASE}/api/auth/me`, { credentials: 'include' })
      if (r.ok) setUser(await r.json())
    } catch {}
  }

  async function logout() {
    try {
      await fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' })
    } catch {}
    setCsrfToken(null)
    setUser(null)
    for (const k of LS_KEYS_TO_PURGE) { try { localStorage.removeItem(k) } catch {} }
    try { sessionStorage.clear() } catch {}
  }

  function tienePermiso(permiso) {
    if (!user) return false
    const permisos = Array.isArray(user.permisos) ? user.permisos : []
    if (permisos.includes('sistema:owner')) return true
    return permisos.includes(permiso)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, verifyTOTP, tienePermiso, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
