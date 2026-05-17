import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Loader2, RefreshCw, DollarSign, Plus, Trash2, X,
  Search, Receipt, Printer, FileText, Download, FileArchive,
  CheckSquare, Square, Eye, User, Hash, Calendar, Edit3, Save,
  Ban, ShieldAlert, Lock,
} from 'lucide-react'
import { apiFetch } from '@shared/utils/api'
import { fetchPdfBlob, descargarBulkZip } from '@shared/utils/pdf'
import { useAuth } from '@shared/contexts/AuthContext'
import PdfPreviewDrawer from '@shared/components/PdfPreviewDrawer'
import {
  FACTURA_ESTADOS,
  TH, PAGE_SIZE,
  formatCurrency, formatDate,
  OtTipoBadge, FacturaEstadoBadge,
} from './_shared'

const FACTURA_ESTADOS_REALES = FACTURA_ESTADOS.filter(e => e !== 'Borrador')

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

// ─── Product selector row ─────────────────────────────────────────────────────

function LineaRow({ linea, onUpdate, onRemove, canRemove }) {
  const [busqueda,   setBusqueda]   = useState(linea.producto?.nombre ?? '')
  const [resultados, setResultados] = useState([])
  const [showDrop,   setShowDrop]   = useState(false)
  const [searching,  setSearching]  = useState(false)
  const dropRef = useRef(null)

  useEffect(() => {
    function handler(e) { if (dropRef.current && !dropRef.current.contains(e.target)) setShowDrop(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!busqueda.trim() || linea.producto) return
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await apiFetch(`/api/productos?search=${encodeURIComponent(busqueda)}&limit=8`)
        if (r.ok) { const j = await r.json(); setResultados(j.data ?? []) }
      } catch {} finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [busqueda, linea.producto])

  function seleccionar(p) {
    setBusqueda(p.nombre)
    setShowDrop(false)
    setResultados([])
    onUpdate({ producto: p, precioOverride: '' })
  }

  function limpiar() {
    setBusqueda('')
    setResultados([])
    onUpdate({ producto: null, precioOverride: '' })
  }

  const precioFinal = linea.precioOverride !== '' ? parseFloat(linea.precioOverride) || 0 : (linea.producto ? Number(linea.producto.precio) : 0)
  const subtlinea   = precioFinal * (parseInt(linea.cantidad) || 0)

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-12 gap-2 items-start">
        {/* Product combobox */}
        <div className="col-span-5 relative" ref={dropRef}>
          <div className="relative">
            <input
              className={INPUT + ' text-xs pr-7'}
              placeholder="Buscar producto…"
              value={busqueda}
              onChange={e => { setBusqueda(e.target.value); setShowDrop(true); if (linea.producto) onUpdate({ producto: null }) }}
              onFocus={() => { if (!linea.producto) setShowDrop(true) }}
              autoComplete="off"
            />
            {linea.producto
              ? <button onClick={limpiar} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-red-400 transition-colors"><X size={12} /></button>
              : searching
                ? <Loader2 size={12} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-slate-500" />
                : <Search size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />}
          </div>
          {showDrop && resultados.length > 0 && (
            <div className="absolute z-30 w-full mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-2xl overflow-hidden max-h-52 overflow-y-auto">
              {resultados.map(p => (
                <button key={p.id} onMouseDown={() => seleccionar(p)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-700 transition-colors border-b border-slate-700/30 last:border-0">
                  <div className="text-xs font-medium text-slate-200 truncate">{p.nombre}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-slate-500 font-mono">{p.sku}</span>
                    <span className={`text-[10px] font-semibold font-mono ${p.stockActual > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.stockActual > 0 ? `Stk: ${p.stockActual}` : 'Sin stock'}
                    </span>
                    <span className="text-[10px] text-blue-300 font-mono ml-auto">{formatCurrency(p.precio)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Qty */}
        <input
          type="number" min="1" step="1"
          className={INPUT + ' col-span-2 text-xs text-center'}
          value={linea.cantidad}
          onChange={e => onUpdate({ cantidad: e.target.value })}
        />

        {/* Price override */}
        <input
          type="number" min="0.01" step="0.01"
          className={INPUT + ' col-span-3 text-xs text-right'}
          placeholder={linea.producto ? String(Number(linea.producto.precio).toFixed(2)) : '0.00'}
          value={linea.precioOverride}
          onChange={e => onUpdate({ precioOverride: e.target.value })}
        />

        {/* Subtotal + remove */}
        <div className="col-span-2 flex items-center justify-end gap-1.5 pt-1.5">
          <span className="text-[11px] font-mono text-slate-300 shrink-0">{formatCurrency(subtlinea)}</span>
          <button onClick={onRemove} disabled={!canRemove}
            className="text-slate-700 hover:text-red-400 disabled:opacity-30 transition-colors shrink-0">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Stock badge */}
      {linea.producto && (
        <div className="ml-1 flex items-center gap-2">
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${linea.producto.stockActual > 0 ? 'bg-emerald-600/10 text-emerald-400 border-emerald-600/20' : 'bg-red-600/10 text-red-400 border-red-600/20'}`}>
            Stock disponible: {linea.producto.stockActual}
          </span>
          {linea.producto.stockActual === 0 && (
            <span className="text-[10px] text-amber-400">⚠ Sin stock — no se podrá emitir factura</span>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Modal POS / Factura Manual ───────────────────────────────────────────────

function ModalFacturaManual({ onClose, onSuccess }) {
  const [busqueda,   setBusqueda]   = useState('')
  const [clientes,   setClientes]   = useState([])
  const [searching,  setSearching]  = useState(false)
  const [clienteSel, setClienteSel] = useState(null)
  const [showDrop,   setShowDrop]   = useState(false)
  const [applyItbis, setApplyItbis] = useState(false)
  const [diasVence,  setDiasVence]  = useState(30)
  const [lineas,     setLineas]     = useState([{ producto: null, cantidad: 1, precioOverride: '' }])
  const [submitting, setSubmitting] = useState(null)
  const dropRef = useRef(null)

  useEffect(() => {
    function handler(e) { if (dropRef.current && !dropRef.current.contains(e.target)) setShowDrop(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

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

  function addLinea()        { setLineas(p => [...p, { producto: null, cantidad: 1, precioOverride: '' }]) }
  function removeLinea(i)    { setLineas(p => p.filter((_, idx) => idx !== i)) }
  function updateLinea(i, u) { setLineas(p => p.map((l, idx) => idx === i ? { ...l, ...u } : l)) }

  const totales = (Array.isArray(lineas) ? lineas : []).reduce((acc, l) => {
    const pu  = l.precioOverride !== '' ? parseFloat(l.precioOverride) || 0 : (l.producto ? Number(l.producto.precio) : 0)
    const sub = pu * (parseInt(l.cantidad) || 0)
    acc.subtotal += sub
    return acc
  }, { subtotal: 0 })
  const itbisAmt = applyItbis ? Math.round(totales.subtotal * 0.18 * 100) / 100 : 0
  const total    = Math.round((totales.subtotal + itbisAmt) * 100) / 100

  const canSubmit = lineas.length > 0 && lineas.every(l => l.producto !== null && parseInt(l.cantidad) > 0)

  async function submit(esCotizacion) {
    if (!canSubmit) return
    setSubmitting(esCotizacion ? 'cotizacion' : 'factura')
    try {
      const body = {
        clienteId:    clienteSel?.id ?? undefined,
        itbis:        applyItbis,
        diasVence:    parseInt(diasVence) || 30,
        esCotizacion,
        lineas: (Array.isArray(lineas) ? lineas : []).map(l => ({
          productoId: l.producto.id,
          cantidad:   parseInt(l.cantidad),
          ...(l.precioOverride !== '' ? { precioUnitario: parseFloat(l.precioOverride) } : {}),
        })),
      }
      const r = await apiFetch('/api/ventas/facturas/manual', { method: 'POST', body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error.'); return }
      toast.success(esCotizacion ? `Cotización guardada · ${j.noFactura}` : `Factura emitida · NCF ${j.ncf}`)
      onSuccess(j)
    } catch { toast.error('Error de conexión.') }
    finally { setSubmitting(null) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl flex flex-col max-h-[92vh]">

        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Receipt size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-slate-100">Punto de Venta — Nueva Factura</h2>
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
                  <button onMouseDown={() => seleccionarCliente(null)}
                    className="w-full text-left px-3 py-2.5 hover:bg-slate-700 transition-colors border-b border-slate-700/50">
                    <span className="text-sm font-medium text-slate-300">Consumidor Final</span>
                    <span className="ml-2 text-[10px] text-slate-600 font-mono">Sin RNC · B02</span>
                  </button>
                  {clientes.map(c => (
                    <button key={c.id} onMouseDown={() => seleccionarCliente(c)}
                      className="w-full text-left px-3 py-2.5 hover:bg-slate-700 transition-colors border-b border-slate-700/30 last:border-0">
                      <div className="text-sm font-medium text-slate-200 truncate">{c.razonSocial}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        {c.noCliente}
                        {c.rnc ? ` · RNC ${c.rnc}` : ''}
                        {' · '}
                        <span className={['PYME','Empresa'].includes(c.tipoEmpresa) ? 'text-amber-400' : 'text-slate-600'}>
                          {['PYME','Empresa'].includes(c.tipoEmpresa) ? 'NCF Fiscal (B01)' : 'Consumidor Final (B02)'}
                        </span>
                      </div>
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
                <span className="font-semibold truncate">{clienteSel.razonSocial}</span>
                <span className="text-slate-600">·</span>
                <span>{clienteSel.noCliente}</span>
                {clienteSel.rnc && <><span className="text-slate-600">·</span><span>RNC {clienteSel.rnc}</span></>}
                <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${['PYME','Empresa'].includes(clienteSel.tipoEmpresa) ? 'bg-amber-600/10 border-amber-600/30 text-amber-400' : 'bg-slate-700/50 border-slate-600/30 text-slate-500'}`}>
                  {['PYME','Empresa'].includes(clienteSel.tipoEmpresa) ? 'NCF Fiscal B01' : 'B02'}
                </span>
                <button onClick={() => seleccionarCliente(null)} className="ml-auto text-slate-500 hover:text-slate-300"><X size={10} /></button>
              </div>
            )}
            {!clienteSel && <p className="mt-1 text-[10px] text-slate-600">Sin cliente → <span className="text-slate-400 font-mono">Consumidor Final</span> · NCF B02</p>}
          </div>

          {/* Líneas de productos */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={LABEL}>Productos</label>
              <button onClick={addLinea}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors">
                <Plus size={12} /> Añadir línea
              </button>
            </div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-1.5">
              <div className="col-span-5 text-[10px] font-semibold text-slate-600 uppercase">Producto</div>
              <div className="col-span-2 text-[10px] font-semibold text-slate-600 uppercase text-center">Cant.</div>
              <div className="col-span-3 text-[10px] font-semibold text-slate-600 uppercase text-right">Precio Unit.</div>
              <div className="col-span-2 text-[10px] font-semibold text-slate-600 uppercase text-right pr-5">Subtotal</div>
            </div>
            <div className="space-y-3">
              {(Array.isArray(lineas) ? lineas : []).map((l, i) => (
                <LineaRow key={i} linea={l}
                  onUpdate={u => updateLinea(i, u)}
                  onRemove={() => removeLinea(i)}
                  canRemove={lineas.length > 1}
                />
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
              <span className="font-mono">{formatCurrency(totales.subtotal)}</span>
            </div>
            {applyItbis && (
              <div className="flex justify-between text-sm text-amber-400">
                <span>ITBIS (18%)</span>
                <span className="font-mono">{formatCurrency(itbisAmt)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-emerald-400 border-t border-slate-700/50 pt-1.5 mt-1.5">
              <span>Total RD$</span>
              <span className="font-mono">{formatCurrency(total)}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-800 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            Cancelar
          </button>
          <button onClick={() => submit(true)} disabled={!canSubmit || !!submitting}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-amber-600/20 hover:bg-amber-600/30 border border-amber-600/40 text-amber-300 transition-colors disabled:opacity-40">
            {submitting === 'cotizacion' && <Loader2 size={13} className="animate-spin" />}
            <FileText size={13} /> Guardar Cotización
          </button>
          <button onClick={() => submit(false)} disabled={!canSubmit || !!submitting}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50">
            {submitting === 'factura' && <Loader2 size={13} className="animate-spin" />}
            <Receipt size={13} /> Emitir Factura
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Panel Principal ──────────────────────────────────────────────────────────

export default function PanelFacturas({ highlightId = null }) {
  const { tienePermiso }                          = useAuth()
  const canEdit                                   = tienePermiso('factura:editar')
  const canEmit                                   = tienePermiso('factura:emitir')
  const isOwner                                   = tienePermiso('sistema:owner')
  const [facturas,      setFacturas]              = useState([])
  const [loading,       setLoading]               = useState(false)
  const [updating,      setUpdating]              = useState(null)
  const [filtroEstado,  setFiltroEstado]          = useState('')
  const [filtroNumero,  setFiltroNumero]          = useState('')
  const [filtroCliente, setFiltroCliente]         = useState('')
  const [filtroCodigo,  setFiltroCodigo]          = useState('')
  const [filtroDesde,   setFiltroDesde]           = useState('')
  const [filtroHasta,   setFiltroHasta]           = useState('')
  const [page,          setPage]                  = useState(0)
  const [total,         setTotal]                 = useState(0)
  const [showManual,    setShowManual]             = useState(false)
  const [downloadingId, setDownloadingId]          = useState(null)
  // PDF Drawer
  const [drawer, setDrawer] = useState({ open: false, blob: null, blobUrl: null, filename: null, title: null, subtitle: null, loading: false })
  // Bulk selection
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  // Details modal (slide-over)
  const [detailFactura, setDetailFactura] = useState(null)

  const fetchFacturas = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroEstado)  p.set('estado',        filtroEstado)
      if (filtroNumero)  p.set('search',        filtroNumero.trim())
      if (filtroCliente) p.set('clienteNombre', filtroCliente.trim())
      if (filtroCodigo)  p.set('clienteCodigo', filtroCodigo.trim())
      if (filtroDesde)   p.set('desde',         filtroDesde)
      if (filtroHasta)   p.set('hasta',         filtroHasta)
      p.set('limit',  String(PAGE_SIZE))
      p.set('offset', String(page * PAGE_SIZE))
      const r = await apiFetch(`/api/ventas/facturas?${p}`)
      if (r.ok) { const j = await r.json(); setFacturas(j.data ?? []); setTotal(j.total ?? 0) }
    } catch {} finally { setLoading(false) }
  }, [filtroEstado, filtroNumero, filtroCliente, filtroCodigo, filtroDesde, filtroHasta, page])

  useEffect(() => { setPage(0) }, [filtroEstado, filtroNumero, filtroCliente, filtroCodigo, filtroDesde, filtroHasta])
  useEffect(() => {
    const t = setTimeout(() => fetchFacturas(), 250)
    return () => clearTimeout(t)
  }, [fetchFacturas])

  function limpiarFiltros() {
    setFiltroEstado(''); setFiltroNumero(''); setFiltroCliente('')
    setFiltroCodigo(''); setFiltroDesde(''); setFiltroHasta('')
  }
  const hayFiltros = !!(filtroEstado || filtroNumero || filtroCliente || filtroCodigo || filtroDesde || filtroHasta)

  async function actualizarEstado(f, nuevoEstado) {
    // Confirmaciones estrictas: ambos cambios afectan contabilidad + DGII.
    if (nuevoEstado === 'Anulada') {
      const conf = window.prompt(
        `⚠️ ANULACIÓN IRREVERSIBLE\n\nFactura: ${f.noFactura}\nNCF: ${f.ncf ?? '—'}\nMonto: RD$${Number(f.total).toFixed(2)}\n\nEscribe "ANULAR" para confirmar:`
      )
      if (conf !== 'ANULAR') { toast.info('Anulación cancelada.'); return }
    } else if (nuevoEstado === 'Pagada') {
      if (!window.confirm(
        `Confirmar pago de la factura ${f.noFactura}\nMonto: RD$${Number(f.total).toFixed(2)}\n\nUna vez marcada como Pagada, solo el Propietario Absoluto puede revertirla. ¿Continuar?`
      )) return
    }
    setUpdating(f.id)
    try {
      const r = await apiFetch(`/api/ventas/facturas/${f.id}/estado`, { method: 'PATCH', body: JSON.stringify({ estado: nuevoEstado }) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error al actualizar.'); return }
      toast.success(`Factura ${nuevoEstado === 'Pagada' ? 'marcada como Pagada' : 'anulada'}.`)
      fetchFacturas()
    } catch { toast.error('Error de conexión.') }
    finally { setUpdating(null) }
  }

  // Reversión god mode: solo sistema:owner ve el botón. Restaura stock si Pagada.
  async function revertirFactura(f) {
    const motivo = window.prompt(
      `🛡️ REVERSIÓN GOD MODE\n\nFactura: ${f.noFactura}\nEstado actual: ${f.estado}\n\nEsto volverá la factura a Borrador. ${f.estado === 'Pagada' ? 'El stock se restaurará automáticamente.' : ''}\n\nMotivo (mínimo 10 caracteres):`
    )
    if (!motivo || motivo.trim().length < 10) { toast.info('Motivo requerido (mínimo 10 caracteres).'); return }
    setUpdating(f.id)
    try {
      const r = await apiFetch(`/api/facturas/${f.id}/revertir`, { method: 'POST', body: JSON.stringify({ motivo: motivo.trim() }) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error al revertir.'); return }
      toast.success(`Factura revertida a Borrador. Stock restaurado: ${j.stockRestaurado ?? 0}.`)
      fetchFacturas()
    } catch { toast.error('Error de conexión.') }
    finally { setUpdating(null) }
  }

  // Abre el PDF en el drawer (iframe) en lugar de pestaña nueva.
  async function previewPDF(f) {
    if (downloadingId) return
    setDownloadingId(f.id)
    const filename = `${f.esCotizacion ? 'cotizacion' : 'factura'}-${f.noFactura}.pdf`
    const endpoint = f.esCotizacion
      ? `/api/ventas/cotizaciones/${f.id}/pdf`
      : `/api/ventas/facturas/${f.id}/pdf`
    cerrarDrawer() // limpia uno previo
    setDrawer({ open: true, blob: null, blobUrl: null, filename,
      title: `${f.esCotizacion ? 'Cotización' : 'Factura'} · ${f.noFactura}`,
      subtitle: f.cliente?.razonSocial ?? 'Consumidor Final', loading: true })
    const result = await fetchPdfBlob(endpoint, filename)
    setDownloadingId(null)
    if (!result) { setDrawer(d => ({ ...d, open: false, loading: false })); return }
    setDrawer(d => ({ ...d, blob: result.blob, blobUrl: result.blobUrl, loading: false }))
  }
  function cerrarDrawer() {
    setDrawer(d => {
      if (d.blobUrl) URL.revokeObjectURL(d.blobUrl)
      return { open: false, blob: null, blobUrl: null, filename: null, title: null, subtitle: null, loading: false }
    })
  }

  // Selección múltiple para export ZIP
  function toggleSel(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const visibleIds = useMemo(() => facturas.map(f => f.id), [facturas])
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id))
  function toggleAll() {
    setSelected(prev => {
      if (allSelected) { const n = new Set(prev); visibleIds.forEach(id => n.delete(id)); return n }
      const n = new Set(prev); visibleIds.forEach(id => n.add(id)); return n
    })
  }
  async function exportSelectedZip() {
    if (selected.size === 0) return
    if (selected.size > 50) { toast.error('Máximo 50 facturas por ZIP.'); return }
    setBulkBusy(true)
    const ok = await descargarBulkZip([...selected], 'factura')
    setBulkBusy(false)
    if (ok) setSelected(new Set())
  }
  function limpiarSeleccion() { setSelected(new Set()) }

  const colSpan = 11 + (canEdit ? 1 : 0)

  const totalEmitidas = facturas
    .filter(f => f.estado === 'Emitida' || f.estado === 'Pagada')
    .reduce((s, f) => s + Number(f.total), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2">
          <Receipt size={16} className="text-blue-400" />
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">Facturas Emitidas</h2>
        </div>
        <div className="flex items-center gap-2">
          {facturas.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/10 border border-emerald-600/20">
              <DollarSign size={13} className="text-emerald-500" />
              <span className="text-sm font-mono font-bold text-emerald-400">{formatCurrency(totalEmitidas)}</span>
              <span className="text-[10px] text-slate-600">emitido / cobrado</span>
            </div>
          )}
          {canEmit && (
            <button onClick={() => setShowManual(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors shadow-lg shadow-blue-600/20">
              <Plus size={14} /> Nueva Factura / POS
            </button>
          )}
        </div>
      </div>

      <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-2">
          <div className="lg:col-span-2 relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input value={filtroNumero} onChange={e => setFiltroNumero(e.target.value)}
              placeholder="No. Factura / NCF…"
              className="w-full pl-8 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          <input value={filtroCliente} onChange={e => setFiltroCliente(e.target.value)}
            placeholder="Cliente (nombre / razón social)…"
            className="lg:col-span-2 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
          <input value={filtroCodigo} onChange={e => setFiltroCodigo(e.target.value)}
            placeholder="Código cliente…"
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos los estados</option>
            {FACTURA_ESTADOS_REALES.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-end gap-2 mt-2">
          <div>
            <label className="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">Emisión desde</label>
            <input type="date" value={filtroDesde} onChange={e => setFiltroDesde(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">Hasta</label>
            <input type="date" value={filtroHasta} onChange={e => setFiltroHasta(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          {hayFiltros && (
            <button onClick={limpiarFiltros}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/60 border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-700/40 transition-all">
              <X size={11} /> Limpiar filtros
            </button>
          )}
          <button onClick={fetchFacturas}
            className="ml-auto p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className="px-3 py-3 w-10">
                  <button onClick={toggleAll} title={allSelected ? 'Quitar selección' : 'Seleccionar visibles'}
                    className="text-slate-500 hover:text-blue-400 transition-colors">
                    {allSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                  </button>
                </th>
                <th className={TH}>No. Factura</th>
                <th className={TH}>NCF</th>
                <th className={TH}>Cliente</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Subtotal</th>
                <th className={TH}>ITBIS</th>
                <th className={TH}>Total</th>
                <th className={TH}>Estado</th>
                <th className={TH}>Emisión</th>
                <th className="px-4 py-3" />
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
                <tr key={f.id} onClick={() => setDetailFactura(f)}
                  className={`hover:bg-slate-800/50 transition-colors cursor-pointer ${selected.has(f.id) ? 'bg-blue-900/15' : ''} ${f.id === highlightId ? 'ring-1 ring-inset ring-emerald-500/40 bg-emerald-900/10' : ''}`}>
                  <td className="px-3 py-3" onClick={e => { e.stopPropagation(); toggleSel(f.id) }}>
                    <button className="text-slate-500 hover:text-blue-400 transition-colors">
                      {selected.has(f.id) ? <CheckSquare size={15} className="text-blue-400" /> : <Square size={15} />}
                    </button>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-mono font-bold border bg-blue-600/15 text-blue-300 border-blue-600/40 tracking-wide shadow-sm shadow-blue-600/10">
                      {f.noFactura}
                    </span>
                  </td>
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
                    {f.esCotizacion
                      ? <span className="text-[10px] font-semibold font-mono px-1.5 py-0.5 rounded border bg-amber-600/10 border-amber-600/20 text-amber-400">Cotización</span>
                      : f.orden?.tipoOT
                        ? <OtTipoBadge tipo={f.orden.tipoOT} />
                        : <span className="text-slate-600 text-[10px] font-mono">Manual</span>}
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
                  {/* PDF preview button */}
                  <td className="px-2 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setDetailFactura(f)}
                        title="Ver detalle"
                        className="p-1.5 rounded-lg text-slate-600 hover:text-amber-400 hover:bg-amber-600/10 transition-colors">
                        <Eye size={14} />
                      </button>
                      <button onClick={() => previewPDF(f)} disabled={downloadingId === f.id}
                        title="Previsualizar PDF"
                        className="p-1.5 rounded-lg text-slate-600 hover:text-blue-400 hover:bg-blue-600/10 transition-colors disabled:opacity-40">
                        {downloadingId === f.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Printer size={14} />}
                      </button>
                    </div>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      {f.estado === 'Emitida' && updating !== f.id && (
                        <div className="flex items-center gap-1.5 justify-end">
                          <button onClick={() => actualizarEstado(f, 'Pagada')} disabled={!!updating}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-semibold transition-all disabled:opacity-40">
                            Pagada
                          </button>
                          <button onClick={() => actualizarEstado(f, 'Anulada')} disabled={!!updating}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600/15 hover:bg-red-600/25 border border-red-600/30 text-red-400 text-xs font-semibold transition-all disabled:opacity-40">
                            Anular
                          </button>
                        </div>
                      )}
                      {/* God Mode: revertir factura Pagada/Anulada (solo sistema:owner) */}
                      {isOwner && (f.estado === 'Pagada' || f.estado === 'Anulada') && updating !== f.id && (
                        <button onClick={() => revertirFactura(f)} disabled={!!updating}
                          title="Revertir a Borrador (God Mode)"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600/15 hover:bg-amber-600/25 border border-amber-600/30 text-amber-400 text-xs font-semibold transition-all disabled:opacity-40">
                          ↺ Revertir
                        </button>
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
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0 || loading}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 disabled:opacity-30 hover:bg-slate-700 transition-colors">
                Anterior
              </button>
              <span className="text-xs text-slate-500 font-mono">{page + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
              <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= total || loading}
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
          onSuccess={f => { setShowManual(false); fetchFacturas(); if (f?.id) previewPDF(f) }}
        />
      )}

      {/* Bulk action bar — fixed bottom, slide-in when selected.size > 0 */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-2xl shadow-2xl shadow-blue-600/20 px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-600/15 border border-blue-600/30">
            <CheckSquare size={13} className="text-blue-400" />
            <span className="text-xs font-bold text-blue-300 font-mono">{selected.size}</span>
            <span className="text-[10px] text-slate-400">seleccionada{selected.size !== 1 ? 's' : ''}</span>
          </div>
          <span className="text-[10px] text-slate-600">máx 50 por exportación</span>
          <button onClick={limpiarSeleccion}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            Limpiar
          </button>
          <button onClick={exportSelectedZip} disabled={bulkBusy || selected.size > 50}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40 shadow-md shadow-blue-600/30">
            {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <FileArchive size={12} />}
            Descargar ZIP ({selected.size})
          </button>
        </div>
      )}

      {/* PDF Preview Drawer */}
      <PdfPreviewDrawer
        open={drawer.open}
        blob={drawer.blob}
        blobUrl={drawer.blobUrl}
        filename={drawer.filename}
        title={drawer.title}
        subtitle={drawer.subtitle}
        loading={drawer.loading}
        onClose={cerrarDrawer}
      />

      {/* Details modal (slide-over) */}
      {detailFactura && (
        <FacturaDetailsModal
          factura={detailFactura}
          onClose={() => setDetailFactura(null)}
          onActualizarEstado={actualizarEstado}
          updating={updating}
          canEdit={canEdit}
          onPreviewPDF={previewPDF}
          downloadingId={downloadingId}
          onCondicionesGuardadas={() => fetchFacturas()}
          onNotaCreditoEmitida={(nc) => { fetchFacturas(); if (nc?.id) previewPDF(nc) }}
        />
      )}
    </div>
  )
}

// ─── FacturaDetailsModal: slide-over con detalle + edición de condiciones ────

function FacturaDetailsModal({ factura, onClose, onActualizarEstado, updating, canEdit, onPreviewPDF, downloadingId, onCondicionesGuardadas, onNotaCreditoEmitida }) {
  const [full, setFull] = useState(null)
  const [loading, setLoading] = useState(true)
  // NC modal: visible cuando el usuario presiona "Anular con Nota de Crédito"
  const [ncOpen, setNcOpen] = useState(false)
  // Edición de condiciones comerciales (override del default empresa).
  // Shape interno: { k: { incluir: bool, texto: string } }. Soporta lectura legacy (string).
  const [editCond, setEditCond] = useState(false)
  const [cond, setCond] = useState({
    validez:  { incluir: false, texto: '' },
    pago:     { incluir: false, texto: '' },
    entrega:  { incluir: false, texto: '' },
    garantia: { incluir: false, texto: '' },
  })
  const [savingCond, setSavingCond] = useState(false)

  // Normaliza el shape al cargar: legacy string -> { incluir: true, texto }.
  function normCond(v) {
    if (v == null) return { incluir: false, texto: '' }
    if (typeof v === 'string') return { incluir: !!v.trim(), texto: v }
    return { incluir: !!v.incluir, texto: String(v.texto ?? '') }
  }

  useEffect(() => {
    let cancel = false
    setLoading(true)
    apiFetch(`/api/ventas/facturas/${factura.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (cancel) return; setFull(j); setCond({
        validez:  normCond(j?.condiciones?.validez),
        pago:     normCond(j?.condiciones?.pago),
        entrega:  normCond(j?.condiciones?.entrega),
        garantia: normCond(j?.condiciones?.garantia),
      }) })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [factura.id])

  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  async function guardarCondiciones() {
    setSavingCond(true)
    try {
      const r = await apiFetch(`/api/facturas/${factura.id}/condiciones`, { method: 'PATCH', body: JSON.stringify(cond) })
      if (!r.ok) { const j = await r.json().catch(() => ({})); toast.error(j.error ?? 'Error.'); return }
      toast.success('Condiciones guardadas. Regenera el PDF para verlas.')
      setEditCond(false)
      onCondicionesGuardadas?.()
    } finally { setSavingCond(false) }
  }

  const cli = full?.cliente ?? factura.cliente ?? {}
  const lineas = full?.lineas ?? []
  const esCot = factura.esCotizacion

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full sm:w-[560px] bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl">

        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/80 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${esCot ? 'bg-amber-600/15 border border-amber-600/30' : 'bg-blue-600/15 border border-blue-600/30'}`}>
              <Receipt size={16} className={esCot ? 'text-amber-400' : 'text-blue-400'} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-100 truncate">{esCot ? 'Cotización' : 'Factura'} · {factura.noFactura}</p>
              <p className="text-[11px] text-slate-500 font-mono truncate">{factura.ncf ?? '— sin NCF'}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-500 gap-2">
              <Loader2 size={18} className="animate-spin" /><span className="text-sm">Cargando detalle…</span>
            </div>
          ) : (
            <>
              {/* Cliente */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <User size={13} className="text-blue-400" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400">Cliente</p>
                </div>
                <p className="text-sm font-bold text-slate-100">{cli.razonSocial ?? 'Consumidor Final'}</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {cli.noCliente && <div><span className="text-slate-600 font-mono">Cód.</span> <span className="text-slate-300 font-mono">{cli.noCliente}</span></div>}
                  {cli.rnc       && <div><span className="text-slate-600 font-mono">RNC</span> <span className="text-slate-300 font-mono">{cli.rnc}</span></div>}
                  {cli.telefono  && <div><span className="text-slate-600">Tel.</span> <span className="text-slate-300 font-mono">{cli.telefono}</span></div>}
                  {cli.email     && <div className="col-span-2 truncate"><span className="text-slate-600">Email</span> <span className="text-slate-300">{cli.email}</span></div>}
                </div>
              </section>

              {/* Líneas */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800">
                  <Hash size={13} className="text-blue-400" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400">Líneas ({lineas.length})</p>
                </div>
                <div className="divide-y divide-slate-800">
                  {lineas.length === 0 ? (
                    <p className="px-4 py-6 text-center text-xs text-slate-600 italic">Sin líneas de detalle.</p>
                  ) : (Array.isArray(lineas) ? lineas : []).map((l, i) => (
                    <div key={l.id ?? i} className="px-4 py-2.5 grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-7 text-xs text-slate-200">{l.descripcion}</span>
                      <span className="col-span-2 text-center text-xs font-mono text-slate-400">×{l.cantidad}</span>
                      <span className="col-span-3 text-right text-xs font-mono font-semibold text-emerald-400">{formatCurrency(Number(l.precioUnitario) * Number(l.cantidad))}</span>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 border-t border-slate-800 bg-slate-900/60 space-y-1">
                  <div className="flex justify-between text-xs text-slate-500"><span>Subtotal</span><span className="font-mono">{formatCurrency(factura.subtotal)}</span></div>
                  {Number(factura.itbis) > 0 && <div className="flex justify-between text-xs text-amber-400"><span>ITBIS (18%)</span><span className="font-mono">{formatCurrency(factura.itbis)}</span></div>}
                  <div className="flex justify-between pt-1.5 border-t border-slate-800 text-sm font-bold text-slate-100"><span>Total</span><span className="font-mono text-emerald-400">{formatCurrency(factura.total)}</span></div>
                </div>
              </section>

              {/* Meta */}
              <section className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">Emisión</p>
                  <p className="font-mono text-slate-200 flex items-center gap-1"><Calendar size={11} className="text-slate-500" />{formatDate(factura.fechaEmision)}</p>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">Estado</p>
                  <FacturaEstadoBadge estado={factura.estado} />
                </div>
              </section>

              {/* Condiciones comerciales (editable) */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2">
                    <FileText size={13} className="text-blue-400" />
                    <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400">Condiciones del documento</p>
                  </div>
                  {canEdit && !editCond && (
                    <button onClick={() => setEditCond(true)} className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-blue-400 transition-colors">
                      <Edit3 size={11} /> Editar
                    </button>
                  )}
                </div>
                {!editCond ? (
                  <div className="space-y-1.5 text-xs">
                    {['validez','pago','entrega','garantia'].map(k => {
                      const raw = full?.condiciones?.[k]
                      const item = raw == null ? null : (typeof raw === 'string' ? { incluir: !!raw.trim(), texto: raw } : raw)
                      const omitted = item && !item.incluir
                      const usaDefault = item == null
                      return (
                        <div key={k} className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 mr-1 w-16">{k}</span>
                          {omitted
                            ? <span className="text-slate-700 italic">(omitida en este documento)</span>
                            : <span className="text-slate-300 flex-1">{(item?.texto?.trim()) || <span className="text-slate-700 italic">{usaDefault ? '(usa valor por defecto de empresa)' : '—'}</span>}</span>}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {['validez','pago','entrega','garantia'].map(k => (
                      <div key={k} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{k}</label>
                          {/* Toggle Incluir/Omitir */}
                          <button type="button" onClick={() => setCond(c => ({ ...c, [k]: { ...c[k], incluir: !c[k].incluir } }))}
                            className="flex items-center gap-1.5 text-[10px] font-mono">
                            <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${cond[k].incluir ? 'bg-blue-600' : 'bg-slate-700'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${cond[k].incluir ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                            </span>
                            <span className={cond[k].incluir ? 'text-blue-300' : 'text-slate-500'}>{cond[k].incluir ? 'Incluir en PDF' : 'Omitir'}</span>
                          </button>
                        </div>
                        <input type="text" value={cond[k].texto} maxLength={280}
                          onChange={e => setCond(c => ({ ...c, [k]: { incluir: c[k].incluir || !!e.target.value, texto: e.target.value } }))}
                          disabled={!cond[k].incluir}
                          placeholder={cond[k].incluir ? '(vacío = usa default de empresa)' : 'Omitida'}
                          className={`w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-opacity ${!cond[k].incluir ? 'opacity-40' : ''}`} />
                      </div>
                    ))}
                    <div className="flex justify-end gap-2 pt-2">
                      <button onClick={() => { setEditCond(false); setCond({
                        validez:  normCond(full?.condiciones?.validez),
                        pago:     normCond(full?.condiciones?.pago),
                        entrega:  normCond(full?.condiciones?.entrega),
                        garantia: normCond(full?.condiciones?.garantia),
                      }) }}
                        className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
                        Cancelar
                      </button>
                      <button onClick={guardarCondiciones} disabled={savingCond}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40">
                        {savingCond ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                        Guardar
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-slate-800 bg-slate-900/60 flex-shrink-0">
          {canEdit && factura.estado === 'Emitida' && (
            <>
              <button onClick={() => onActualizarEstado(factura, 'Pagada')} disabled={updating === factura.id}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-semibold transition-all disabled:opacity-40">
                Marcar Pagada
              </button>
              <button onClick={() => onActualizarEstado(factura, 'Anulada')} disabled={updating === factura.id}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/15 hover:bg-red-600/25 border border-red-600/30 text-red-400 text-xs font-semibold transition-all disabled:opacity-40">
                Anular
              </button>
            </>
          )}
          {/* Nota de Crédito (DGII B04): solo facturas reales Emitida/Pagada no-NC. */}
          {canEdit && !factura.esCotizacion && !factura.esNotaCredito && (factura.estado === 'Emitida' || factura.estado === 'Pagada') && (
            <button onClick={() => setNcOpen(true)} disabled={updating === factura.id}
              title="Emitir Nota de Crédito DGII B04 que anula esta factura."
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all disabled:opacity-40 shadow-md shadow-red-600/30">
              <Ban size={12} /> Anular con Nota de Crédito
            </button>
          )}
          <button onClick={() => onPreviewPDF(factura)} disabled={downloadingId === factura.id}
            className="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors disabled:opacity-40 shadow-md shadow-blue-600/20">
            {downloadingId === factura.id ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
            Ver / Imprimir PDF
          </button>
        </div>
      </div>

      {ncOpen && (
        <ModalNotaCredito
          factura={factura}
          onClose={() => setNcOpen(false)}
          onSuccess={(nc) => {
            setNcOpen(false)
            onClose()
            onNotaCreditoEmitida?.(nc)
          }}
        />
      )}
    </div>
  )
}

// ─── ModalNotaCredito: motivo + PIN supervisor → POST /api/facturas/:id/nota-credito ──
function ModalNotaCredito({ factura, onClose, onSuccess }) {
  const [motivo, setMotivo] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const h = e => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [busy, onClose])

  async function emitir() {
    setError('')
    if (motivo.trim().length < 10) { setError('El motivo debe tener al menos 10 caracteres.'); return }
    if (!/^\d{4,8}$/.test(pin))    { setError('PIN inválido (4-8 dígitos numéricos).'); return }
    setBusy(true)
    try {
      const r = await apiFetch(`/api/facturas/${factura.id}/nota-credito`, {
        method: 'POST',
        body:   JSON.stringify({ motivo: motivo.trim(), pinSupervisor: pin }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(j.error ?? 'No se pudo emitir la Nota de Crédito.'); return }
      toast.success(`Nota de Crédito ${j.notaCredito?.ncf ?? ''} emitida. Factura origen ANULADA.`)
      onSuccess?.(j.notaCredito)
    } catch {
      setError('Error de conexión.')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div className="relative w-full max-w-md bg-slate-950 border border-red-700/40 rounded-2xl shadow-2xl shadow-red-900/50 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-800 bg-gradient-to-r from-red-950/60 to-slate-900">
          <div className="w-10 h-10 rounded-lg bg-red-600/15 border border-red-600/30 flex items-center justify-center flex-shrink-0">
            <ShieldAlert size={18} className="text-red-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-100">Anular con Nota de Crédito</p>
            <p className="text-[11px] text-slate-500 font-mono truncate">DGII B04 · {factura.noFactura}{factura.ncf ? ` · NCF ${factura.ncf}` : ''}</p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="ml-auto p-1.5 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 transition-colors disabled:opacity-40">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-[11px] text-red-300 leading-relaxed">
            <span className="font-bold uppercase tracking-wider">Acción irreversible:</span> esta operación generará un comprobante <strong>B04</strong>, dejará la factura origen en estado <strong>Anulada</strong> y restaurará el stock al inventario si la factura ya estaba <em>Pagada</em>.
          </div>

          <div>
            <label className={LABEL}>Motivo de la Nota de Crédito <span className="text-red-400">*</span></label>
            <textarea value={motivo} onChange={e => setMotivo(e.target.value)} disabled={busy}
              maxLength={500} rows={3}
              placeholder="Ej: Devolución por equipo defectuoso, error en facturación de cantidad, etc."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/30 transition-colors resize-none" />
            <p className="text-[10px] text-slate-600 mt-0.5 font-mono">{motivo.length}/500 — mínimo 10 caracteres</p>
          </div>

          <div>
            <label className={LABEL}>PIN de Supervisor <span className="text-red-400">*</span></label>
            <div className="relative">
              <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
              <input type="password" inputMode="numeric" maxLength={8}
                value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} disabled={busy}
                placeholder="••••"
                className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 font-mono tracking-widest placeholder-slate-600 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/30 transition-colors" />
            </div>
            <p className="text-[10px] text-slate-600 mt-0.5">Configurado en Configuración &gt; Empresa &gt; PIN Supervisor.</p>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-600/40 text-xs text-red-300">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800 bg-slate-900/60">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors disabled:opacity-40">
            Cancelar
          </button>
          <button onClick={emitir} disabled={busy || motivo.trim().length < 10 || !/^\d{4,8}$/.test(pin)}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-40 shadow-md shadow-red-600/30">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
            Emitir Nota de Crédito
          </button>
        </div>
      </div>
    </div>
  )
}
