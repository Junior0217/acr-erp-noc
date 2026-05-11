import { useState, useEffect, useRef } from 'react'
import { X, Trash2, Plus, Minus, ShoppingCart, FileText, CreditCard, Loader2, Search, UserCheck } from 'lucide-react'
import { useCart } from '../contexts/CartContext'
import { apiFetch } from '../utils/api'
import { useDebounce } from '../hooks/useDebounce'
import { toast } from 'sonner'

const fmt = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })

function ClienteSearch({ clienteActual, onSelect }) {
  const [query, setQuery]   = useState(clienteActual?.razonSocial ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen]     = useState(false)
  const dq = useDebounce(query, 350)
  const ref = useRef(null)

  useEffect(() => {
    if (!open || dq.length < 2) { setResults([]); return }
    apiFetch(`/api/clientes?search=${encodeURIComponent(dq)}&limit=6`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => setResults(j.data ?? []))
      .catch(() => {})
  }, [dq, open])

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    setQuery(clienteActual?.razonSocial ?? '')
  }, [clienteActual])

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
          placeholder="Buscar cliente (opcional)..."
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
        />
        {clienteActual && (
          <button
            onClick={() => { setQuery(''); onSelect(null); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-red-400 transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-50 top-full mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
          {results.map(c => (
            <li key={c.id}>
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
                onClick={() => { onSelect(c); setQuery(c.razonSocial); setOpen(false); }}
              >
                <div className="text-slate-100 font-medium leading-tight">{c.razonSocial}</div>
                <div className="text-xs text-slate-500 font-mono">{c.noCliente}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LineaRow({ linea, onUpdate, onRemove }) {
  const [cant, setCant] = useState(linea.cantidad)
  const [precio, setPrecio] = useState(linea.precioUnitario)
  const [dctPct, setDctPct] = useState(linea.descuentoPorcentaje)
  const [dctMon, setDctMon] = useState(linea.descuentoMonto)
  const timer = useRef(null)

  function flush(patch) {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onUpdate(linea.id, patch), 500)
  }

  function setCantidad(v) {
    const n = Math.max(1, parseInt(v) || 1)
    setCant(n)
    flush({ cantidad: n })
  }
  function setPrecioU(v) {
    const n = Math.max(0, parseFloat(v) || 0)
    setPrecio(n)
    flush({ precioUnitario: n })
  }
  function setDPct(v) {
    const n = Math.min(100, Math.max(0, parseFloat(v) || 0))
    setDctPct(n)
    flush({ descuentoPorcentaje: n })
  }
  function setDMon(v) {
    const n = Math.max(0, parseFloat(v) || 0)
    setDctMon(n)
    flush({ descuentoMonto: n })
  }

  const esSrv = linea.producto?.tipoItem === 'SERVICIO'
  const eu = Math.max(0, Math.round((precio * (1 - dctPct / 100) - dctMon) * 100) / 100)
  const total = Math.round(eu * cant * 100) / 100

  return (
    <div className="p-3 border-b border-slate-800 last:border-0">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-200 leading-tight truncate">{linea.producto?.nombre ?? '—'}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] font-mono text-slate-500">{linea.producto?.sku}</span>
            {esSrv && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/30 text-purple-400 border border-purple-700/30">Servicio</span>
            )}
            {!esSrv && linea.producto?.stockActual <= 5 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 border border-red-700/30">Stock bajo</span>
            )}
          </div>
        </div>
        <button onClick={() => onRemove(linea.id)} className="text-slate-600 hover:text-red-400 transition-colors flex-shrink-0">
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Cantidad</label>
          <div className="flex items-center gap-1">
            <button onClick={() => setCantidad(cant - 1)} className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"><Minus size={11} /></button>
            <input type="number" min="1" value={cant} onChange={e => setCantidad(e.target.value)}
              className="w-12 text-center bg-slate-800 border border-slate-700 rounded px-1 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500" />
            <button onClick={() => setCantidad(cant + 1)} className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"><Plus size={11} /></button>
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Precio Unit.</label>
          <input type="number" min="0" step="0.01" value={precio} onChange={e => setPrecioU(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Desc. %</label>
          <input type="number" min="0" max="100" step="0.01" value={dctPct} onChange={e => setDPct(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Desc. RD$</label>
          <input type="number" min="0" step="0.01" value={dctMon} onChange={e => setDMon(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500" />
        </div>
      </div>

      <div className="flex justify-end mt-2">
        <span className="text-sm font-semibold text-blue-300">RD$ {fmt(total)}</span>
      </div>
    </div>
  )
}

export default function CarritoSlideOver() {
  const { carrito, open, setOpen, loading, updateItem, removeItem, clearCart, updateCartMeta, checkout } = useCart()

  if (!open) return null

  const lineas   = carrito?.lineas ?? []
  const totales  = carrito?.totales ?? { subtotal: 0, itbis: 0, total: 0 }
  const cliente  = carrito?.cliente ?? null

  async function handleCheckout(esCotizacion) {
    if (!lineas.length) { toast.warning('El carrito está vacío.'); return }
    const f = await checkout(esCotizacion)
    if (f) setOpen(false)
  }

  async function handleClienteSelect(c) {
    await updateCartMeta({ clienteId: c?.id ?? null })
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <ShoppingCart size={16} className="text-blue-400" />
            <span className="font-semibold text-slate-100">Carrito POS</span>
            {lineas.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-400 border border-blue-600/30">{lineas.length} items</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {lineas.length > 0 && (
              <button onClick={clearCart} className="text-xs text-slate-600 hover:text-red-400 transition-colors">Vaciar</button>
            )}
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-100 transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-slate-800 flex-shrink-0 space-y-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5 font-medium">Cliente</label>
            <ClienteSearch clienteActual={cliente} onSelect={handleClienteSelect} />
            {cliente && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <UserCheck size={12} className="text-emerald-400" />
                <span className="text-xs text-emerald-400">{cliente.razonSocial}</span>
                <span className="text-xs text-slate-600">· {cliente.noCliente}</span>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-400 font-medium">Aplicar ITBIS (18%)</label>
            <button
              onClick={() => updateCartMeta({ applyItbis: !carrito?.applyItbis })}
              className={`w-10 h-5 rounded-full transition-colors relative ${carrito?.applyItbis ? 'bg-blue-600' : 'bg-slate-700'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${carrito?.applyItbis ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {lineas.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-600">
              <ShoppingCart size={32} />
              <p className="text-sm">Carrito vacío</p>
              <p className="text-xs text-center px-8">Agrega productos desde el catálogo de Inventario.</p>
            </div>
          )}
          {lineas.map(l => (
            <LineaRow key={l.id} linea={l} onUpdate={updateItem} onRemove={removeItem} />
          ))}
        </div>

        {lineas.length > 0 && (
          <div className="flex-shrink-0 border-t border-slate-800">
            <div className="px-4 py-3 space-y-1 bg-slate-900/60">
              <div className="flex justify-between text-sm text-slate-400">
                <span>Subtotal</span>
                <span className="tabular-nums">RD$ {fmt(totales.subtotal)}</span>
              </div>
              {carrito?.applyItbis && (
                <div className="flex justify-between text-sm text-slate-400">
                  <span>ITBIS (18%)</span>
                  <span className="tabular-nums">RD$ {fmt(totales.itbis)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-slate-100 pt-1 border-t border-slate-800">
                <span>Total</span>
                <span className="tabular-nums text-blue-300">RD$ {fmt(totales.total)}</span>
              </div>
            </div>

            <div className="px-4 py-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => handleCheckout(true)}
                disabled={loading}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                Cotización
              </button>
              <button
                onClick={() => handleCheckout(false)}
                disabled={loading}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                Emitir Factura
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
