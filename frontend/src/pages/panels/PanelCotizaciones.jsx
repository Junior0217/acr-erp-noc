import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  RefreshCw, Loader2, FileText, RotateCcw, AlertTriangle,
  Search, X, Printer, CheckSquare, Square, FileArchive, Plus, ScrollText,
} from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { fetchPdfBlob, descargarBulkZip } from '../../utils/pdf'
import { useCart } from '../../contexts/CartContext'
import PdfPreviewDrawer from '../../components/PdfPreviewDrawer'

const fmt     = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })
const fmtDate = d => new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })
const fmtFull = d => new Date(d).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const TH = 'px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap bg-slate-800/60'
const TD = 'px-4 py-3 text-sm text-slate-300'

function ModalCotizacion({ cot, onClose, onLoaded, onPreviewPDF }) {
  const { clearCart, updateCartMeta, addItem, setOpen } = useCart()
  const [loading, setLoading]   = useState(true)
  const [preview, setPreview]   = useState(null)
  const [emitting, setEmitting] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    apiFetch(`/api/ventas/cotizaciones/${cot.id}/revivir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emitir: false }),
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => setPreview(j))
      .catch(() => { toast.error('Error al obtener la cotización.'); onClose() })
      .finally(() => setLoading(false))
  }, [cot.id])

  // Delegar al padre: abre el Drawer compartido con el PDF server-side.
  async function descargarPDF() {
    if (downloading) return
    setDownloading(true)
    await onPreviewPDF?.(cot)
    setDownloading(false)
  }

  const tieneProductos = preview?.lineas?.some(l => l.productoId) ?? false

  async function cargarAlCarrito() {
    setEmitting(true)
    try {
      const lineasConProducto = preview.lineas.filter(l => l.productoId)
      if (lineasConProducto.length === 0) {
        toast.error('Cotización sin productos — usa "Convertir a Factura".')
        return
      }
      await clearCart()
      if (cot.clienteId) await updateCartMeta({ clienteId: cot.clienteId })
      for (const l of lineasConProducto) {
        await addItem(l.productoId, l.cantidad)
      }
      const omitidas = preview.lineas.length - lineasConProducto.length
      if (omitidas > 0) toast.warning(`${omitidas} línea(s) de servicio omitidas del carrito.`)
      else toast.success('Cotización cargada al carrito.')
      setOpen(true)
      onLoaded()
      onClose()
    } finally { setEmitting(false) }
  }

  async function convertirAFactura() {
    setEmitting(true)
    try {
      const r = await apiFetch(`/api/ventas/cotizaciones/${cot.id}/revivir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emitir: true }),
      })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error al emitir.'); return }
      toast.success(`Factura ${j.factura?.noFactura} emitida.`)
      onLoaded()
      onClose()
    } finally { setEmitting(false) }
  }

  const subtotalBruto = preview?.totales?.subtotal ?? 0
  const itbisAmt      = preview?.totales?.itbis ?? 0
  const totalAmt      = preview?.totales?.total ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-slate-100">Cotización</h2>
            <p className="text-xs text-slate-500 mt-0.5">{cot.noFactura} · {fmtFull(cot.createdAt)}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {!loading && preview && (
              <button
                onClick={descargarPDF}
                disabled={downloading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
              >
                {downloading ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                {downloading ? 'Generando…' : 'Imprimir / PDF'}
              </button>
            )}
            <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors ml-1">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-2 text-slate-500">
              <Loader2 size={18} className="animate-spin" /> Verificando precios actuales...
            </div>
          )}

          {!loading && preview && (
            <div className="p-5 space-y-4">
              {/* Client + meta */}
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Cliente</span>
                  <span className="text-slate-200 font-medium">{cot.cliente?.razonSocial ?? 'Consumidor Final'}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-600">Fecha</span>
                  <span className="text-slate-400">{fmtFull(cot.createdAt)}</span>
                </div>
              </div>

              {preview.hayActualizaciones && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-900/20 border border-amber-600/30 text-amber-400 text-xs">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>Algunos precios cambiaron. Se usarán los precios actuales al convertir.</span>
                </div>
              )}

              {/* Line items */}
              <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg overflow-hidden">
                <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-800/60">
                  <div className="col-span-6 text-[10px] font-semibold text-slate-500 uppercase">Descripción</div>
                  <div className="col-span-2 text-[10px] font-semibold text-slate-500 uppercase text-center">Cant.</div>
                  <div className="col-span-4 text-[10px] font-semibold text-slate-500 uppercase text-right">Subtotal</div>
                </div>
                {preview.lineas.map((l, i) => {
                  const lineTotal = Math.round(l.precioUnitario * l.cantidad * 100) / 100
                  return (
                    <div key={i} className="grid grid-cols-12 gap-2 px-3 py-2.5 items-center">
                      <div className="col-span-6">
                        <div className="text-sm text-slate-200 leading-tight">{l._meta?.descripcion}</div>
                        {l._meta?.precioActualizado && (
                          <div className="text-[10px] text-amber-400 mt-0.5">
                            RD$ {fmt(l._meta.precioEnCotizacion)} → RD$ {fmt(l._meta.precioActual)}
                          </div>
                        )}
                      </div>
                      <div className="col-span-2 text-center text-slate-400 text-sm">×{l.cantidad}</div>
                      <div className="col-span-4 text-right font-mono text-sm text-slate-300">RD$ {fmt(lineTotal)}</div>
                    </div>
                  )
                })}
              </div>

              {/* Totals */}
              <div className="border-t border-slate-800 pt-3 space-y-1.5">
                <div className="flex justify-between text-sm text-slate-400">
                  <span>Subtotal</span>
                  <span className="tabular-nums">RD$ {fmt(subtotalBruto)}</span>
                </div>
                {itbisAmt > 0 && (
                  <div className="flex justify-between text-sm text-amber-400">
                    <span>ITBIS (18%)</span>
                    <span className="tabular-nums">RD$ {fmt(itbisAmt)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-bold text-slate-100 pt-1 border-t border-slate-800">
                  <span>Total</span>
                  <span className="text-blue-300">RD$ {fmt(totalAmt)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        {!loading && preview && (
          <div className="px-5 pb-5 pt-3 border-t border-slate-800 grid grid-cols-2 gap-3 flex-shrink-0">
            <button
              onClick={cargarAlCarrito}
              disabled={emitting || !tieneProductos}
              title={!tieneProductos ? 'Solo servicios — no hay productos para cargar' : undefined}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {emitting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Cargar al carrito
            </button>
            <button
              onClick={convertirAFactura}
              disabled={emitting}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {emitting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              Convertir a Factura
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function PanelCotizaciones({ onIrPOS, canPOS }) {
  const [rows, setRows]       = useState([])
  const [total, setTotal]     = useState(0)
  const [offset, setOffset]   = useState(0)
  const [filtroNumero,  setFiltroNumero]  = useState('')
  const [filtroCliente, setFiltroCliente] = useState('')
  const [filtroCodigo,  setFiltroCodigo]  = useState('')
  const [filtroDesde,   setFiltroDesde]   = useState('')
  const [filtroHasta,   setFiltroHasta]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [modalCot, setModalCot] = useState(null)
  const [pdfId, setPdfId]       = useState(null)
  const [drawer, setDrawer] = useState({ open: false, blob: null, blobUrl: null, filename: null, title: null, subtitle: null, loading: false })
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const LIMIT = 20

  function cerrarDrawer() {
    setDrawer(d => {
      if (d.blobUrl) URL.revokeObjectURL(d.blobUrl)
      return { open: false, blob: null, blobUrl: null, filename: null, title: null, subtitle: null, loading: false }
    })
  }
  async function previewPDF(c) {
    if (pdfId) return
    setPdfId(c.id)
    const filename = `cotizacion-${c.noFactura}.pdf`
    cerrarDrawer()
    setDrawer({ open: true, blob: null, blobUrl: null, filename,
      title: `Cotización · ${c.noFactura}`,
      subtitle: c.cliente?.razonSocial ?? 'Consumidor Final', loading: true })
    const result = await fetchPdfBlob(`/api/ventas/cotizaciones/${c.id}/pdf`, filename)
    setPdfId(null)
    if (!result) { setDrawer(d => ({ ...d, open: false, loading: false })); return }
    setDrawer(d => ({ ...d, blob: result.blob, blobUrl: result.blobUrl, loading: false }))
  }

  // Bulk select
  const visibleIds = useMemo(() => rows.map(r => r.id), [rows])
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id))
  function toggleSel(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll() {
    setSelected(prev => {
      if (allSelected) { const n = new Set(prev); visibleIds.forEach(id => n.delete(id)); return n }
      const n = new Set(prev); visibleIds.forEach(id => n.add(id)); return n
    })
  }
  async function exportZip() {
    if (selected.size === 0) return
    if (selected.size > 50) { toast.error('Máximo 50 cotizaciones por ZIP.'); return }
    setBulkBusy(true)
    const ok = await descargarBulkZip([...selected], 'cotizacion')
    setBulkBusy(false)
    if (ok) setSelected(new Set())
  }

  const fetch_ = useCallback(async (off) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: off })
      if (filtroNumero)  params.set('search',        filtroNumero.trim())
      if (filtroCliente) params.set('clienteNombre', filtroCliente.trim())
      if (filtroCodigo)  params.set('clienteCodigo', filtroCodigo.trim())
      if (filtroDesde)   params.set('desde',         filtroDesde)
      if (filtroHasta)   params.set('hasta',         filtroHasta)
      const r = await apiFetch(`/api/ventas/cotizaciones?${params}`)
      if (!r.ok) throw new Error()
      const j = await r.json()
      setRows(j.data ?? [])
      setTotal(j.total ?? 0)
    } catch { toast.error('Error al cargar cotizaciones.') }
    finally { setLoading(false) }
  }, [filtroNumero, filtroCliente, filtroCodigo, filtroDesde, filtroHasta])

  useEffect(() => {
    const t = setTimeout(() => { setOffset(0); fetch_(0) }, 250)
    return () => clearTimeout(t)
  }, [fetch_])

  function limpiarFiltros() {
    setFiltroNumero(''); setFiltroCliente(''); setFiltroCodigo('')
    setFiltroDesde(''); setFiltroHasta('')
  }
  const hayFiltros = !!(filtroNumero || filtroCliente || filtroCodigo || filtroDesde || filtroHasta)

  const totalPages = Math.max(Math.ceil(total / LIMIT), 1)
  const page = Math.floor(offset / LIMIT) + 1

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-0">
        <div className="flex items-center gap-2">
          <ScrollText size={16} className="text-amber-400" />
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">Cotizaciones</h2>
        </div>
        {canPOS && onIrPOS && (
          <button onClick={onIrPOS}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-orange-600 hover:bg-orange-500 text-white transition-colors shadow-lg shadow-orange-600/20">
            <Plus size={14} /> Nueva Cotización / POS
          </button>
        )}
      </div>
      <div className="p-4 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
          <div className="lg:col-span-2 relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input value={filtroNumero} onChange={e => setFiltroNumero(e.target.value)}
              placeholder="No. Cotización…"
              className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          <input value={filtroCliente} onChange={e => setFiltroCliente(e.target.value)}
            placeholder="Cliente (nombre / razón social)…"
            className="lg:col-span-2 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
          <input value={filtroCodigo} onChange={e => setFiltroCodigo(e.target.value)}
            placeholder="Código cliente…"
            className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">Emisión desde</label>
            <input type="date" value={filtroDesde} onChange={e => setFiltroDesde(e.target.value)}
              className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">Hasta</label>
            <input type="date" value={filtroHasta} onChange={e => setFiltroHasta(e.target.value)}
              className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
          {hayFiltros && (
            <button onClick={limpiarFiltros}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/60 border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-700/40 transition-all">
              <X size={11} /> Limpiar
            </button>
          )}
          <button onClick={() => fetch_(offset)}
            className="ml-auto p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3 w-10 bg-slate-800/60">
                <button onClick={toggleAll} title={allSelected ? 'Quitar selección' : 'Seleccionar visibles'}
                  className="text-slate-500 hover:text-blue-400 transition-colors">
                  {allSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                </button>
              </th>
              <th className={TH}>No. Cotización</th>
              <th className={TH}>Cliente</th>
              <th className={TH}>Fecha</th>
              <th className={TH + ' text-right'}>Subtotal</th>
              <th className={TH + ' text-right'}>Total</th>
              <th className={TH + ' text-center'} style={{ width: 60 }}>PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-600">Sin cotizaciones.</td></tr>
            )}
            {rows.map(c => (
              <tr key={c.id} onClick={() => setModalCot(c)}
                className={`hover:bg-slate-800/40 transition-colors cursor-pointer ${selected.has(c.id) ? 'bg-blue-900/15' : ''}`}>
                <td className="px-3 py-3" onClick={e => { e.stopPropagation(); toggleSel(c.id) }}>
                  <button className="text-slate-500 hover:text-blue-400 transition-colors">
                    {selected.has(c.id) ? <CheckSquare size={15} className="text-blue-400" /> : <Square size={15} />}
                  </button>
                </td>
                <td className={TD + ' font-mono font-medium text-slate-200'}>{c.noFactura}</td>
                <td className={TD}>
                  <div className="text-slate-200 leading-tight">{c.cliente?.razonSocial ?? 'Consumidor Final'}</div>
                  {c.cliente?.noCliente && <div className="text-xs text-slate-500 font-mono">{c.cliente.noCliente}</div>}
                </td>
                <td className={TD + ' text-xs text-slate-400 whitespace-nowrap'}>{fmtDate(c.createdAt)}</td>
                <td className={TD + ' text-right tabular-nums'}>RD$ {fmt(c.subtotal)}</td>
                <td className={TD + ' text-right tabular-nums font-semibold text-slate-100'}>RD$ {fmt(c.total)}</td>
                <td className="px-2 py-3 text-center" onClick={e => e.stopPropagation()}>
                  <button onClick={() => previewPDF(c)} disabled={pdfId === c.id}
                    title="Previsualizar PDF"
                    className="p-1.5 rounded-lg text-slate-600 hover:text-blue-400 hover:bg-blue-600/10 transition-colors disabled:opacity-40">
                    {pdfId === c.id ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
          <span className="text-xs text-slate-500">{total} cotizaciones · pág. {page}/{totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => { setOffset(Math.max(0, offset - LIMIT)); fetch_(Math.max(0, offset - LIMIT)) }} disabled={offset === 0}
              className="px-3 py-1.5 text-xs rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              Anterior
            </button>
            <button onClick={() => { const n = offset + LIMIT; setOffset(n); fetch_(n) }} disabled={offset + LIMIT >= total}
              className="px-3 py-1.5 text-xs rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              Siguiente
            </button>
          </div>
        </div>
      )}

      {modalCot && (
        <ModalCotizacion
          cot={modalCot}
          onClose={() => setModalCot(null)}
          onLoaded={() => fetch_(offset)}
          onPreviewPDF={previewPDF}
        />
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-2xl shadow-2xl shadow-blue-600/20 px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-600/15 border border-blue-600/30">
            <CheckSquare size={13} className="text-blue-400" />
            <span className="text-xs font-bold text-blue-300 font-mono">{selected.size}</span>
            <span className="text-[10px] text-slate-400">seleccionada{selected.size !== 1 ? 's' : ''}</span>
          </div>
          <span className="text-[10px] text-slate-600">máx 50 por exportación</span>
          <button onClick={() => setSelected(new Set())}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            Limpiar
          </button>
          <button onClick={exportZip} disabled={bulkBusy || selected.size > 50}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40 shadow-md shadow-blue-600/30">
            {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <FileArchive size={12} />}
            Descargar ZIP ({selected.size})
          </button>
        </div>
      )}

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
    </div>
  )
}
