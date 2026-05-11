import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { RefreshCw, Loader2, FileText, RotateCcw, AlertTriangle, Search, X } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useCart } from '../../contexts/CartContext'
import { useDebounce } from '../../hooks/useDebounce'

const fmt     = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })
const fmtDate = d => new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })

const TH = 'px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap bg-slate-800/60'
const TD = 'px-4 py-3 text-sm text-slate-300'

function ModalRevivir({ cot, onClose, onLoaded }) {
  const { clearCart, updateCartMeta, addItem, setOpen } = useCart()
  const [loading, setLoading]   = useState(true)
  const [preview, setPreview]   = useState(null)
  const [emitting, setEmitting] = useState(false)

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

  async function cargarAlCarrito() {
    setEmitting(true)
    try {
      await clearCart()
      if (cot.clienteId) await updateCartMeta({ clienteId: cot.clienteId })
      for (const l of preview.lineas) {
        await addItem(l.productoId, l.cantidad)
      }
      toast.success('Cotización cargada al carrito.')
      setOpen(true)
      onLoaded()
      onClose()
    } finally { setEmitting(false) }
  }

  async function emitirDirecto() {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="font-semibold text-slate-100">Revivir Cotización</h2>
            <p className="text-xs text-slate-500 mt-0.5">{cot.noFactura} · {fmtDate(cot.createdAt)}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-5">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-slate-500">
              <Loader2 size={18} className="animate-spin" /> Verificando precios actuales...
            </div>
          )}

          {!loading && preview && (
            <>
              {preview.hayActualizaciones && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-900/20 border border-amber-600/30 text-amber-400 text-xs mb-4">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>Algunos precios cambiaron desde que se creó la cotización. Se usarán los precios actuales.</span>
                </div>
              )}

              <div className="space-y-1 max-h-48 overflow-y-auto mb-4">
                {preview.lineas.map((l, i) => (
                  <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-800 last:border-0">
                    <div>
                      <div className="text-slate-200 leading-tight">{l._meta?.descripcion}</div>
                      {l._meta?.precioActualizado && (
                        <div className="text-xs text-amber-400">
                          Precio: RD$ {fmt(l._meta.precioEnCotizacion)} → RD$ {fmt(l._meta.precioActual)}
                        </div>
                      )}
                    </div>
                    <span className="text-slate-400 tabular-nums ml-3">×{l.cantidad}</span>
                  </div>
                ))}
              </div>

              <div className="flex justify-between text-sm border-t border-slate-800 pt-3">
                <span className="text-slate-400">Total estimado</span>
                <span className="font-bold text-blue-300">RD$ {fmt(preview.totales.total)}</span>
              </div>
            </>
          )}
        </div>

        {!loading && preview && (
          <div className="px-5 pb-5 grid grid-cols-2 gap-3">
            <button
              onClick={cargarAlCarrito}
              disabled={emitting}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {emitting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Cargar al carrito
            </button>
            <button
              onClick={emitirDirecto}
              disabled={emitting}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {emitting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              Emitir factura
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
  const [revivirCot, setRevivirCot] = useState(null)
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
              <th className={TH}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-600">Sin cotizaciones.</td></tr>
            )}
            {filtered.map(c => (
              <tr key={c.id} className="hover:bg-slate-800/40 transition-colors">
                <td className={TD + ' font-mono font-medium text-slate-200'}>{c.noFactura}</td>
                <td className={TD}>
                  <div className="text-slate-200 leading-tight">{c.cliente?.razonSocial ?? 'Consumidor Final'}</div>
                  {c.cliente?.noCliente && <div className="text-xs text-slate-500 font-mono">{c.cliente.noCliente}</div>}
                </td>
                <td className={TD + ' text-xs text-slate-400 whitespace-nowrap'}>{fmtDate(c.createdAt)}</td>
                <td className={TD + ' text-right tabular-nums'}>RD$ {fmt(c.subtotal)}</td>
                <td className={TD + ' text-right tabular-nums font-semibold text-slate-100'}>RD$ {fmt(c.total)}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setRevivirCot(c)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/40 transition-colors whitespace-nowrap"
                  >
                    <RotateCcw size={12} /> Revivir
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

      {revivirCot && (
        <ModalRevivir
          cot={revivirCot}
          onClose={() => setRevivirCot(null)}
          onLoaded={() => fetch_(offset)}
        />
      )}
    </div>
  )
}
