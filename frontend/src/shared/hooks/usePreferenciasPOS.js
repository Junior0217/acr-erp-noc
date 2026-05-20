/**
 * frontend/src/shared/hooks/usePreferenciasPOS.js
 *
 * Hook singleton para preferencias visuales del POS por cajero. Optimizado
 * multi-tab:
 *   - Module-level cache: una sola fuente de verdad para todas las instancias
 *     del hook en el mismo árbol React.
 *   - localStorage cache: warm-start sin esperar el GET inicial (UI no parpadea).
 *   - BroadcastChannel: cuando una tab persiste un cambio, las tabs hermanas
 *     del mismo navegador reciben la actualización sin GET adicional.
 *   - Debounce 600 ms para PUT al backend (no spamea al click de cada switch).
 *
 * Reduce las llamadas GET de N (una por tab) a 1 por sesión del navegador.
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

const LS_KEY = 'acr.preferenciasPOS.v1'
const BC_NAME = 'acr.preferenciasPOS'

// ─── Module-level singleton state ────────────────────────────────────────────

let _cache         = null            // último valor conocido (compartido entre instancias)
let _initialFetch  = null            // promise del GET inicial (deduplica concurrentes)
let _broadcast     = null            // BroadcastChannel (lazy)
const _subscribers = new Set()       // setState callbacks de cada instancia montada

function _readLS() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return { ...DEFAULTS, ...parsed }
  } catch { return null }
}

function _writeLS(value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(value))
  } catch { /* quota / private mode — silencio */ }
}

function _getBroadcast() {
  if (_broadcast !== null) return _broadcast
  if (typeof BroadcastChannel === 'undefined') {
    _broadcast = false // sentinel: no disponible
    return null
  }
  try {
    _broadcast = new BroadcastChannel(BC_NAME)
    _broadcast.onmessage = (ev) => {
      const next = ev?.data
      if (!next || typeof next !== 'object') return
      _setCache({ ...DEFAULTS, ...next, loading: false }, { broadcast: false, persistLS: true })
    }
    return _broadcast
  } catch {
    _broadcast = false
    return null
  }
}

function _setCache(next, opts = {}) {
  _cache = next
  if (opts.persistLS !== false) _writeLS(next)
  if (opts.broadcast !== false) {
    const bc = _getBroadcast()
    if (bc) {
      try { bc.postMessage(next) } catch { /* silencio */ }
    }
  }
  for (const sub of _subscribers) {
    try { sub(next) } catch { /* silencio */ }
  }
}

async function _bootstrapFetch() {
  if (_initialFetch) return _initialFetch
  _initialFetch = (async () => {
    try {
      const res = await apiFetch('/api/preferencias-pos')
      if (!res.ok) throw new Error('GET preferencias-pos no OK')
      const data = await res.json()
      const next = {
        mostrarValidez:   typeof data.mostrarValidez   === 'boolean' ? data.mostrarValidez   : DEFAULTS.mostrarValidez,
        mostrarFormaPago: typeof data.mostrarFormaPago === 'boolean' ? data.mostrarFormaPago : DEFAULTS.mostrarFormaPago,
        mostrarEntrega:   typeof data.mostrarEntrega   === 'boolean' ? data.mostrarEntrega   : DEFAULTS.mostrarEntrega,
        mostrarGarantia:  typeof data.mostrarGarantia  === 'boolean' ? data.mostrarGarantia  : DEFAULTS.mostrarGarantia,
        mostrarNotas:     typeof data.mostrarNotas     === 'boolean' ? data.mostrarNotas     : DEFAULTS.mostrarNotas,
        loading:          false,
      }
      _setCache(next)
      return next
    } catch {
      // Fallback al cache LS (si existía) o DEFAULTS.
      const ls = _readLS()
      const next = { ...DEFAULTS, ...(ls || {}), loading: false }
      _setCache(next, { broadcast: false })
      return next
    }
  })()
  return _initialFetch
}

// Persist con debounce, compartido entre todas las instancias del hook.
let _debounceTimer = null
let _pendingPatch = {}
function _scheduleFlush() {
  if (_debounceTimer) clearTimeout(_debounceTimer)
  _debounceTimer = setTimeout(async () => {
    const patch = { ..._pendingPatch }
    _pendingPatch = {}
    if (Object.keys(patch).length === 0) return
    try {
      await apiFetch('/api/preferencias-pos', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
    } catch { /* silencio — preferencia visual, fallback al cache LS */ }
  }, 600)
}

// ─── Public API del hook ─────────────────────────────────────────────────────

export default function usePreferenciasPOS() {
  // Warm-start desde LS o cache module-level si ya estaba poblado.
  const initial = _cache ?? { ...DEFAULTS, ...(_readLS() || {}), loading: _cache ? false : true }
  const [prefs, setPrefs] = useState(initial)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    const sub = (next) => { if (aliveRef.current) setPrefs(next) }
    _subscribers.add(sub)
    _getBroadcast() // arranca el listener cross-tab (lazy)
    // Si todavía no hay cache poblado, dispara el fetch (deduplicado).
    if (!_cache || _cache.loading) {
      _bootstrapFetch().then((next) => { if (aliveRef.current) setPrefs(next) })
    }
    return () => {
      aliveRef.current = false
      _subscribers.delete(sub)
    }
  }, [])

  const actualizar = useCallback((parcial) => {
    const next = { ...(_cache ?? DEFAULTS), ...parcial, loading: false }
    _setCache(next)
    _pendingPatch = { ..._pendingPatch, ...parcial }
    _scheduleFlush()
  }, [])

  const reload = useCallback(async () => {
    _initialFetch = null
    const next = await _bootstrapFetch()
    return next
  }, [])

  return { prefs, actualizar, reload }
}
