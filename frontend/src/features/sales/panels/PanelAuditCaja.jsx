/**
 * PanelAuditCaja — vista owner-only del registro de fraude/anomalías en caja.
 *
 * Lee `/api/auditoria/caja` (backend requiere `sistema:owner`).
 * Filtros: tipo (venta/anulacion/descuento_pin/descuento_rechazado), rango de fecha.
 * Sin acciones destructivas — es read-only forense.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Shield, RefreshCw, Loader2, ShieldAlert, DollarSign,
  Ban, Key, Receipt, Filter, ShieldOff,
} from 'lucide-react'
import { apiFetch } from '@shared/utils/api'
import { useAuth } from '@shared/contexts/AuthContext'

const TIPO_META = {
  venta:               { label: 'Venta',                color: 'emerald', Icon: Receipt    },
  anulacion:           { label: 'Anulación',            color: 'red',     Icon: Ban         },
  descuento_pin:       { label: 'Descuento autorizado', color: 'amber',   Icon: Key         },
  descuento_rechazado: { label: 'PIN rechazado',        color: 'red',     Icon: ShieldAlert },
}
const COLOR_MAP = {
  emerald: 'bg-emerald-600/15 text-emerald-300 border-emerald-600/30',
  red:     'bg-red-600/15 text-red-300 border-red-600/30',
  amber:   'bg-amber-600/15 text-amber-300 border-amber-600/30',
}

const fmtMoney = v => Number(v ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })
const fmtDateTime = d => new Date(d).toLocaleString('es-DO', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

export default function PanelAuditCaja() {
  const { tienePermiso } = useAuth()
  const canSee = tienePermiso('sistema:owner')
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(false)
  const [tipo, setTipo]       = useState('')
  const [busqueda, setBusqueda] = useState('')

  const fetch_ = useCallback(async () => {
    if (!canSee) return
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (tipo) p.set('tipo', tipo)
      p.set('limit', '200')
      const r = await apiFetch(`/api/auditoria/caja?${p}`)
      if (!r.ok) return
      const j = await r.json()
      setRows(j.data ?? [])
    } catch {} finally { setLoading(false) }
  }, [canSee, tipo])

  useEffect(() => { fetch_() }, [fetch_])

  const filtered = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      (r.detalle ?? '').toLowerCase().includes(q) ||
      (r.facturaId ?? '').toLowerCase().includes(q)
    )
  }, [rows, busqueda])

  const stats = useMemo(() => {
    const out = { venta: 0, anulacion: 0, descuento_pin: 0, descuento_rechazado: 0 }
    for (const r of rows) out[r.tipo] = (out[r.tipo] ?? 0) + 1
    return out
  }, [rows])

  if (!canSee) return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-slate-500">
      <ShieldOff size={36} />
      <p className="text-sm font-medium">Acceso restringido</p>
      <p className="text-xs text-slate-600">Esta vista es exclusiva del rol Propietario (<code>sistema:owner</code>).</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-red-400" />
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">Auditoría de Caja</h2>
          <span className="px-2 py-0.5 rounded-full bg-red-600/15 border border-red-600/30 text-red-300 text-[10px] font-bold uppercase tracking-wider">Owner only</span>
        </div>
        <button onClick={fetch_} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {Object.entries(TIPO_META).map(([key, m]) => {
          const Icon = m.Icon
          const count = stats[key] ?? 0
          return (
            <button key={key} onClick={() => setTipo(tipo === key ? '' : key)}
              className={`p-3 rounded-xl border text-left transition-all ${tipo === key ? COLOR_MAP[m.color] + ' ring-2 ring-blue-500/40' : `${COLOR_MAP[m.color]} opacity-70 hover:opacity-100`}`}>
              <div className="flex items-center justify-between mb-1">
                <Icon size={14} />
                <span className="text-xl font-bold font-mono">{count}</span>
              </div>
              <p className="text-[10px] font-semibold uppercase tracking-wider">{m.label}</p>
            </button>
          )
        })}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-3 flex items-center gap-2">
        <Filter size={13} className="text-slate-500" />
        <input value={busqueda} onChange={e => setBusqueda(e.target.value)}
          placeholder="Buscar en detalle / factura ID…"
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
        {tipo && (
          <button onClick={() => setTipo('')} className="text-[10px] text-slate-400 hover:text-red-300 transition-colors">
            Limpiar filtro tipo
          </button>
        )}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className="text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap">Fecha/Hora</th>
                <th className="text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap">Tipo</th>
                <th className="text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">Empleado</th>
                <th className="text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider">Detalle</th>
                <th className="text-right px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap">Monto</th>
                <th className="text-right px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap">Desc %</th>
                <th className="text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={7} className="text-center py-12">
                  <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-slate-500 text-xs font-mono">
                  Sin registros que coincidan.
                </td></tr>
              ) : filtered.map(r => {
                const m = TIPO_META[r.tipo] ?? { label: r.tipo, color: 'amber', Icon: ShieldAlert }
                const Icon = m.Icon
                return (
                  <tr key={r.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-4 py-3 text-xs text-slate-400 font-mono whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border ${COLOR_MAP[m.color]}`}>
                        <Icon size={10} />{m.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300 font-mono whitespace-nowrap">#{r.empleadoId ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-200">{r.detalle ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-xs font-mono whitespace-nowrap">
                      {r.monto != null ? <span className="text-emerald-400 font-bold"><DollarSign size={11} className="inline -mt-1" />{fmtMoney(r.monto)}</span> : <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-mono whitespace-nowrap">
                      {r.descPct != null
                        ? <span className={Number(r.descPct) > 15 ? 'text-amber-400 font-bold' : 'text-slate-400'}>{Number(r.descPct).toFixed(1)}%</span>
                        : <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[10px] text-slate-500 font-mono whitespace-nowrap">{r.ip ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-700/50">
          <p className="text-xs text-slate-600 font-mono">{filtered.length} registros · solo lectura · datos íntegros</p>
        </div>
      </div>
    </div>
  )
}
