import { createContext, useContext, useEffect, useState, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || ''
const EmpresaContext = createContext(null)

// Defaults usados antes de que /api/configuracion/empresa/publico responda.
// Garantizan que la app nunca renderiza "undefined" si el endpoint cae.
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

export function EmpresaProvider({ children }) {
  const [empresa, setEmpresa] = useState(DEFAULT_EMPRESA)
  const [loading, setLoading] = useState(true)
  const [hasFull, setHasFull] = useState(false)

  const refresh = useCallback(async (preferFull = false) => {
    setLoading(true)
    // Si el user está logueado y queremos PII (representante), usa el endpoint full.
    // Si no, el público es suficiente para membretes/PDFs.
    const tryFull = preferFull
    try {
      let r = tryFull
        ? await fetch(`${API}/api/configuracion/empresa`, { credentials: 'include' })
        : null
      if (r?.ok) {
        const j = await r.json()
        setEmpresa({ ...DEFAULT_EMPRESA, ...j, assets: { ...DEFAULT_EMPRESA.assets, ...(j.assets ?? {}) } })
        setHasFull(true)
        return
      }
      r = await fetch(`${API}/api/configuracion/empresa/publico`)
      if (r.ok) {
        const j = await r.json()
        setEmpresa({ ...DEFAULT_EMPRESA, ...j, assets: { ...DEFAULT_EMPRESA.assets, ...(j.assets ?? {}) } })
        setHasFull(false)
      }
    } catch {
      // Mantiene defaults
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh(true) }, [refresh])

  return (
    <EmpresaContext.Provider value={{ empresa, loading, hasFull, refresh }}>
      {children}
    </EmpresaContext.Provider>
  )
}

export function useEmpresa() {
  const ctx = useContext(EmpresaContext)
  if (!ctx) {
    // Fallback seguro: si se usa fuera del provider, devuelve defaults
    return { empresa: DEFAULT_EMPRESA, loading: false, hasFull: false, refresh: () => Promise.resolve() }
  }
  return ctx
}
