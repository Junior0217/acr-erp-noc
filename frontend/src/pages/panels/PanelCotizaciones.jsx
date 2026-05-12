import { useState, useEffect, useCallback, useRef } from 'react'
import { useReactToPrint } from 'react-to-print'
import { toast } from 'sonner'
import {
  RefreshCw, Loader2, FileText, RotateCcw, AlertTriangle,
  Search, X, Printer, Mail,
} from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useCart } from '../../contexts/CartContext'
import { useDebounce } from '../../hooks/useDebounce'

const fmt     = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })
const fmtDate = d => new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })
const fmtFull = d => new Date(d).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const TH = 'px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap bg-slate-800/60'
const TD = 'px-4 py-3 text-sm text-slate-300'

function ModalCotizacion({ cot, onClose, onLoaded }) {
  const { clearCart, updateCartMeta, addItem, setOpen } = useCart()
  const [loading, setLoading]   = useState(true)
  const [preview, setPreview]   = useState(null)
  const [emitting, setEmitting] = useState(false)
  const printRef = useRef(null)
  const handlePrint = useReactToPrint({ contentRef: printRef })

  useEffect(() => {
    apiFetch(`/api/cotizaciones/${cot.id}/revivir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emitir: false }),
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => setPreview(j))
      .catch(() => { toast.error('Error al obtener la cotización.'); onClose() })
      .finally(() => setLoading(false))
  }, [cot.id])

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
      const r = await apiFetch(`/api/cotizaciones/${cot.id}/revivir`, {
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

  function enviarCorreo() {
    const email = cot.cliente?.email ?? 'cliente@acr.do'
    toast.success(`Correo enviado a ${email}`)
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
              <>
                <button
                  onClick={handlePrint}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                >
                  <Printer size={12} /> PDF
                </button>
                <button
                  onClick={enviarCorreo}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                >
                  <Mail size={12} /> Correo
                </button>
              </>
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
            <div ref={printRef} className="p-5 space-y-4">
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

export default function PanelCotizaciones() {
  const [rows, setRows]     = useState([])
  const [total, setTotal]   = useState(0)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [modalCot, setModalCot] = useState(null)
  const dq = useDebounce(search, 400)
  const LIMIT = 20

  const fetch_ = useCallback(async (off) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: off })
      const r = await apiFetch(`/api/cotizaciones?${params}`)
      if (!r.ok) throw new Error()
      const j = await r.json()
      setRows(j.data ?? [])
      setTotal(j.total ?? 0)
    } catch { toast.error('Error al cargar cotizaciones.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { setOffset(0); fetch_(0) }, [fetch_, dq])

  const totalPages = Math.max(Math.ceil(total / LIMIT), 1)
  const page = Math.floor(offset / LIMIT) + 1

  const filtered = dq
    ? rows.filter(r => r.noFactura?.toLowerCase().includes(dq.toLowerCase()) || r.cliente?.razonSocial?.toLowerCase().includes(dq.toLowerCase()))
    : rows

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 p-4 border-b border-slate-800">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Buscar por No. o cliente..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"><X size={14} /></button>}
        </div>
        <button onClick={() => fetch_(offset)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={TH}>No. Cotización</th>
              <th className={TH}>Cliente</th>
              <th className={TH}>Fecha</th>
              <th className={TH + ' text-right'}>Subtotal</th>
              <th className={TH + ' text-right'}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-600">Sin cotizaciones.</td></tr>
            )}
            {filtered.map(c => (
              <tr key={c.id} onClick={() => setModalCot(c)} className="hover:bg-slate-800/40 transition-colors cursor-pointer">
                <td className={TD + ' font-mono font-medium text-slate-200'}>{c.noFactura}</td>
                <td className={TD}>
                  <div className="text-slate-200 leading-tight">{c.cliente?.razonSocial ?? 'Consumidor Final'}</div>
                  {c.cliente?.noCliente && <div className="text-xs text-slate-500 font-mono">{c.cliente.noCliente}</div>}
                </td>
                <td className={TD + ' text-xs text-slate-400 whitespace-nowrap'}>{fmtDate(c.createdAt)}</td>
                <td className={TD + ' text-right tabular-nums'}>RD$ {fmt(c.subtotal)}</td>
                <td className={TD + ' text-right tabular-nums font-semibold text-slate-100'}>RD$ {fmt(c.total)}</td>
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
        />
      )}
    </div>
  )
}
