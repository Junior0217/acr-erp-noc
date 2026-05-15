import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search, Plus, Minus, Trash2, ShoppingBag, FileText, Tag, Loader2, X, User, ExternalLink,
  Wifi, Camera, Wrench, Zap, Package, Network, Boxes, GripVertical, Lock, KeyRound, Keyboard,
} from 'lucide-react'
import { apiFetch } from '@shared/utils/api'
import { useAuth } from '@shared/contexts/AuthContext'
import { useCart } from '@shared/contexts/CartContext'
import { useEmpresa } from '@shared/contexts/EmpresaContext'
import PinAuthModal from '@shared/components/PinAuthModal'
import { toast } from 'sonner'
import { marked } from 'marked'
// Native HTML5 DnD para catálogo → carrito. Más simple que @dnd-kit para
// un solo drop target y funciona perfecto en tablet/desktop sin overhead.
// dataTransfer transporta el JSON del item; el carrito hace addItem(item).

const fmt = v => Number(v ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Markdown ligero -> HTML para preview en modal de POS. Sin sanitización porque
// el contenido siempre lo escribe staff interno (descripcion del Producto/ItemCatalogo).
// Limitado a inline + listas básicas.
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false })
function mdToHtml(s) {
  if (!s) return ''
  try { return marked.parse(String(s)) } catch { return String(s) }
}

