import { createContext, useContext, useState, useEffect } from 'react'
import { setCsrfToken } from '../utils/api'

const BASE = import.meta.env.VITE_API_URL || ''
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)

  useEffect(() => {
    fetch(`${BASE}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(async u => {
        setUser(u)
        if (u) {
          // Restore in-memory CSRF token after hard reload.
          // /api/auth/csrf reads the csrf cookie server-side and echoes it —
          // works cross-origin because the browser sends the cookie even though
          // document.cookie cannot read third-party cookies (CHIPS / ITP).
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

    const handler = () => { setUser(null); setCsrfToken(null) }
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
