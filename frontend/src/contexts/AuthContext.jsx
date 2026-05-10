import { createContext, useContext, useState, useEffect } from 'react'

const BASE = 'http://localhost:3000'
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)

  useEffect(() => {
    fetch(`${BASE}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => setUser(u))
      .catch(() => setUser(null))

    const handler = () => setUser(null)
    window.addEventListener('auth:logout', handler)
    return () => window.removeEventListener('auth:logout', handler)
  }, [])

  async function login(email, password) {
    // 1. Get ephemeral RSA challenge
    const chalRes = await fetch(`${BASE}/api/auth/challenge`, { credentials: 'include' })
    if (!chalRes.ok) throw new Error('Error obteniendo challenge de autenticación.')
    const { cid, publicKey: pubKeyB64 } = await chalRes.json()

    // 2. Import SPKI public key via WebCrypto API
    const spkiDer  = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0))
    const cryptoKey = await window.crypto.subtle.importKey(
      'spki', spkiDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
    )

    // 3. Encrypt password — plaintext never leaves the browser unencrypted
    const cipherBuf  = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, cryptoKey, new TextEncoder().encode(password))
    const ciphertext = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)))

    // 4. Login with encrypted credentials
    const r    = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, cid, ciphertext }),
    })
    const json = await r.json()
    if (!r.ok) throw new Error(json.error ?? 'Error al iniciar sesión')
    setUser(json)
    return json
  }

  async function logout() {
    try {
      await fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' })
    } catch {}
    setUser(null)
  }

  function tienePermiso(permiso) {
    if (!user) return false
    const permisos = Array.isArray(user.permisos) ? user.permisos : []
    if (permisos.includes('sistema:owner')) return true
    return permisos.includes(permiso)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, tienePermiso }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