const CAT_ICON = {
  WISP:           { icon: Wifi,    color: 'text-cyan-400',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/30'    },
  CCTV:           { icon: Camera,  color: 'text-violet-400',  bg: 'bg-violet-500/10',  border: 'border-violet-500/30'  },
  ProyectoCCTV:   { icon: Camera,  color: 'text-purple-400',  bg: 'bg-purple-500/10',  border: 'border-purple-500/30'  },
  Redes:          { icon: Network, color: 'text-sky-400',     bg: 'bg-sky-500/10',     border: 'border-sky-500/30'     },
  CercoElectrico: { icon: Zap,     color: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30'  },
  VentaDirecta:   { icon: Boxes,   color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  SoporteTecnico: { icon: Wrench,  color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/30'    },
  Reparacion:     { icon: Wrench,  color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30'     },
  Mixto:          { icon: Package, color: 'text-slate-300',   bg: 'bg-slate-500/10',   border: 'border-slate-500/30'   },
}
const catMeta = cat => CAT_ICON[cat] ?? { icon: Package, color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/30' }

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

// ── ItemDetailModal ──────────────────────────────────────────────────────────
function ItemDetailModal({ item, onClose, onConfirm }) {
  const [qty, setQty] = useState(1)
  const meta = catMeta(item.categoria)
  const Icon = meta.icon
  const sinStock = item.tipo === 'VentaUnica' && (item.stock == null || item.stock <= 0)
  const stockBajo = item.tipo === 'VentaUnica' && item.stock != null && item.stock > 0 && qty > item.stock

  function confirmar() {
    if (sinStock) { toast.error('Sin stock disponible.'); return }
    if (stockBajo) { toast.error(`Solo ${item.stock} disponibles.`); return }
    onConfirm(item, qty)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full sm:max-w-md bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${meta.color} ${meta.bg} ${meta.border}`}>
              {item.categoria}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {item.tipo === 'VentaUnica' ? 'Artículo' : item.tipo === 'Servicio' ? 'Servicio' : 'Recurrente'}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto">
          {/* Hero / Image */}
          <div className={`mx-5 mt-5 h-64 rounded-xl overflow-hidden flex items-center justify-center border ${meta.border} ${meta.bg} relative`}>
            {item.imagenUrl ? (
              <img src={item.imagenUrl} alt={item.nombre} className="w-full h-full object-cover"
                onError={e => { e.currentTarget.style.display = 'none' }} />
            ) : (
              <Icon size={96} className={`${meta.color} opacity-50`} strokeWidth={1.1} />
            )}
            {item.sku && (
              <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-black/60 text-slate-200 backdrop-blur-sm">
                {item.sku}
              </span>
            )}
          </div>

          {/* Info */}
          <div className="px-5 py-4 space-y-3">
            <div>
              <h3 className="text-lg font-bold text-slate-100 leading-tight">{item.nombre}</h3>
              {item.descripcion && (
                <div className="text-xs text-slate-400 mt-2 leading-relaxed prose-pos"
                  dangerouslySetInnerHTML={{ __html: mdToHtml(item.descripcion) }} />
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Precio Unit.</p>
                <p className="text-xl font-bold font-mono text-emerald-400">RD$ {fmt(item.precio)}</p>
              </div>
              <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Disponibilidad</p>
                {item.tipo === 'VentaUnica' ? (
                  <p className={`text-xl font-bold font-mono ${sinStock ? 'text-red-400' : item.stock <= 5 ? 'text-amber-400' : 'text-slate-100'}`}>
                    {item.stock ?? 0} <span className="text-xs text-slate-500 font-normal">und.</span>
                  </p>
                ) : (
                  <p className="text-xl font-bold font-mono text-blue-300">∞</p>
                )}
              </div>
            </div>

            {sinStock && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> Sin stock disponible. No se puede vender.
              </div>
            )}

            {/* Qty selector */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Cantidad</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setQty(q => Math.max(1, q - 1))} disabled={sinStock}
                  className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors flex items-center justify-center disabled:opacity-40">
                  <Minus size={14} />
                </button>
                <input type="number" min="1" value={qty}
                  onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                  disabled={sinStock}
                  className="w-20 h-10 bg-slate-800 border border-slate-700 rounded-lg text-center text-sm font-mono text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40" />
                <button onClick={() => setQty(q => q + 1)} disabled={sinStock}
                  className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors flex items-center justify-center disabled:opacity-40">
                  <Plus size={14} />
                </button>
                <div className="ml-auto text-right">
                  <p className="text-[10px] text-slate-600 uppercase font-bold">Subtotal</p>
                  <p className="text-base font-bold font-mono text-emerald-400">RD$ {fmt(item.precio * qty)}</p>
                </div>
              </div>
              {stockBajo && (
                <p className="mt-1.5 text-xs text-amber-400 font-mono">⚠ Stock insuficiente. Máx: {item.stock}</p>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 p-4 border-t border-slate-800">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-sm font-semibold transition-colors">
            Cancelar
          </button>
          <button onClick={confirmar} disabled={sinStock || stockBajo}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 border border-blue-500 text-white text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-600/20">
            <ShoppingBag size={14} /> Agregar al Carrito
          </button>
        </div>
      </div>
    </div>
  )
}

// ── CatalogSearch ─────────────────────────────────────────────────────────────
function CatalogSearch({ onAdd }) {
  const [q, setQ]                 = useState('')
  const [items, setItems]         = useState([])
  const [loading, setLoading]     = useState(false)
  const [tab, setTab]             = useState('all') // all | articulos | servicios
  const [filtroCat, setFiltroCat] = useState('')
  const [detailItem, setDetailItem] = useState(null)

  const cargar = useCallback(async (query) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ activo: 'true' })
      if (query) p.set('search', query)
      const r = await apiFetch(`/api/catalogo?${p}`)
      const j = await r.json()
      setItems(j.data ?? [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => cargar(q), 250)
    return () => clearTimeout(t)
  }, [q, cargar])

  const matchTab = it => tab === 'articulos' ? (it.tipo === 'Recurrente' || it.tipo === 'VentaUnica')
                       : tab === 'servicios' ? it.tipo === 'Servicio'
                       : true
  const filtered = items.filter(it => matchTab(it) && (!filtroCat || it.categoria === filtroCat))
  const categoriasDisponibles = Array.from(new Set(items.filter(matchTab).map(it => it.categoria).filter(Boolean)))

  function handleConfirm(item, qty) {
    onAdd(item, qty)
    setDetailItem(null)
  }

  return (
    <div className="flex flex-col gap-2.5 h-full">
      {/* Tabs */}
      <div className="inline-flex bg-slate-900/60 border border-slate-700/60 rounded-xl p-1 gap-1 self-start">
        {[
          { id: 'all',       label: 'Todo'      },
          { id: 'articulos', label: 'Artículos' },
          { id: 'servicios', label: 'Servicios' },
        ].map(t => (
          <button key={t.id}
            onClick={() => { setTab(t.id); setFiltroCat('') }}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              tab === t.id
                ? 'bg-blue-600/20 text-blue-300 border border-blue-600/40'
                : 'text-slate-400 hover:text-slate-100 border border-transparent'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Buscar en catálogo…"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Category chips */}
      {categoriasDisponibles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setFiltroCat('')}
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border transition-all ${
              filtroCat === ''
                ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-200'
            }`}>
            Todas
          </button>
          {categoriasDisponibles.map(cat => (
            <button key={cat} onClick={() => setFiltroCat(cat === filtroCat ? '' : cat)}
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border transition-all ${
                filtroCat === cat
                  ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                  : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:text-slate-100'
              }`}>
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-blue-400" /></div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-xs text-slate-500 py-8 font-mono">Sin resultados.</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {filtered.map(item => {
              const meta = catMeta(item.categoria)
              const Icon = meta.icon
              // tipoItem ARTICULO consume stock; SERVICIO no. Si el item está vinculado
              // a un Producto físico (productoId), también validamos stock aunque sea VentaUnica.
              const esArticulo = item.tipoItem === 'ARTICULO' || (item.tipo === 'VentaUnica' && item.productoId)
              const sinStock = esArticulo && (item.stock == null || item.stock <= 0)
              // Preview de descripción: si es JSON v=1, muestra el título; si es markdown, strip.
              let descPreview = ''
              if (item.descripcion) {
                if (typeof item.descripcion === 'string' && item.descripcion.startsWith('{')) {
                  try { const o = JSON.parse(item.descripcion); if (o?.v === 1) descPreview = o.titulo ?? '' } catch {}
                }
                if (!descPreview) descPreview = String(item.descripcion).replace(/[*_`#-]/g, '').trim()
              }
              return (
                <button key={item.id}
                  onClick={() => setDetailItem(item)}
                  draggable={!sinStock}
                  onDragStart={e => {
                    if (sinStock) { e.preventDefault(); return }
                    try { e.dataTransfer.setData('application/x-acr-item', JSON.stringify(item)) } catch {}
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className={`group relative text-left bg-slate-800/40 hover:bg-slate-800/80 border ${meta.border} rounded-xl p-2.5 transition-all hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-600/10 flex flex-col gap-2 ${sinStock ? 'opacity-60' : 'cursor-grab active:cursor-grabbing'}`}>
                  {/* Badge tipoItem (esquina superior derecha) */}
                  <span className={`absolute top-1.5 right-1.5 z-10 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${
                    esArticulo
                      ? 'bg-blue-600/25 text-blue-300 border border-blue-500/40'
                      : 'bg-purple-600/25 text-purple-300 border border-purple-500/40'
                  }`}>
                    {esArticulo ? '📦 ART' : '🛠️ SVC'}
                  </span>
                  {item.esBundle && (
                    <span className="absolute top-1.5 left-1.5 z-10 inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-amber-600/25 text-amber-300 border border-amber-500/40">
                      ⊞ KIT
                    </span>
                  )}
                  <div className={`aspect-square w-full rounded-lg overflow-hidden flex items-center justify-center ${meta.bg}`}>
                    {item.imagenUrl ? (
                      <img src={item.imagenUrl} alt={item.nombre} className="w-full h-full object-cover"
                        onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.innerHTML = '' }} />
                    ) : (
                      <Icon size={36} className={`${meta.color}`} strokeWidth={1.4} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-100 leading-tight line-clamp-2">{item.nombre}</p>
                    {descPreview && (
                      <p className="text-[10px] text-slate-500 line-clamp-1 mt-0.5">{descPreview}</p>
                    )}
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs font-bold font-mono text-emerald-400">RD$ {fmt(item.precio)}</span>
                      {esArticulo ? (
                        <span className={`text-[9px] font-mono ${sinStock ? 'text-red-400' : item.stock <= 5 ? 'text-amber-400' : 'text-slate-500'}`}>
                          {sinStock ? 'Sin stock' : `Stk ${item.stock}`}
                        </span>
                      ) : (
                        <span className="text-[9px] font-mono text-purple-400">Sin stock</span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {detailItem && (
        <ItemDetailModal
          item={detailItem}
          onClose={() => setDetailItem(null)}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  )
}

// ── CrossSellBanner: tira INFERIOR con sugerencias + suppress dismissed ──────
// Se renderiza como strip horizontal pegada al borde inferior del POS, no
// encima del carrito. Si el usuario elimina un sugerido del carrito o cierra
// la propia tarjeta, lo agregamos a dismissedIds (persistido en sessionStorage)
// y no lo volvemos a sugerir mientras la sesión POS dure.
function CrossSellBanner({ cart, onAdd }) {
  const [sugerencias, setSugerencias] = useState([])
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('acr_pos_crosssell_dismiss') ?? '[]')) }
    catch { return new Set() }
  })
  const persistDismissed = (s) => {
    try { sessionStorage.setItem('acr_pos_crosssell_dismiss', JSON.stringify([...s])) } catch {}
  }
  function dismiss(productoId) {
    setDismissed(prev => { const n = new Set(prev); n.add(productoId); persistDismissed(n); return n })
  }

  useEffect(() => {
    if (!Array.isArray(cart) || cart.length === 0) { setSugerencias([]); return }
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const ids = cart.map(l => l.itemCatalogoId).filter(Boolean).slice(0, 6)
        if (ids.length === 0) { if (!cancel) setSugerencias([]); return }
        const responses = await Promise.allSettled(
          ids.map(id => apiFetch(`/api/catalogo/${id}/bundles`).then(r => r.ok ? r.json() : { data: [] }))
        )
        const all = []
        const seen = new Set()
        for (const r of responses) {
          if (r.status !== 'fulfilled') continue
          for (const b of (r.value.data ?? [])) {
            if (seen.has(b.id)) continue
            seen.add(b.id); all.push(b)
          }
        }
        const skusEnCarrito = new Set(cart.map(l => l.codigo).filter(Boolean))
        const filtered = all.filter(b => !skusEnCarrito.has(b.sku) && !dismissed.has(b.id))
        if (!cancel) setSugerencias(filtered.slice(0, 8))
      } catch {} finally { if (!cancel) setLoading(false) }
    })()
    return () => { cancel = true }
  }, [Array.isArray(cart) ? cart.length : 0, (Array.isArray(cart) ? cart : []).map(l => l.itemCatalogoId).join('|'), dismissed])

  if (!Array.isArray(cart) || cart.length === 0) return null
  if (sugerencias.length === 0 && !loading) return null

  return (
    <div className="bg-slate-900/80 border-t border-amber-700/30 px-4 py-2.5 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400 flex items-center gap-1.5">
          <Tag size={11} />Cross-sell sugerido
        </p>
        <span className="text-[9px] text-slate-600">Desliza →</span>
      </div>
      {loading ? (
        <div className="flex justify-center py-2"><Loader2 size={12} className="animate-spin text-amber-400" /></div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sugerencias.map(s => (
            <div key={s.id} className="relative flex-shrink-0 w-36 bg-slate-800/70 border border-slate-700 rounded-lg p-2">
              <button onClick={() => dismiss(s.id)} title="No mostrar más"
                className="absolute top-1 right-1 z-10 p-0.5 rounded bg-slate-900/60 text-slate-500 hover:text-red-400 transition-colors">
                <X size={9} />
              </button>
              <div className="aspect-square w-full rounded bg-slate-900 mb-1.5 overflow-hidden flex items-center justify-center">
                {s.imagenUrl
                  ? <img src={s.imagenUrl} alt={s.nombre} className="w-full h-full object-cover" />
                  : <Package size={20} className="text-slate-600" />}
              </div>
              <p className="text-[10px] font-semibold text-slate-100 line-clamp-2 leading-tight">{s.nombre}</p>
              <p className="text-[10px] font-mono text-emerald-400 mt-0.5">RD$ {fmt(s.precio)}</p>
              <button
                onClick={() => {
                  onAdd({ id: null, productoId: s.id, nombre: s.nombre, precio: s.precio, imagenUrl: s.imagenUrl, sku: s.sku })
                  dismiss(s.id)   // si lo agregaron, no insistir
                }}
                disabled={s.stockActual <= 0}
                className="w-full mt-1.5 px-2 py-1 rounded text-[10px] font-bold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40">
                {s.stockActual <= 0 ? 'Sin stock' : 'Agregar'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── CartLine ──────────────────────────────────────────────────────────────────
function CartLine({ linea, onChange, onRemove, descuentosUnlocked }) {
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
        {/* discount % — BLOQUEADO sin PIN supervisor (aplica a todos, incluyendo owner) */}
        <div className="flex items-center gap-1 text-xs text-slate-500" title={!descuentosUnlocked ? 'Bloqueado · requiere PIN supervisor' : ''}>
          {descuentosUnlocked ? <Tag size={10} /> : <Lock size={10} className="text-amber-400" />}
          <input
            type="number" min="0" max="100" step="1"
            value={pct}
            onChange={e => onChange({ descuentoPorcentaje: parseFloat(e.target.value) || 0 })}
            disabled={!descuentosUnlocked}
            className="w-12 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <span>%</span>
        </div>
      </div>
      <div className="text-right text-sm font-mono text-emerald-400 font-semibold">RD$ {fmt(subtotal)}</div>
    </div>
  )
}

// ── PanelPOS ──────────────────────────────────────────────────────────────────
export default function PanelPOS({ preloadItems = [], onClearPreload, onFacturaCreada }) {
  const { tienePermiso } = useAuth()
  const { empresa } = useEmpresa()
  // Límite dinámico desde EmpresaPerfil — el dueño configura en /empresa.
  const maxDescuentoCajero = Number(empresa?.maxDescuentoCajero ?? 15)
  // Carrito persistido en localStorage vía CartContext — sobrevive cambios de tab.
  const { posCart: cart, posAddItem, posUpdateLine, posRemoveLine, posClear } = useCart()
  const [cliente, setCliente]       = useState(null)
  const [nombreWalkin, setNombreWalkin] = useState('')
  const [applyItbis, setApplyItbis] = useState(true)
  const [descGlobalPct, setDescGlobalPct] = useState(0)
  const [descGlobalMonto, setDescGlobalMonto] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [lastFacturaId, setLastFacturaId] = useState(null)
  // Bloqueo de descuentos: por defecto LOCK. Se libera con PIN supervisor
  // y aplica a todos los usuarios (incluyendo sistema:owner). El bloqueo
  // se restaura al limpiar el carrito o al recargar el panel.
  const [descuentosUnlocked, setDescuentosUnlocked] = useState(false)
  const [pinSupervisorState, setPinSupervisorState] = useState('')
  const [pinModalOpen, setPinModalOpen] = useState(false)
  // Hotkeys "Cajero Express": F2 cliente · F3 catálogo · F4 PIN descuentos
  // F8 cotización · F9 facturar · ESC limpia preload del carrito
  const refClienteInput = useRef(null)
  const refCatalogoInput = useRef(null)
  const [hotkeysHint, setHotkeysHint] = useState(true)

  const prevPreload = useRef([])
  useEffect(() => {
    if (!preloadItems.length) return
    if (preloadItems === prevPreload.current) return
    prevPreload.current = preloadItems
    preloadItems.forEach(item => addItem(item))
    onClearPreload?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadItems])

  // POS Cajero Express — hotkeys nativas para reducir tiempo por transacción.
  // F2 cliente · F3 catálogo · F4 PIN descuentos · F8 cotización · F9 facturar.
  // Ignora si el foco está en un input/textarea (excepto F4 que SIEMPRE abre PIN).
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase()
      const inField = tag === 'input' || tag === 'textarea' || tag === 'select'
      if (e.key === 'F4') {
        e.preventDefault()
        if (!descuentosUnlocked) setPinModalOpen(true)
        return
      }
      if (inField) return
      // F2 → busca input del cliente. F3 → busca input del catálogo. Si no
      // encuentra, noop (los componentes hijos pueden re-ordenarse sin romper).
      if (e.key === 'F2') {
        e.preventDefault()
        const el = document.querySelector('input[placeholder*="cliente" i], input[placeholder*="rnc" i]')
        el?.focus?.()
      }
      else if (e.key === 'F3') {
        e.preventDefault()
        const el = document.querySelector('input[placeholder*="producto" i], input[placeholder*="catálogo" i]')
        el?.focus?.()
      }
      else if (e.key === 'F8' && canCotizar && cart.length) { e.preventDefault(); submit(true) }
      else if (e.key === 'F9' && canFacturar && cart.length) { e.preventDefault(); setShowCheckout(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.length, descuentosUnlocked, canCotizar, canFacturar])

  // Re-lock descuentos cuando se limpia el carrito (después de venta exitosa).
  useEffect(() => {
    if (!cart.length) {
      setDescuentosUnlocked(false)
      setPinSupervisorState('')
      setDescGlobalPct(0)
      setDescGlobalMonto(0)
    }
  }, [cart.length])

  const canCotizar  = tienePermiso('pos:cotizar')  || tienePermiso('sistema:owner')
  const canFacturar = tienePermiso('pos:facturar') || tienePermiso('sistema:owner')
  // canDescuento removido: el descuento ya no se gate por PERMISO sino por
  // PIN supervisor. Cualquier rol con pos:facturar puede aplicar descuento
  // SI tiene el PIN — incluyendo el owner.

  function addItem(item, qty = 1) {
    posAddItem(item, qty)
    toast.success(`${item.nombre} × ${qty}`, { duration: 1500 })
  }
  function updateLine(idx, changes) { posUpdateLine(idx, changes) }
  function removeLine(idx)          { posRemoveLine(idx) }

  const efectivoUnitario = (pu, pct, mon) => Math.max(0, pu * (1 - (pct ?? 0) / 100) - (mon ?? 0))
  const subtotalBruto = (Array.isArray(cart) ? cart : []).reduce((s, l) => s + efectivoUnitario(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto) * l.cantidad, 0)
  const globalDesc    = descGlobalPct > 0 ? subtotalBruto * (descGlobalPct / 100) : Math.min(descGlobalMonto, subtotalBruto)
  const subtotal      = Math.round((subtotalBruto - globalDesc) * 100) / 100
  const itbisAmt      = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  const total         = Math.round((subtotal + itbisAmt) * 100) / 100
  // Trigger del PIN: descuento global > maxDescuentoCajero requiere PIN supervisor.
  const necesitaPIN  = descGlobalPct > maxDescuentoCajero
  const [showCheckout, setShowCheckout] = useState(false)

  async function submit(esCotizacion, opts = {}) {
    const { pagos = null, pinSupervisor = null } = opts
    if (!cart.length) { toast.error('El carrito está vacío.'); return }
    // Validación dura: cliente o walk-in obligatorio. Antes pasaba con ambos
    // null y dejaba la factura sin contraparte identificable.
    if (!cliente && !nombreWalkin.trim()) {
      toast.error('Selecciona un cliente o ingresa un nombre de contacto antes de continuar.')
      return
    }
    const requiredPerm = esCotizacion ? 'pos:cotizar' : 'pos:facturar'
    if (!tienePermiso(requiredPerm) && !tienePermiso('sistema:owner')) {
      toast.error(`Sin permiso: ${requiredPerm}`); return
    }
    setSubmitting(true)
    try {
      const pinFinal = pinSupervisor || pinSupervisorState || null
      const body = {
        clienteId:            cliente?.id ?? undefined,
        nombreTemporal:       !cliente && nombreWalkin ? nombreWalkin : undefined,
        // tipoNcf eliminado del UI: backend deriva de cliente.tipoNCF.
        applyItbis,
        esCotizacion,
        descuentoGlobalPct:   descGlobalPct,
        descuentoGlobalMonto: descGlobalMonto,
        ...(pinFinal ? { pinSupervisor: pinFinal } : {}),
        ...(pagos ? { pagos } : {}),
        lineas: (Array.isArray(cart) ? cart : []).map(l => ({
          // Backend exige exactly-one-of: itemCatalogoId (UUID) o productoId (Int).
          ...(l.itemCatalogoId ? { itemCatalogoId: l.itemCatalogoId } : { productoId: l.productoId }),
          cantidad:            l.cantidad,
          precioUnitario:      l.precioUnitario,
          descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
          descuentoMonto:      l.descuentoMonto ?? 0,
        })),
      }
      const r = await apiFetch('/api/pos/venta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok) {
        if (j.code === 'PIN_REQUIRED') { toast.error('PIN supervisor inválido o faltante.'); return { needPin: true } }
        toast.error(j.error ?? 'Error.'); return
      }
      toast.success(esCotizacion ? `Cotización ${j.noFactura} guardada.` : `Factura ${j.noFactura} emitida.`)
      if (!esCotizacion) setLastFacturaId(j.id)
      posClear()
      setCliente(null)
      setNombreWalkin('')
      setDescGlobalPct(0)
      setDescGlobalMonto(0)
      setShowCheckout(false)
      return { ok: true }
    } finally { setSubmitting(false) }
  }

  // NCF_TYPES removido: el comprobante se infiere del cliente. Sin selector manual.

  return (
    <div className="flex flex-col gap-2 h-[calc(100vh-180px)] min-h-[540px]">
    {hotkeysHint && (
      <div className="flex items-center justify-between bg-slate-900/60 border border-slate-700/40 rounded-lg px-3 py-1.5 text-[11px] text-slate-400">
        <div className="flex items-center gap-2 overflow-x-auto">
          <Keyboard size={12} className="text-blue-400 flex-shrink-0" />
          <span className="font-mono">
            <kbd className="px-1 py-0.5 bg-slate-800 rounded">F2</kbd> Cliente ·{' '}
            <kbd className="px-1 py-0.5 bg-slate-800 rounded">F3</kbd> Catálogo ·{' '}
            <kbd className="px-1 py-0.5 bg-slate-800 rounded">F4</kbd> Autorizar Desc. ·{' '}
            <kbd className="px-1 py-0.5 bg-slate-800 rounded">F8</kbd> Cotización ·{' '}
            <kbd className="px-1 py-0.5 bg-slate-800 rounded">F9</kbd> Facturar
          </span>
        </div>
        <button onClick={() => setHotkeysHint(false)} className="text-slate-600 hover:text-slate-300 flex-shrink-0 ml-2">
          <X size={12} />
        </button>
      </div>
    )}
    <div className="flex gap-4 flex-1 min-h-0">
      {/* Left — Catálogo + sugerencias (cross-sell pegado a la base) */}
      <div className="flex-1 min-w-0 bg-slate-800/30 border border-slate-700/50 rounded-2xl flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 p-4 flex flex-col gap-3">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Catálogo</p>
          <div className="flex-1 min-h-0">
            <CatalogSearch onAdd={addItem} />
          </div>
        </div>
        {/* Cross-sell tira inferior — no tapa el carrito ni la búsqueda */}
        <CrossSellBanner cart={cart} onAdd={addItem} />
      </div>

      {/* Right — Carrito (drop target + más ancho en monitores grandes) */}
      <div
        onDragOver={e => {
          if (Array.from(e.dataTransfer.types ?? []).includes('application/x-acr-item')) {
            e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
            e.currentTarget.dataset.dragHover = 'true'
          }
        }}
        onDragLeave={e => { delete e.currentTarget.dataset.dragHover }}
        onDrop={e => {
          e.preventDefault(); delete e.currentTarget.dataset.dragHover
          try {
            const raw = e.dataTransfer.getData('application/x-acr-item')
            if (!raw) return
            const item = JSON.parse(raw)
            if (item) { addItem(item, 1) }
          } catch {}
        }}
        className="w-80 lg:w-96 xl:w-[26rem] 2xl:w-[30rem] flex-shrink-0 bg-slate-800/30 border border-slate-700/50 rounded-2xl p-4 flex flex-col gap-3 transition-all data-[drag-hover=true]:border-blue-500 data-[drag-hover=true]:bg-blue-900/20 data-[drag-hover=true]:ring-2 data-[drag-hover=true]:ring-blue-500/30">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          Carrito
          <span className="text-[9px] font-normal text-slate-600 normal-case tracking-normal">(arrastra desde el catálogo o clic)</span>
        </p>

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
          ) : (Array.isArray(cart) ? cart : []).map((l, i) => (
            <CartLine key={i} linea={l} onChange={ch => updateLine(i, ch)} onRemove={() => removeLine(i)} descuentosUnlocked={descuentosUnlocked} />
          ))}
        </div>

        {/* Totals + options */}
        {cart.length > 0 && (
          <div className="border-t border-slate-700/50 pt-3 space-y-2">
            {/* Descuentos bloqueados por defecto · click "Autorizar" → PIN supervisor */}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-slate-500 flex items-center gap-1">
                  Desc. global % {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}
                </label>
                <input type="number" min="0" max="100" value={descGlobalPct}
                  onChange={e => setDescGlobalPct(parseFloat(e.target.value) || 0)}
                  disabled={!descuentosUnlocked}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-slate-500 flex items-center gap-1">
                  Desc. RD$ {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}
                </label>
                <input type="number" min="0" value={descGlobalMonto}
                  onChange={e => setDescGlobalMonto(parseFloat(e.target.value) || 0)}
                  disabled={!descuentosUnlocked}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
              </div>
              {!descuentosUnlocked && (
                <button onClick={() => setPinModalOpen(true)}
                  title="Autorizar descuentos (F4)"
                  className="h-7 px-2 rounded text-[10px] font-bold bg-amber-600/20 text-amber-400 border border-amber-600/40 hover:bg-amber-600/40 transition-colors flex items-center gap-1">
                  <KeyRound size={10} /> F4
                </button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">ITBIS 18%</span>
              <button onClick={() => setApplyItbis(v => !v)}
                className={`w-9 h-5 rounded-full transition-colors ${applyItbis ? 'bg-blue-600' : 'bg-slate-700'}`}>
                <span className={`block w-4 h-4 rounded-full bg-white transition-transform mx-0.5 ${applyItbis ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
            {/* Selector "Tipo NCF" eliminado: el comprobante se infiere del
                cliente seleccionado (cliente.tipoNCF), o del default fiscal
                cuando es walk-in. Cero ambigüedad para el cajero. */}
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
          {lastFacturaId && !cart.length && onFacturaCreada && (
            <button onClick={() => onFacturaCreada(lastFacturaId)}
              className="w-full py-2.5 rounded-xl bg-emerald-700/30 hover:bg-emerald-700/50 border border-emerald-600/40 text-emerald-400 text-sm font-semibold transition-all flex items-center justify-center gap-2">
              <ExternalLink size={14} />Ver factura generada
            </button>
          )}
          {canCotizar && (
            <button onClick={() => submit(true)} disabled={submitting || !cart.length}
              className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-100 text-sm font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              Guardar Cotización
            </button>
          )}
          {canFacturar && (
            <button onClick={() => setShowCheckout(true)} disabled={submitting || !cart.length}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 border border-blue-500 text-white text-sm font-bold transition-all disabled:opacity-40 flex items-center justify-center gap-2">
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <ShoppingBag size={14} />}
              Cobrar / Facturar
            </button>
          )}
        </div>
      </div>
      </div>

      {showCheckout && (
        <CheckoutModal
          total={total}
          necesitaPIN={necesitaPIN}
          descuentoPct={descGlobalPct}
          maxPct={maxDescuentoCajero}
          submitting={submitting}
          onClose={() => setShowCheckout(false)}
          onSubmit={(pagos, pinSupervisor) => submit(false, { pagos, pinSupervisor })}
        />
      )}

      <PinAuthModal
        open={pinModalOpen}
        onClose={() => setPinModalOpen(false)}
        titulo="Autorizar Descuentos"
        descripcion="Habilita los campos de descuento global y descuento por línea para esta sesión de POS. Requiere el PIN de supervisor configurado en Mi Empresa."
        onUnlock={(pin) => {
          setPinSupervisorState(pin)
          setDescuentosUnlocked(true)
          toast.success('Descuentos habilitados para esta sesión.')
        }}
      />
    </div>
  )
}

// ── CheckoutModal: cobro mixto + PIN supervisor ──────────────────────────────
function CheckoutModal({ total, necesitaPIN, descuentoPct, maxPct = 15, submitting, onClose, onSubmit }) {
  const [pagos, setPagos] = useState([{ metodo: 'Efectivo', monto: total, refer: '' }])
  const [pinSupervisor, setPinSupervisor] = useState('')
  const [showPin, setShowPin] = useState(false)
  const sumaPagos = (Array.isArray(pagos) ? pagos : []).reduce((s, p) => s + (Number(p.monto) || 0), 0)
  const diff = Math.round((total - sumaPagos) * 100) / 100
  const sumaOk = Math.abs(diff) < 0.01
  const puedeFacturar = sumaOk && (!necesitaPIN || pinSupervisor.trim().length >= 4)

  function addPago()        { setPagos(p => [...(Array.isArray(p) ? p : []), { metodo: 'Transferencia', monto: Math.max(diff, 0), refer: '' }]) }
  function removePago(i)    { setPagos(p => (Array.isArray(p) ? p : []).filter((_, idx) => idx !== i)) }
  function updatePago(i, c) { setPagos(p => (Array.isArray(p) ? p : []).map((row, idx) => idx === i ? { ...row, ...c } : row)) }

  async function confirmar() {
    const r = await onSubmit((Array.isArray(pagos) ? pagos : []).map(p => ({ ...p, monto: Number(p.monto) })), pinSupervisor || null)
    if (r?.needPin) { setShowPin(true); setPinSupervisor('') }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">Cobro / Facturar</h2>
            <p className="text-[10px] text-slate-500 font-mono mt-0.5">Total: RD$ {fmt(total)}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {necesitaPIN && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-900/20 border border-amber-700/40 text-xs text-amber-300">
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 bg-amber-400 flex-shrink-0" />
              <span>Descuento <strong>{descuentoPct}%</strong> excede el límite ({maxPct}%). Requiere PIN de supervisor para autorizar.</span>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Métodos de pago</p>
              <button onClick={addPago} className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1">
                <Plus size={11} /> Agregar
              </button>
            </div>
            <div className="space-y-2">
              {(Array.isArray(pagos) ? pagos : []).map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select value={p.metodo} onChange={e => updatePago(i, { metodo: e.target.value })}
                    className="flex-shrink-0 w-32 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500">
                    {['Efectivo','Transferencia','Tarjeta','Cheque','Otro'].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input type="number" min="0" step="0.01" value={p.monto}
                    onChange={e => updatePago(i, { monto: e.target.value })}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-blue-500" />
                  <input type="text" placeholder="Ref" value={p.refer}
                    onChange={e => updatePago(i, { refer: e.target.value })}
                    className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[10px] text-slate-100 focus:outline-none focus:border-blue-500" />
                  {pagos.length > 1 && (
                    <button onClick={() => removePago(i)} className="text-slate-600 hover:text-red-400"><Trash2 size={12} /></button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-3 space-y-1">
            <div className="flex justify-between text-xs"><span className="text-slate-500">Total a cobrar</span><span className="font-mono font-bold text-slate-100">RD$ {fmt(total)}</span></div>
            <div className="flex justify-between text-xs"><span className="text-slate-500">Cubierto por pagos</span><span className="font-mono text-slate-200">RD$ {fmt(sumaPagos)}</span></div>
            <div className={`flex justify-between text-xs pt-1 border-t border-slate-700 ${sumaOk ? 'text-emerald-400' : Math.abs(diff) > 0 ? 'text-red-400' : 'text-slate-400'}`}>
              <span>{diff > 0 ? 'Falta' : diff < 0 ? 'Excede' : 'Cuadrado ✓'}</span>
              <span className="font-mono font-bold">RD$ {fmt(Math.abs(diff))}</span>
            </div>
          </div>

          {necesitaPIN && (
            <div>
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">PIN de Supervisor</label>
              <input type="password" inputMode="numeric" autoComplete="off" maxLength={8}
                value={pinSupervisor} onChange={e => setPinSupervisor(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                className="w-full bg-slate-800 border border-amber-700/40 rounded-lg px-3 py-2 text-sm font-mono text-center tracking-[0.4em] text-slate-100 focus:outline-none focus:border-amber-500" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            Cancelar
          </button>
          <button onClick={confirmar} disabled={!puedeFacturar || submitting}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40 shadow-md shadow-blue-600/30">
            {submitting ? <Loader2 size={12} className="animate-spin" /> : <ShoppingBag size={12} />}
            Emitir Factura
          </button>
        </div>
      </div>
    </div>
  )
}
