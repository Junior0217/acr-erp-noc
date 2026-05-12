import { useState, useEffect, useCallback, useRef } from 'react'
import { useReactToPrint } from 'react-to-print'
import { toast } from 'sonner'
import {
  Loader2, RefreshCw, DollarSign, Plus, Trash2, X,
  Search, Receipt, Printer, FileText, Mail,
} from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useAuth } from '../../contexts/AuthContext'
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

  const totales = lineas.reduce((acc, l) => {
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
        lineas: lineas.map(l => ({
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
              {lineas.map((l, i) => (
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

// ─── Modal Vista Previa / Impresión ───────────────────────────────────────────

function ModalVistaPrevia({ factura, onClose }) {
  const contentRef  = useRef(null)
  const handlePrint = useReactToPrint({ contentRef })
  const esCot = factura.esCotizacion
  const cli   = factura.cliente ?? {}

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-white rounded-xl shadow-2xl flex flex-col max-h-[92vh]">

        {/* Toolbar (not printed) */}
        <div className="flex items-center justify-between px-5 py-3 bg-slate-800 rounded-t-xl print:hidden shrink-0">
          <span className="text-sm font-semibold text-slate-300">
            {esCot ? 'Cotización' : 'Factura'} · {factura.noFactura}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => toast.success(`Correo enviado a ${cli.email ?? 'cliente@acr.do'}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-semibold transition-colors"
            >
              <Mail size={14} /> Correo
            </button>
            <button onClick={handlePrint}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
              <Printer size={14} /> Imprimir / PDF
            </button>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
          </div>
        </div>

        {/* Printable content */}
        <div className="overflow-y-auto">
          <div ref={contentRef} className="p-8 bg-white text-gray-900 text-sm font-sans relative">

            {/* Watermark cotización */}
            {esCot && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden">
                <span className="text-7xl font-black text-gray-100 select-none tracking-widest"
                  style={{ transform: 'rotate(-30deg)', whiteSpace: 'nowrap' }}>
                  COTIZACIÓN
                </span>
              </div>
            )}

            {/* Header */}
            <div className="flex justify-between items-start mb-7">
              <div>
                {/* Logo placeholder */}
                <div className="w-36 h-14 bg-gray-100 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center mb-3">
                  <span className="text-[10px] text-gray-400 font-mono font-bold tracking-widest">ACR LOGO</span>
                </div>
                <div className="text-sm font-black text-gray-800 leading-tight">ACR Networks &amp; Solutions</div>
                <div className="text-[10px] text-gray-500 mt-0.5">ISP · CCTV · Infraestructura de Redes</div>
                <div className="text-[10px] text-gray-500">Santo Domingo, República Dominicana</div>
                <div className="text-[10px] text-gray-500">RNC: 1-32-XXXXX-X · Tel: 829-XXX-XXXX</div>
              </div>

              <div className="text-right">
                <div className={`text-2xl font-black mb-1 ${esCot ? 'text-amber-600' : 'text-blue-700'}`}>
                  {esCot ? 'COTIZACIÓN' : 'FACTURA'}
                </div>
                <div className="text-base font-mono font-bold text-gray-700">{factura.noFactura}</div>
                {factura.ncf && (
                  <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 inline-block text-right">
                    <div className="text-[9px] font-bold text-blue-500 uppercase tracking-widest">NCF</div>
                    <div className="text-sm font-mono font-black text-blue-700">{factura.ncf}</div>
                    <div className="text-[9px] text-blue-400">{factura.tipoNcf}</div>
                  </div>
                )}
                <div className="mt-2 text-[10px] text-gray-500 space-y-0.5">
                  <div>Emisión: <span className="font-semibold text-gray-700">{formatDate(factura.fechaEmision)}</span></div>
                  {factura.fechaVence && <div>Vence: <span className="font-semibold text-gray-700">{formatDate(factura.fechaVence)}</span></div>}
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t-2 border-gray-200 mb-5" />

            {/* Client */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
              <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Facturar a</div>
              <div className="font-black text-gray-800">{cli.razonSocial ?? '—'}</div>
              {cli.rnc && <div className="text-xs text-gray-600 font-mono mt-0.5">RNC: {cli.rnc}</div>}
              {cli.direccion && cli.direccion !== 'N/A' && <div className="text-xs text-gray-500 mt-0.5">{cli.direccion}</div>}
            </div>

            {/* Line items */}
            <table className="w-full mb-5" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #d1d5db' }}>
                  <th className="py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wide">Descripción</th>
                  <th className="py-2 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wide w-14">Cant.</th>
                  <th className="py-2 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wide w-28">Precio Unit.</th>
                  <th className="py-2 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wide w-28">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {(factura.lineas ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-xs text-gray-400 italic">
                      Sin detalle de líneas disponible
                    </td>
                  </tr>
                ) : (factura.lineas ?? []).map((l, i) => (
                  <tr key={l.id ?? i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td className="py-2 text-xs text-gray-800">{l.descripcion}</td>
                    <td className="py-2 text-xs text-center text-gray-700 font-mono">{Number(l.cantidad)}</td>
                    <td className="py-2 text-xs text-right text-gray-700 font-mono">{formatCurrency(l.precioUnitario)}</td>
                    <td className="py-2 text-xs text-right font-mono font-semibold text-gray-800">
                      {formatCurrency(Number(l.precioUnitario) * Number(l.cantidad))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="flex justify-end mb-6">
              <div className="w-60">
                <div className="flex justify-between py-1 text-xs text-gray-600 border-b border-gray-100">
                  <span>Subtotal</span>
                  <span className="font-mono">{formatCurrency(factura.subtotal)}</span>
                </div>
                {Number(factura.itbis) > 0 && (
                  <div className="flex justify-between py-1 text-xs text-amber-700 border-b border-gray-100">
                    <span>ITBIS (18%)</span>
                    <span className="font-mono">{formatCurrency(factura.itbis)}</span>
                  </div>
                )}
                <div className="flex justify-between py-2.5 text-sm font-black text-gray-900">
                  <span>TOTAL RD$</span>
                  <span className="font-mono">{formatCurrency(factura.total)}</span>
                </div>
              </div>
            </div>

            {/* Footer: legal + QR */}
            <div className="flex justify-between items-end border-t border-gray-200 pt-4">
              <div className="text-[9px] text-gray-400 font-mono space-y-0.5">
                <div>Documento generado electrónicamente por ACR Networks &amp; Solutions ERP.</div>
                {!esCot && <div>Verificar NCF en: dgii.gov.do/verificador</div>}
                {esCot && <div className="text-amber-600 font-semibold">Cotización sin validez fiscal — no tiene NCF asignado.</div>}
              </div>
              {/* QR placeholder */}
              <div className="w-16 h-16 border-2 border-dashed border-gray-300 rounded flex flex-col items-center justify-center gap-0.5 shrink-0">
                <div className="grid grid-cols-3 gap-0.5 mb-0.5">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <div key={i} className={`w-1.5 h-1.5 rounded-sm ${[0,2,4,6,8].includes(i) ? 'bg-gray-400' : 'bg-transparent'}`} />
                  ))}
                </div>
                <div className="text-[7px] text-gray-400 font-mono font-bold">QR · DGII</div>
              </div>
            </div>
          </div>
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
  const [facturaPreview, setFacturaPreview]        = useState(null)
  const [loadingPreview, setLoadingPreview]        = useState(null)

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
    if (nuevoEstado === 'Anulada') {
      if (!window.confirm(`¿Anular la factura ${f.noFactura} (NCF: ${f.ncf})?\nEsta acción es irreversible.`)) return
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

  async function abrirPreview(f) {
    setLoadingPreview(f.id)
    try {
      const r = await apiFetch(`/api/ventas/facturas/${f.id}`)
      if (!r.ok) { toast.error('No se pudo cargar la factura.'); return }
      const j = await r.json()
      setFacturaPreview(j)
    } catch { toast.error('Error de conexión.') }
    finally { setLoadingPreview(null) }
  }

  const colSpan = 10 + (canEdit ? 1 : 0)

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
                <tr key={f.id} onClick={() => !loadingPreview && abrirPreview(f)}
                  className={`hover:bg-slate-800/50 transition-colors cursor-pointer ${f.id === highlightId ? 'ring-1 ring-inset ring-emerald-500/40 bg-emerald-900/10' : ''}`}>
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
                  {/* Print button */}
                  <td className="px-2 py-3" onClick={e => e.stopPropagation()}>
                    <button onClick={() => abrirPreview(f)} disabled={loadingPreview === f.id}
                      title="Ver / Imprimir"
                      className="p-1.5 rounded-lg text-slate-600 hover:text-blue-400 hover:bg-blue-600/10 transition-colors disabled:opacity-40">
                      {loadingPreview === f.id
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Printer size={14} />}
                    </button>
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
          onSuccess={f => { setShowManual(false); fetchFacturas(); setFacturaPreview(f) }}
        />
      )}

      {facturaPreview && (
        <ModalVistaPrevia
          factura={facturaPreview}
          onClose={() => setFacturaPreview(null)}
        />
      )}
    </div>
  )
}
