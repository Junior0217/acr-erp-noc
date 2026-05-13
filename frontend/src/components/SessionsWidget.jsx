/**
 * SessionsWidget — icono escudo en topbar + dropdown con sesiones activas.
 *
 * Lee /api/auth/me/sessions y permite revocar individuales o todas las otras.
 * Aprovecha la lógica multi-sesión existente (con device fingerprint).
 */
import { useState, useEffect, useRef } from 'react'
import { Shield, Loader2, X, Smartphone, Monitor, Trash2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../utils/api'

function parseUA(ua = '') {
  const lower = ua.toLowerCase()
  let device = 'PC', Icon = Monitor
  if (/iphone|android|mobile/.test(lower)) { device = 'Móvil';  Icon = Smartphone }
  else if (/ipad|tablet/.test(lower))      { device = 'Tablet'; Icon = Smartphone }
  let browser = 'Navegador'
  if (/edg\//.test(lower))      browser = 'Edge'
  else if (/chrome/.test(lower))browser = 'Chrome'
  else if (/firefox/.test(lower)) browser = 'Firefox'
  else if (/safari/.test(lower))browser = 'Safari'
  let os = ''
  if (/windows nt 11/.test(lower)) os = 'Win11'
  else if (/windows nt 10/.test(lower)) os = 'Win10'
  else if (/windows/.test(lower)) os = 'Windows'
  else if (/mac os x/.test(lower)) os = 'macOS'
  else if (/android/.test(lower)) os = 'Android'
  else if (/iphone|ipad|ios/.test(lower)) os = 'iOS'
  else if (/linux/.test(lower)) os = 'Linux'
  return { device, browser, os, Icon }
}

const fmtTime = d => new Date(d).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function SessionsWidget() {
  const [open, setOpen]     = useState(false)
  const [data, setData]     = useState({ data: [], current: null })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy]     = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  async function cargar() {
    setLoading(true)
    try {
      const r = await apiFetch('/api/auth/me/sessions')
      if (r.ok) setData(await r.json())
    } catch {} finally { setLoading(false) }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) cargar()
  }

  async function revocar(jti) {
    if (jti === data.current) { toast.error('No puedes cerrar tu sesión actual desde aquí.'); return }
    setBusy(jti)
    try {
      const r = await apiFetch(`/api/auth/me/sessions/${jti}`, { method: 'DELETE' })
      if (r.status === 204) { toast.success('Sesión cerrada.'); cargar() }
      else toast.error('Error al cerrar.')
    } finally { setBusy(null) }
  }

  async function cerrarTodas() {
    if (!window.confirm('¿Cerrar TODAS las otras sesiones? La actual quedará activa.')) return
    setBusy('bulk')
    try {
      const r = await apiFetch('/api/auth/me/sessions', { method: 'DELETE' })
      if (r.ok) { const j = await r.json(); toast.success(`${j.count} sesiones cerradas.`); cargar() }
      else toast.error('Error.')
    } finally { setBusy(null) }
  }

  const otras = data.data.filter(s => s.jti !== data.current)
  const total = data.data.length

  return (
    <div className="relative" ref={ref}>
      <button onClick={toggle}
        title="Mis sesiones activas"
        className="relative w-9 h-9 rounded-full bg-slate-800 hover:bg-blue-900/30 border border-slate-700 hover:border-blue-700/40 flex items-center justify-center transition-colors">
        <Shield size={15} className={total > 1 ? 'text-amber-400' : 'text-slate-400'} />
        {total > 1 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-600 text-white text-[9px] font-bold flex items-center justify-center ring-2 ring-slate-950">
            {total > 9 ? '9+' : total}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-slate-100">Sesiones activas</p>
              <p className="text-[10px] text-slate-500 font-mono">{total} dispositivo{total !== 1 ? 's' : ''} conectado{total !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-100"><X size={14} /></button>
          </div>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-blue-400" /></div>
          ) : data.data.length === 0 ? (
            <p className="text-xs text-slate-500 px-4 py-6 text-center">No hay sesiones registradas.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-800">
              {data.data.map(s => {
                const ua = parseUA(s.userAgent ?? '')
                const Icon = ua.Icon
                const isCurrent = s.jti === data.current
                return (
                  <div key={s.jti} className={`px-4 py-3 flex items-start gap-3 ${isCurrent ? 'bg-emerald-900/15' : ''}`}>
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isCurrent ? 'bg-emerald-600/15 border border-emerald-600/30 text-emerald-400' : 'bg-slate-800 border border-slate-700 text-slate-400'}`}>
                      <Icon size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-slate-100 truncate">
                        {ua.browser} {ua.os && `· ${ua.os}`} {isCurrent && <span className="ml-1 text-[10px] font-mono text-emerald-400">(ESTA)</span>}
                      </p>
                      <p className="text-[10px] text-slate-500 font-mono">{s.ip ?? '—'} · creada {fmtTime(s.createdAt)}</p>
                      <p className="text-[10px] text-slate-600 font-mono">expira {fmtTime(s.expiresAt)}</p>
                    </div>
                    {!isCurrent && (
                      <button onClick={() => revocar(s.jti)} disabled={busy === s.jti}
                        className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40"
                        title="Cerrar esta sesión">
                        {busy === s.jti ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {otras.length > 0 && (
            <div className="px-4 py-2.5 border-t border-slate-800 bg-slate-900/60">
              <button onClick={cerrarTodas} disabled={busy === 'bulk'}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-900/20 hover:bg-red-900/40 border border-red-700/40 text-red-300 transition-colors disabled:opacity-40">
                {busy === 'bulk' ? <Loader2 size={11} className="animate-spin" /> : <AlertCircle size={11} />}
                Cerrar todas las otras ({otras.length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
