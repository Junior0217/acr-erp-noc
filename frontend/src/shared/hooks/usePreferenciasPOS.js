/**
 * frontend/src/shared/hooks/usePreferenciasPOS.js
 *
 * Hook para leer y persistir las preferencias visuales del POS por cajero
 * (mostrarValidez / mostrarFormaPago / mostrarEntrega / mostrarGarantia /
 * mostrarNotas). Persiste contra GET/PUT /api/preferencias-pos con debounce
 * para no spammear el backend al click cada switch.
 *
 * Devuelve:
 *   prefs           — objeto con los 5 booleans + estado de carga
 *   actualizar      — fn que recibe parciales y persiste (debounced 600 ms)
 *   reload          — fn que fuerza re-fetch
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@shared/utils/api'

const DEFAULTS = {
  mostrarValidez:   true,
  mostrarFormaPago: true,
  mostrarEntrega:   true,
  mostrarGarantia:  true,
  mostrarNotas:     false,
}

export default function usePreferenciasPOS() {
  const [prefs, setPrefs]       = useState({ ...DEFAULTS, loading: true })
  const debounceRef             = useRef(null)
  const pendingPatchRef         = useRef({})
  const aliveRef                = useRef(true)

  // Fetch inicial
  const reload = useCallback(async () => {
    try {
      const res = await apiFetch('/api/preferencias-pos')
      if (!res.ok) throw new Error('GET preferencias-pos no OK')
      const data = await res.json()
      if (!aliveRef.current) return
      setPrefs({
        mostrarValidez:   typeof data.mostrarValidez   === 'boolean' ? data.mostrarValidez   : DEFAULTS.mostrarValidez,
        mostrarFormaPago: typeof data.mostrarFormaPago === 'boolean' ? data.mostrarFormaPago : DEFAULTS.mostrarFormaPago,
        mostrarEntrega:   typeof data.mostrarEntrega   === 'boolean' ? data.mostrarEntrega   : DEFAULTS.mostrarEntrega,
        mostrarGarantia:  typeof data.mostrarGarantia  === 'boolean' ? data.mostrarGarantia  : DEFAULTS.mostrarGarantia,
        mostrarNotas:     typeof data.mostrarNotas     === 'boolean' ? data.mostrarNotas     : DEFAULTS.mostrarNotas,
        loading:          false,
      })
    } catch {
      if (!aliveRef.current) return
      setPrefs(p => ({ ...DEFAULTS, ...p, loading: false }))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    reload()
    return () => { aliveRef.current = false }
  }, [reload])

  // Persist con debounce
  const _flush = useCallback(async () => {
    const patch = { ...pendingPatchRef.current }
    pendingPatchRef.current = {}
    if (Object.keys(patch).length === 0) return
    try {
      await apiFetch('/api/preferencias-pos', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
    } catch { /* silencio — preferencia visual, falla no es crítica */ }
  }, [])

  const actualizar = useCallback((parcial) => {
    setPrefs(p => ({ ...p, ...parcial }))
    pendingPatchRef.current = { ...pendingPatchRef.current, ...parcial }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(_flush, 600)
  }, [_flush])

  return { prefs, actualizar, reload }
}
