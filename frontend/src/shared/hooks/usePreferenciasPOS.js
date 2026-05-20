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

// ─── Telemetría fire-and-forget ──────────────────────────────────────────────
// Reporta fallos silenciosos del hook al endpoint público `/api/telemetry`.
// Diseño:
//   - Cada (type, msg) se envía una sola vez por sesión del navegador. Sin
//     dedupe, un Safari modo privado generaría 4 reportes por minuto (cada
//     instancia del hook + cada operación). El Set in-memory cierra ese loop.
//   - apiFetch retorna una Promise; usamos `.catch(()=>{})` para evitar que
//     un fallo del propio /api/telemetry rompa el flujo del hook (sería loop
//     o crash si el dev server está apagado).
//   - El tipo `type` debe estar en TELEMETRY_TYPES del backend; si no, el
//     endpoint responde 400 (silencioso para el hook).
const _telemetrySent = new Set()
function _telemetry(type, msg) {
  const key = `${type}:${(msg ?? '').slice(0, 80)}`
  if (_telemetrySent.has(key)) return
  _telemetrySent.add(key)
  try {
    apiFetch('/api/telemetry', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type,
        msg:  typeof msg === 'string' ? msg.slice(0, 480) : null,
        href: typeof location !== 'undefined' ? location.href : null,
      }),
    }).catch(() => { /* fire-and-forget */ })
  } catch { /* apiFetch lanzó sync — silencio */ }
}

// ─── Module-level singleton state ────────────────────────────────────────────

let _cache         = null            // último valor conocido (compartido entre instancias)
let _initialFetch  = null            // promise del GET inicial (deduplica concurrentes)
let _broadcast     = null            // BroadcastChannel (lazy)
const _subscribers = new Set()       // setState callbacks de cada instancia montada

function _readLS() {
  try {
    if (typeof localStorage === 'undefined') {
      _telemetry('localstorage_unavailable', 'typeof localStorage === undefined')
      return null
    }
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return { ...DEFAULTS, ...parsed }
  } catch (err) {
    _telemetry('localstorage_unavailable', String(err?.message ?? err).slice(0, 200))
    return null
  }
}

function _writeLS(value) {
  try {
    if (typeof localStorage === 'undefined') {
      _telemetry('localstorage_unavailable', 'typeof localStorage === undefined')
      return
    }
    localStorage.setItem(LS_KEY, JSON.stringify(value))
  } catch (err) {
    // QuotaExceededError es el caso típico (modo incógnito Safari tiene LS de
    // 0 bytes). Otro err: SecurityError en navegadores con privacy mode.
    const code = err?.name === 'QuotaExceededError' ? 'localstorage_quota' : 'localstorage_unavailable'
    _telemetry(code, String(err?.message ?? err).slice(0, 200))
  }
}

function _getBroadcast() {
  if (_broadcast !== null) return _broadcast
  if (typeof BroadcastChannel === 'undefined') {
    _broadcast = false // sentinel: no disponible
    _telemetry('broadcast_channel_unavailable', 'typeof BroadcastChannel === undefined')
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
  } catch (err) {
    _broadcast = false
    _telemetry('broadcast_channel_error', String(err?.message ?? err).slice(0, 200))
    return null
  }
}

function _setCache(next, opts = {}) {
  _cache = next
  if (opts.persistLS !== false) _writeLS(next)
  if (opts.broadcast !== false) {
    const bc = _getBroadcast()
    if (bc) {
      try { bc.postMessage(next) }
      catch (err) { _telemetry('broadcast_channel_error', `postMessage: ${String(err?.message ?? err).slice(0, 160)}`) }
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
      if (!res.ok) throw new Error(`GET preferencias-pos status=${res.status}`)
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
    } catch (err) {
      _telemetry('preferencias_pos_load_fail', String(err?.message ?? err).slice(0, 200))
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
      const res = await apiFetch('/api/preferencias-pos', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
      if (!res.ok) _telemetry('preferencias_pos_persist_fail', `PUT status=${res.status}`)
    } catch (err) {
      _telemetry('preferencias_pos_persist_fail', String(err?.message ?? err).slice(0, 200))
    }
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
