import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, RefreshCw, DollarSign } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useAuth } from '../../contexts/AuthContext'
import {
  FACTURA_ESTADOS,
  TH, PAGE_SIZE,
  formatCurrency, formatDate,
  OtTipoBadge, FacturaEstadoBadge,
} from './_shared'

export default function PanelFacturas() {
  const { tienePermiso }                   = useAuth()
  const canEdit                            = tienePermiso('factura:editar')
  const [facturas,      setFacturas]      = useState([])
  const [loading,       setLoading]       = useState(false)
  const [updating,      setUpdating]      = useState(null)
  const [filtroEstado,  setFiltroEstado]  = useState('')
  const [page,          setPage]          = useState(0)
  const [total,         setTotal]         = useState(0)

  const fetchFacturas = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroEstado) p.set('estado', filtroEstado)
      p.set('limit',  String(PAGE_SIZE))
      p.set('offset', String(page * PAGE_SIZE))
      const r = await apiFetch(`/api/facturas?${p}`)
      if (r.ok) { const j = await r.json(); setFacturas(j.data ?? []); setTotal(j.total ?? 0) }
    } catch {}
    finally { setLoading(false) }
  }, [filtroEstado, page])

  useEffect(() => { setPage(0) }, [filtroEstado])
  useEffect(() => { fetchFacturas() }, [fetchFacturas])

  async function actualizarEstado(f, nuevoEstado) {
    if (nuevoEstado === 'Anulada') {
      if (!window.confirm(`¿Anular la factura ${f.noFactura} (NCF: ${f.ncf})?\nEsta acción es irreversible.`)) return
    }
    setUpdating(f.id)
    try {
      const r = await apiFetch(`/api/facturas/${f.id}/estado`, { method: 'PATCH', body: JSON.stringify({ estado: nuevoEstado }) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error al actualizar.'); return }
      toast.success(`Factura ${nuevoEstado === 'Pagada' ? 'marcada como Pagada' : 'anulada'}.`)
      fetchFacturas()
    } catch { toast.error('Error de conexión.') }
    finally { setUpdating(null) }
  }

  const colSpan = 9 + (canEdit ? 1 : 0)

  const totalEmitidas = facturas
    .filter(f => f.estado === 'Emitida' || f.estado === 'Pagada')
    .reduce((s, f) => s + Number(f.total), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex gap-2 flex-wrap">
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos los estados</option>
            {FACTURA_ESTADOS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <button onClick={fetchFacturas}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {facturas.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/10 border border-emerald-600/20">
            <DollarSign size={13} className="text-emerald-500" />
            <span className="text-sm font-mono font-bold text-emerald-400">{formatCurrency(totalEmitidas)}</span>
            <span className="text-[10px] text-slate-600">emitido / cobrado</span>
          </div>
        )}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className={TH}>No. Factura</th>
                <th className={TH}>NCF</th>
                <th className={TH}>Cliente</th>
                <th className={TH}>Tipo OT</th>
                <th className={TH}>Subtotal</th>
                <th className={TH}>ITBIS</th>
                <th className={TH}>Total</th>
                <th className={TH}>Estado</th>
                <th className={TH}>Emisión</th>
                {canEdit && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={colSpan} className="text-center py-12">
                  <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                </td></tr>
              ) : facturas.length === 0 ? (
                <tr><td colSpan={colSpan} className="text-center py-12 text-slate-500 text-xs font-mono">
                  No hay facturas emitidas aún.
                </td></tr>
              ) : facturas.map(f => (
                <tr key={f.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-slate-300 whitespace-nowrap">{f.noFactura}</td>
                  <td className="px-4 py-3">
                    {f.ncf
                      ? <span className="font-mono text-xs text-blue-300 bg-blue-600/10 border border-blue-600/20 px-2 py-0.5 rounded">{f.ncf}</span>
                      : <span className="text-slate-700 font-mono text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-100 truncate max-w-[160px]">{f.cliente?.razonSocial ?? '—'}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{f.cliente?.noCliente}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {f.orden?.tipoOT
                      ? <OtTipoBadge tipo={f.orden.tipoOT} />
                      : <span className="text-slate-700 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400 whitespace-nowrap">{formatCurrency(f.subtotal)}</td>
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                    {Number(f.itbis) > 0
                      ? <span className="text-amber-400">{formatCurrency(f.itbis)}</span>
                      : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm text-emerald-400 font-bold whitespace-nowrap">{formatCurrency(f.total)}</td>
                  <td className="px-4 py-3 whitespace-nowrap"><FacturaEstadoBadge estado={f.estado} /></td>
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{formatDate(f.fechaEmision)}</td>
                  {canEdit && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {f.estado === 'Emitida' && updating !== f.id && (
                        <div className="flex items-center gap-1.5 justify-end">
                          <button
                            onClick={() => actualizarEstado(f, 'Pagada')}
                            disabled={!!updating}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-semibold transition-all disabled:opacity-40">
                            Pagada
                          </button>
                          <button
                            onClick={() => actualizarEstado(f, 'Anulada')}
                            disabled={!!updating}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600/15 hover:bg-red-600/25 border border-red-600/30 text-red-400 text-xs font-semibold transition-all disabled:opacity-40">
                            Anular
                          </button>
                        </div>
                      )}
                      {updating === f.id && <Loader2 size={14} className="animate-spin text-blue-500 ml-auto" />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-700/50 flex items-center justify-between gap-4">
          <p className="text-xs text-slate-600 font-mono">{total} factura{total !== 1 ? 's' : ''}</p>
          {total > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 disabled:opacity-30 hover:bg-slate-700 transition-colors">
                Anterior
              </button>
              <span className="text-xs text-slate-500 font-mono">
                {page + 1} / {Math.ceil(total / PAGE_SIZE)}
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={(page + 1) * PAGE_SIZE >= total || loading}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 disabled:opacity-30 hover:bg-slate-700 transition-colors">
                Siguiente
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
