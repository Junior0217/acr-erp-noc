import { createContext, useContext, useEffect, useState, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || ''
const EmpresaContext = createContext(null)

// Defaults usados antes de que /api/configuracion/empresa/publico responda.
const DEFAULT_EMPRESA = {
  rnc:             '133692678',
  razonSocial:     'ACR NETWORKS & SOLUTIONS, S.R.L.',
  nombreComercial: 'ACR Networks',
  registroMercantil:'220982SD',
  direccion:       'Calle Feliz Evaristo Mejía, No. 406',
  sector:          'Cristo Rey',
  provincia:       'Santo Domingo, Distrito Nacional',
  pais:            'República Dominicana',
  telefono:        '849-458-9955 / 809-670-9956',
  email:           'ranetworkssolutions@gmail.com',
  website:         '',
  assets: {
    logoClaro:    '/logo-acr.png',
    logoOscuro:   '/logo-acr.png',
    selloFisico:  '',
    firmaGerente: '',
  },
  eslogan:         'Soluciones en Seguridad Electrónica, Redes y Soporte IT Corporativo',
  representanteNombre:   null,
  representanteApellido: null,
  representanteCargo:    null,
}

const CACHE_KEY = 'acr.empresa.publico.v1'
const CACHE_TTL_MS = 5 * 60 * 1000

// Sólo campos seguros para localStorage (CISO: nada de PII representante).
const PUBLIC_FIELDS = [
  'rnc','razonSocial','nombreComercial','registroMercantil',
  'direccion','sector','provincia','pais',
  'telefono','email','website','eslogan',
]

function pickPublic(obj) {
  const out = {}
  for (const k of PUBLIC_FIELDS) if (obj[k] !== undefined) out[k] = obj[k]
  // assets: sólo logos (sello y firma NO se cachean — son confidenciales)
  if (obj.assets) {
    out.assets = {
      logoClaro:  obj.assets.logoClaro  ?? null,
      logoOscuro: obj.assets.logoOscuro ?? null,
    }
  }
  return out
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.data || !parsed?.expiresAt) return null
    if (parsed.expiresAt < Date.now()) {
      localStorage.removeItem(CACHE_KEY)
      return null
    }
    return parsed.data
  } catch { return null }
}

function writeCache(data) {
  try {
    const safe = pickPublic(data)
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: safe, expiresAt: Date.now() + CACHE_TTL_MS }))
  } catch { /* quota o privacy mode — ignorar */ }
}

function mergeAssets(...sources) {
  return sources.reduce((acc, s) => ({ ...acc, ...(s?.assets ?? {}) }), {})
}

export function EmpresaProvider({ children }) {
  // Inicialización síncrona desde cache: first paint instantáneo (sin spinner)
  const cached = readCache()
  const initial = cached
    ? { ...DEFAULT_EMPRESA, ...cached, assets: mergeAssets(DEFAULT_EMPRESA, cached) }
    : DEFAULT_EMPRESA

  const [empresa, setEmpresa] = useState(initial)
  const [loading, setLoading] = useState(!cached)   // si hay cache, no mostrar loading
  const [hasFull, setHasFull] = useState(false)
  const [stale, setStale]     = useState(!!cached)  // si renderizamos desde cache, marcar stale hasta refresh

  const refresh = useCallback(async (preferFull = false) => {
    try {
      // Si preferFull (post-login), intenta el endpoint full primero
      if (preferFull) {
        const r = await fetch(`${API}/api/configuracion/empresa`, { credentials: 'include' })
        if (r.ok) {
          const j = await r.json()
          setEmpresa({ ...DEFAULT_EMPRESA, ...j, assets: mergeAssets(DEFAULT_EMPRESA, j) })
          setHasFull(true)
          setStale(false)
          // Cachea SOLO campos públicos (sin PII representante)
          writeCache(j)
          return
        }
      }
      const r = await fetch(`${API}/api/configuracion/empresa/publico`)
      if (r.ok) {
        const j = await r.json()
        setEmpresa({ ...DEFAULT_EMPRESA, ...j, assets: mergeAssets(DEFAULT_EMPRESA, j) })
        setHasFull(false)
        setStale(false)
        writeCache(j)
      }
    } catch {
      // Mantiene defaults o cache. NO marca como definitivo error.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Si tenemos cache fresca, fetch en BACKGROUND silencioso (no flicker).
    // Si no, fetch normal con loading=true.
    refresh(true)
  }, [refresh])

  function invalidarCache() {
    try { localStorage.removeItem(CACHE_KEY) } catch {}
  }

  return (
    <EmpresaContext.Provider value={{ empresa, loading, hasFull, stale, refresh, invalidarCache }}>
      {children}
    </EmpresaContext.Provider>
  )
}

export function useEmpresa() {
  const ctx = useContext(EmpresaContext)
  if (!ctx) {
    return { empresa: DEFAULT_EMPRESA, loading: false, hasFull: false, stale: false, refresh: () => Promise.resolve(), invalidarCache: () => {} }
  }
  return ctx
}
