import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { Loader2, RefreshCw, DollarSign, Plus, Trash2, X, Search, Receipt } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useAuth } from '../../contexts/AuthContext'
import {
  FACTURA_ESTADOS,
  TH, PAGE_SIZE,
  formatCurrency, formatDate,
  OtTipoBadge, FacturaEstadoBadge,
} from './_shared'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

// ─── Modal Factura Manual ─────────────────────────────────────────────────────

function ModalFacturaManual({ onClose, onEmitida }) {
  const [busqueda,    setBusqueda]    = useState('')
  const [clientes,    setClientes]    = useState([])
  const [searching,   setSearching]   = useState(false)
  const [clienteSel,  setClienteSel]  = useState(null)   // null = Consumidor Final
  const [showDrop,    setShowDrop]    = useState(false)
  const [applyItbis,  setApplyItbis]  = useState(false)
  const [diasVence,   setDiasVence]   = useState(30)
  const [lineas,      setLineas]      = useState([{ concepto: '', cantidad: 1, precioUnitario: '' }])
  const [emitting,    setEmitting]    = useState(false)
  const dropRef = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    function onMouseDown(e) { if (dropRef.current && !dropRef.current.contains(e.target)) setShowDrop(false) }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // Debounced client search
  useEffect(() => {
    if (!busqueda.trim()) { setClientes([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await apiFetch(`/api/clientes?search=${encodeURIComponent(busqueda)}&activo=true&limit=8`)
        if (r.ok) { const j = await r.json(); setClientes(j.data ?? []) }
      } catch {} finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [busqueda])

  function seleccionarCliente(c) {
    setClienteSel(c)
    setBusqueda(c ? c.razonSocial : '')
    setShowDrop(false)
    setApplyItbis(c ? c.itbis : false)
  }

  function addLinea() {
    setLineas(prev => [...prev, { concepto: '', cantidad: 1, precioUnitario: '' }])
  }

  function removeLinea(i) {
    setLineas(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateLinea(i, field, val) {
    setLineas(prev => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l))
  }

  const subtotal = lineas.reduce((s, l) => s + (parseFloat(l.precioUnitario) || 0) * (parseFloat(l.cantidad) || 0), 0)
  const itbisAmt = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  const total    = subtotal + itbisAmt

  const canEmit = lineas.every(l => l.concepto.trim() && parseFloat(l.cantidad) > 0 && parseFloat(l.precioUnitario) > 0) && lineas.length > 0

  async function emitir() {
    if (!canEmit) return
    setEmitting(true)
    try {
      const body = {
        clienteId: clienteSel?.id ?? undefined,
        itbis:     applyItbis,
        diasVence: parseInt(diasVence) || 30,
        lineas: lineas.map(l => ({
          concepto:       l.concepto.trim(),
          cantidad:       parseFloat(l.cantidad),
          precioUnitario: parseFloat(l.precioUnitario),
        })),
      }
      const r = await apiFetch('/api/facturas/manual', { method: 'POST', body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error al emitir.'); return }
      toast.success(`Factura emitida · NCF ${j.ncf}`)
      onEmitida(j)
    } catch { toast.error('Error de conexión.') }
    finally { setEmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Receipt size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-slate-100">Nueva Factura Manual</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">

          {/* Cliente */}
          <div>
            <label className={LABEL}>Cliente</label>
            <div className="relative" ref={dropRef}>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  className={INPUT + ' pl-8'}
                  placeholder="Buscar cliente… (vacío = Consumidor Final)"
                  value={busqueda}
                  onChange={e => { setBusqueda(e.target.value); setClienteSel(null); setShowDrop(true) }}
                  onFocus={() => setShowDrop(true)}
                  autoComplete="off"
                />
                {searching && <Loader2 size={12} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-500" />}
              </div>
              {showDrop && (busqueda.trim() || clientes.length > 0) && (
                <div className="absolute z-20 w-full mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-2xl overflow-hidden">
                  <button
                    onMouseDown={() => seleccionarCliente(null)}
                    className="w-full text-left px-3 py-2.5 hover:bg-slate-700 transition-colors border-b border-slate-700/50">
                    <span className="text-sm font-medium text-slate-300">Consumidor Final</span>
                    <span className="ml-2 text-[10px] text-slate-600 font-mono">Sin RNC</span>
                  </button>
                  {clientes.map(c => (
                    <button key={c.id} onMouseDown={() => seleccionarCliente(c)}
                      className="w-full text-left px-3 py-2.5 hover:bg-slate-700 transition-colors border-b border-slate-700/30 last:border-0">
                      <div className="text-sm font-medium text-slate-200 truncate">{c.razonSocial}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{c.noCliente} {c.rnc ? `· RNC ${c.rnc}` : ''}</div>
                    </button>
                  ))}
                  {busqueda.trim() && clientes.length === 0 && !searching && (
                    <div className="px-3 py-2.5 text-xs text-slate-600">Sin resultados</div>
                  )}
                </div>
              )}
            </div>
            {clienteSel && (
              <div className="mt-1.5 flex items-center gap-2 text-xs text-blue-300 font-mono bg-blue-600/10 border border-blue-600/20 rounded-lg px-3 py-1.5">
                <span className="font-semibold">{clienteSel.razonSocial}</span>
                <span className="text-slate-600">·</span>
                <span>{clienteSel.noCliente}</span>
                <button onClick={() => seleccionarCliente(null)} className="ml-auto text-slate-500 hover:text-slate-300"><X size={10} /></button>
              </div>
            )}
            {!clienteSel && (
              <p className="mt-1 text-[10px] text-slate-600">Sin cliente seleccionado → se asignará a <span className="text-slate-400 font-mono">Consumidor Final</span></p>
            )}
          </div>

          {/* Líneas */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={LABEL}>Detalle de la Factura</label>
              <button onClick={addLinea}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                <Plus size={12} /> Añadir línea
              </button>
            </div>
            <div className="space-y-2">
              {/* Header */}
              <div className="grid grid-cols-12 gap-2 px-1">
                <div className="col-span-6 text-[10px] font-semibold text-slate-600 uppercase">Concepto</div>
                <div className="col-span-2 text-[10px] font-semibold text-slate-600 uppercase text-center">Cant.</div>
                <div className="col-span-3 text-[10px] font-semibold text-slate-600 uppercase text-right">Precio Unit.</div>
                <div className="col-span-1" />
              </div>
              {lineas.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    className={INPUT + ' col-span-6 text-xs'}
                    placeholder="Ej. Patch Cord Cat6 2m"
                    value={l.concepto}
                    onChange={e => updateLinea(i, 'concepto', e.target.value)}
                  />
                  <input
                    type="number" min="0.01" step="0.01"
                    className={INPUT + ' col-span-2 text-xs text-center'}
                    value={l.cantidad}
                    onChange={e => updateLinea(i, 'cantidad', e.target.value)}
                  />
                  <input
                    type="number" min="0.01" step="0.01"
                    className={INPUT + ' col-span-3 text-xs text-right'}
                    placeholder="0.00"
                    value={l.precioUnitario}
                    onChange={e => updateLinea(i, 'precioUnitario', e.target.value)}
                  />
                  <button
                    onClick={() => removeLinea(i)}
                    disabled={lineas.length === 1}
                    className="col-span-1 flex justify-center text-slate-700 hover:text-red-400 disabled:opacity-30 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Opciones */}
          <div className="flex flex-wrap gap-4 items-center">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={applyItbis} onChange={e => setApplyItbis(e.target.checked)}
                className="w-4 h-4 accent-blue-500 rounded" />
              <span className="text-sm text-slate-300">Aplicar ITBIS <span className="text-slate-500 text-xs">(18%)</span></span>
            </label>
            <div className="flex items-center gap-2">
              <label className={LABEL + ' mb-0'}>Vence en</label>
              <input type="number" min="0" max="365" value={diasVence}
                onChange={e => setDiasVence(e.target.value)}
                className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 text-center focus:outline-none focus:border-blue-500 transition-colors" />
              <span className="text-xs text-slate-500">días</span>
            </div>
          </div>

          {/* Totales */}
          <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-4 space-y-1.5">
            <div className="flex justify-between text-sm text-slate-400">
              <span>Subtotal</span>
              <span className="font-mono">{formatCurrency(subtotal)}</span>
            </div>
            {applyItbis && (
              <div className="flex justify-between text-sm text-amber-400">
                <span>ITBIS (18%)</span>
                <span className="font-mono">{formatCurrency(itbisAmt)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-emerald-400 border-t border-slate-700/50 pt-1.5 mt-1.5">
              <span>Total</span>
              <span className="font-mono">{formatCurrency(total)}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-800 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            Cancelar
          </button>
          <button onClick={emitir} disabled={!canEmit || emitting}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2">
            {emitting && <Loader2 size={14} className="animate-spin" />}
            Emitir Factura
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Panel Principal ──────────────────────────────────────────────────────────

export default function PanelFacturas() {
  const { tienePermiso }                    = useAuth()
  const canEdit                             = tienePermiso('factura:editar')
  const canEmit                             = tienePermiso('factura:emitir')
  const [facturas,      setFacturas]        = useState([])
  const [loading,       setLoading]         = useState(false)
  const [updating,      setUpdating]        = useState(null)
  const [filtroEstado,  setFiltroEstado]    = useState('')
  const [page,          setPage]            = useState(0)
  const [total,         setTotal]           = useState(0)
  const [showManual,    setShowManual]      = useState(false)

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
        <div className="flex gap-2 flex-wrap items-center">
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos los estados</option>
            {FACTURA_ESTADOS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <button onClick={fetchFacturas}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          {canEmit && (
            <button onClick={() => setShowManual(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors">
              <Plus size={14} /> Nueva Factura Manual
            </button>
          )}
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
                <tr><td colSpan={colSpan}>
                  <div className="flex flex-col items-center justify-center py-14 gap-3 text-slate-600">
                    <Receipt size={32} className="opacity-30" />
                    <p className="text-sm">No hay facturas emitidas aún.</p>
                    {canEmit && (
                      <button onClick={() => setShowManual(true)}
                        className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1">
                        <Plus size={12} /> Crear primera factura manual
                      </button>
                    )}
                  </div>
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
                      : <span className="text-slate-700 text-xs font-mono text-[10px]">Manual</span>}
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

      {showManual && (
        <ModalFacturaManual
          onClose={() => setShowManual(false)}
          onEmitida={() => { setShowManual(false); fetchFacturas() }}
        />
      )}
    </div>
  )
}
