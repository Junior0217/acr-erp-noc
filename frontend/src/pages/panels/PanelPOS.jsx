import { useState, useEffect, useCallback } from 'react'
import { Search, Plus, Minus, Trash2, ShoppingBag, FileText, Tag, Loader2, X, User } from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useAuth } from '../../contexts/AuthContext'
import toast from 'react-hot-toast'

const fmt = v => Number(v ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ── ClienteSearch ─────────────────────────────────────────────────────────────
function ClienteSearch({ clienteId, onChange }) {
  const [q, setQ]         = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    if (!clienteId) { setSelected(null); return }
  }, [clienteId])

  async function buscar(v) {
    setQ(v)
    if (v.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const r = await apiFetch(`/api/clientes?search=${encodeURIComponent(v)}&limit=8`)
      const j = await r.json()
      setResults(j.data ?? [])
    } finally { setLoading(false) }
  }

  function seleccionar(c) {
    setSelected(c)
    setResults([])
    setQ('')
    onChange(c)
  }

  function limpiar() {
    setSelected(null)
    onChange(null)
  }

  if (selected) {
    return (
      <div className="flex items-center justify-between bg-blue-600/10 border border-blue-600/30 rounded-lg px-3 py-2">
        <div className="flex items-center gap-2">
          <User size={14} className="text-blue-400" />
          <div>
            <p className="text-sm font-medium text-slate-100 leading-tight">{selected.razonSocial}</p>
            <p className="text-xs text-slate-500 font-mono">{selected.noCliente}</p>
          </div>
        </div>
        <button onClick={limpiar} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={14} /></button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        value={q}
        onChange={e => buscar(e.target.value)}
        placeholder="Buscar cliente (nombre / RNC)…"
        className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
      />
      {loading && <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-blue-400 animate-spin" />}
      {results.length > 0 && (
        <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-xl divide-y divide-slate-700/50 max-h-52 overflow-y-auto">
          {results.map(c => (
            <button key={c.id} onClick={() => seleccionar(c)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-700/60 transition-colors">
              <p className="text-slate-100 font-medium leading-tight">{c.razonSocial}</p>
              <p className="text-xs text-slate-500 font-mono">{c.noCliente} · {c.rnc ?? 'Sin RNC'}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── CatalogSearch ─────────────────────────────────────────────────────────────
function CatalogSearch({ onAdd }) {
  const [q, setQ]       = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [tipoFiltro, setTipoFiltro] = useState('')

  const cargar = useCallback(async (query, tipo) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ activo: 'true' })
      if (query) p.set('search', query)
      if (tipo)  p.set('tipoItem', tipo)
      const r = await apiFetch(`/api/catalogo?${p}`)
      const j = await r.json()
      setItems(j.data ?? [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { cargar(q, tipoFiltro) }, [q, tipoFiltro, cargar])

  const TIPO_COLORS = {
    ARTICULO: 'text-amber-400 bg-amber-600/10 border-amber-600/20',
    SERVICIO: 'text-blue-400 bg-blue-600/10 border-blue-600/20',
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Buscar en catálogo…"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <select value={tipoFiltro} onChange={e => setTipoFiltro(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-300 focus:outline-none focus:border-blue-500">
          <option value="">Todo</option>
          <option value="ARTICULO">Artículos</option>
          <option value="SERVICIO">Servicios</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-blue-400" /></div>
        ) : items.length === 0 ? (
          <p className="text-center text-xs text-slate-500 py-8 font-mono">Sin resultados.</p>
        ) : items.map(item => (
          <div key={item.id}
            className="flex items-center justify-between px-3 py-2.5 bg-slate-800/40 hover:bg-slate-700/40 border border-slate-700/40 rounded-lg cursor-pointer transition-colors group"
            onClick={() => onAdd(item)}>
            <div className="min-w-0">
              <p className="text-sm text-slate-100 font-medium leading-tight truncate">{item.nombre}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${TIPO_COLORS[item.tipoItem] ?? 'text-slate-400 bg-slate-700 border-slate-600'}`}>
                  {item.tipoItem}
                </span>
                <span className="text-xs text-slate-500 font-mono">RD$ {fmt(item.precio)}</span>
              </div>
            </div>
            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-600/0 group-hover:bg-blue-600/20 border border-transparent group-hover:border-blue-600/30 flex items-center justify-center transition-all">
              <Plus size={14} className="text-blue-400" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── CartLine ──────────────────────────────────────────────────────────────────
function CartLine({ linea, onChange, onRemove }) {
  const pu  = linea.precioUnitario
  const pct = linea.descuentoPorcentaje ?? 0
  const mon = linea.descuentoMonto ?? 0
  const efectivo = Math.max(0, pu * (1 - pct / 100) - mon)
  const subtotal = Math.round(efectivo * linea.cantidad * 100) / 100

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-100 leading-tight flex-1 min-w-0 truncate">{linea.nombre}</p>
        <button onClick={onRemove} className="flex-shrink-0 text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={13} /></button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {/* qty */}
        <div className="flex items-center gap-1 bg-slate-800 border border-slate-700 rounded-lg">
          <button onClick={() => onChange({ cantidad: Math.max(1, linea.cantidad - 1) })} className="px-2 py-1 text-slate-400 hover:text-slate-100 transition-colors"><Minus size={11} /></button>
          <span className="px-1 min-w-[24px] text-center text-sm font-mono text-slate-100">{linea.cantidad}</span>
          <button onClick={() => onChange({ cantidad: linea.cantidad + 1 })} className="px-2 py-1 text-slate-400 hover:text-slate-100 transition-colors"><Plus size={11} /></button>
        </div>
        {/* price override */}
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <span>RD$</span>
          <input
            type="number" min="0" step="0.01"
            value={pu}
            onChange={e => onChange({ precioUnitario: parseFloat(e.target.value) || 0 })}
            className="w-20 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
          />
        </div>
        {/* discount % */}
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <Tag size={10} />
          <input
            type="number" min="0" max="100" step="1"
            value={pct}
            onChange={e => onChange({ descuentoPorcentaje: parseFloat(e.target.value) || 0 })}
            className="w-12 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500"
          />
          <span>%</span>
        </div>
      </div>
      <div className="text-right text-sm font-mono text-emerald-400 font-semibold">RD$ {fmt(subtotal)}</div>
    </div>
  )
}

// ── PanelPOS ──────────────────────────────────────────────────────────────────
export default function PanelPOS() {
  const { tienePermiso } = useAuth()
  const [cart, setCart]             = useState([])
  const [cliente, setCliente]       = useState(null)
  const [nombreWalkin, setNombreWalkin] = useState('')
  const [applyItbis, setApplyItbis] = useState(true)
  const [descGlobalPct, setDescGlobalPct] = useState(0)
  const [descGlobalMonto, setDescGlobalMonto] = useState(0)
  const [tipoNcf, setTipoNcf]       = useState('Auto')
  const [submitting, setSubmitting] = useState(false)

  const canCotizar  = tienePermiso('pos:cotizar')  || tienePermiso('sistema:owner')
  const canFacturar = tienePermiso('pos:facturar') || tienePermiso('sistema:owner')
  const canDescuento = tienePermiso('pos:descuentos') || tienePermiso('sistema:owner')

  function addItem(item) {
    setCart(prev => {
      const idx = prev.findIndex(l => l.itemCatalogoId === item.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], cantidad: next[idx].cantidad + 1 }
        return next
      }
      return [...prev, { itemCatalogoId: item.id, nombre: item.nombre, cantidad: 1, precioUnitario: Number(item.precio), descuentoPorcentaje: 0, descuentoMonto: 0 }]
    })
  }

  function updateLine(idx, changes) {
    setCart(prev => prev.map((l, i) => i === idx ? { ...l, ...changes } : l))
  }

  function removeLine(idx) {
    setCart(prev => prev.filter((_, i) => i !== idx))
  }

  const efectivoUnitario = (pu, pct, mon) => Math.max(0, pu * (1 - pct / 100) - mon)
  const subtotalBruto = cart.reduce((s, l) => s + efectivoUnitario(l.precioUnitario, l.descuentoPorcentaje ?? 0, l.descuentoMonto ?? 0) * l.cantidad, 0)
  const globalDesc    = descGlobalPct > 0 ? subtotalBruto * (descGlobalPct / 100) : Math.min(descGlobalMonto, subtotalBruto)
  const subtotal      = Math.round((subtotalBruto - globalDesc) * 100) / 100
  const itbisAmt      = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  const total         = Math.round((subtotal + itbisAmt) * 100) / 100

  async function submit(esCotizacion) {
    if (!cart.length) { toast.error('El carrito está vacío.'); return }
    const requiredPerm = esCotizacion ? 'pos:cotizar' : 'pos:facturar'
    if (!tienePermiso(requiredPerm) && !tienePermiso('sistema:owner')) {
      toast.error(`Sin permiso: ${requiredPerm}`); return
    }
    setSubmitting(true)
    try {
      const body = {
        clienteId:            cliente?.id ?? undefined,
        nombreTemporal:       !cliente && nombreWalkin ? nombreWalkin : undefined,
        tipoNcf:              tipoNcf === 'Auto' ? undefined : tipoNcf,
        applyItbis,
        esCotizacion,
        descuentoGlobalPct:   descGlobalPct,
        descuentoGlobalMonto: descGlobalMonto,
        lineas: cart.map(l => ({
          itemCatalogoId:      l.itemCatalogoId,
          cantidad:            l.cantidad,
          precioUnitario:      l.precioUnitario,
          descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
          descuentoMonto:      l.descuentoMonto ?? 0,
        })),
      }
      const r = await apiFetch('/api/pos/venta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error.'); return }
      toast.success(esCotizacion ? `Cotización ${j.noFactura} guardada.` : `Factura ${j.noFactura} emitida.`)
      setCart([])
      setCliente(null)
      setNombreWalkin('')
      setDescGlobalPct(0)
      setDescGlobalMonto(0)
    } finally { setSubmitting(false) }
  }

  const NCF_TYPES = ['Auto', 'Consumidor Final', 'Fiscal', 'Gubernamental', 'Regimen Especial']

  return (
    <div className="flex gap-4 h-[calc(100vh-200px)] min-h-[540px]">
      {/* Left — Catalog */}
      <div className="flex-1 min-w-0 bg-slate-800/30 border border-slate-700/50 rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Catálogo</p>
        <div className="flex-1 min-h-0">
          <CatalogSearch onAdd={addItem} />
        </div>
      </div>

      {/* Right — Cart */}
      <div className="w-80 flex-shrink-0 bg-slate-800/30 border border-slate-700/50 rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Carrito</p>

        {/* Client */}
        <div className="space-y-2">
          <ClienteSearch clienteId={cliente?.id} onChange={setCliente} />
          {!cliente && (
            <input
              value={nombreWalkin}
              onChange={e => setNombreWalkin(e.target.value)}
              placeholder="Walk-in (nombre opcional)…"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          )}
        </div>

        {/* Lines */}
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 text-slate-600">
              <ShoppingBag size={24} className="mb-1.5" />
              <p className="text-xs font-mono">Vacío</p>
            </div>
          ) : cart.map((l, i) => (
            <CartLine key={i} linea={l} onChange={ch => updateLine(i, ch)} onRemove={() => removeLine(i)} />
          ))}
        </div>

        {/* Totals + options */}
        {cart.length > 0 && (
          <div className="border-t border-slate-700/50 pt-3 space-y-2">
            {canDescuento && (
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-slate-500">Desc. global %</label>
                  <input type="number" min="0" max="100" value={descGlobalPct}
                    onChange={e => setDescGlobalPct(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500" />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-slate-500">Desc. RD$</label>
                  <input type="number" min="0" value={descGlobalMonto}
                    onChange={e => setDescGlobalMonto(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500" />
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">ITBIS 18%</span>
              <button onClick={() => setApplyItbis(v => !v)}
                className={`w-9 h-5 rounded-full transition-colors ${applyItbis ? 'bg-blue-600' : 'bg-slate-700'}`}>
                <span className={`block w-4 h-4 rounded-full bg-white transition-transform mx-0.5 ${applyItbis ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
            <div>
              <label className="text-[10px] text-slate-500 block mb-0.5">Tipo NCF</label>
              <select value={tipoNcf} onChange={e => setTipoNcf(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-blue-500">
                {NCF_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-0.5 text-xs font-mono">
              <div className="flex justify-between text-slate-500"><span>Subtotal</span><span>RD$ {fmt(subtotal)}</span></div>
              {applyItbis && <div className="flex justify-between text-slate-500"><span>ITBIS</span><span>RD$ {fmt(itbisAmt)}</span></div>}
              <div className="flex justify-between text-slate-100 font-bold text-sm pt-1 border-t border-slate-700/50">
                <span>Total</span><span className="text-emerald-400">RD$ {fmt(total)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          {canCotizar && (
            <button onClick={() => submit(true)} disabled={submitting || !cart.length}
              className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-100 text-sm font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              Guardar Cotización
            </button>
          )}
          {canFacturar && (
            <button onClick={() => submit(false)} disabled={submitting || !cart.length}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 border border-blue-500 text-white text-sm font-bold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <ShoppingBag size={14} />}
              Generar Factura
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
