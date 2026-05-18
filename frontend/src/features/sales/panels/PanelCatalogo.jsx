import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import {
  Plus, Search, Pencil, Loader2, Save, X, CheckCircle, XCircle, RefreshCw, ShoppingBag,
  Wrench, Package, Layers, Link2, Unlink, Image as ImageIcon,
} from 'lucide-react'
import { apiFetch } from '@shared/utils/api'
// ImageDropzone removido: la foto vive solo en Inventario → Producto (single
// source of truth). Catálogo lee imagenUrl pero no la edita.
import EditorDescripcion from '@shared/components/EditorDescripcion'

// Parse descripcion legacy/JSON para el editor estructurado.
function _descParse(raw) {
  if (!raw) return null
  if (typeof raw === 'string' && raw.length > 1 && raw[0] === '{') {
    try { const o = JSON.parse(raw); if (o?.v === 1) return o } catch {}
  }
  return raw   // legacy markdown string queda como string
}
import {
  TIPOS, CATEGORIAS,
  TH, LABEL_CLS, INPUT_CLS, SELECT_CLS,
  formatCurrency,
  TipoBadge, CatBadge,
} from './_shared'

// ── ItemModal ─────────────────────────────────────────────────────────────────

function ProductoSearchInput({ value, onChange, productoActual }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!q.trim() || q.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const r = await apiFetch(`/api/inventario/productos?search=${encodeURIComponent(q)}&limit=10`)
        const j = await r.json()
        setResults(j.data ?? [])
      } catch {} finally { setBusy(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (value && productoActual) {
    return (
      <div className="flex items-center justify-between p-3 bg-emerald-900/20 border border-emerald-700/40 rounded-lg">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-600/15 border border-emerald-600/30 flex items-center justify-center flex-shrink-0">
            <Link2 size={14} className="text-emerald-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-100 truncate">{productoActual.nombre}</p>
            <p className="text-[10px] font-mono text-emerald-300 truncate">SKU {productoActual.sku} · Stock: {productoActual.stockActual}</p>
          </div>
        </div>
        <button onClick={() => onChange(null)} type="button"
          className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-red-300 transition-colors flex-shrink-0">
          <Unlink size={11} /> Desvincular
        </button>
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder="Buscar producto físico por nombre o SKU…"
        className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
      />
      {busy && <Loader2 size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-400 animate-spin" />}
      {open && q.length >= 2 && results.length > 0 && (
        <div className="absolute z-30 left-0 right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden max-h-60 overflow-y-auto">
          {results.map(p => (
            <button key={p.id} type="button"
              onMouseDown={() => { onChange(p.id, p); setQ(''); setResults([]); setOpen(false) }}
              className="w-full text-left px-3 py-2 hover:bg-slate-700 transition-colors border-b border-slate-700/30 last:border-0">
              <div className="text-xs font-semibold text-slate-100">{p.nombre}</div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                SKU {p.sku} · Stock: <span className={p.stockActual <= 0 ? 'text-red-400' : 'text-emerald-400'}>{p.stockActual}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && q.length >= 2 && !busy && results.length === 0 && (
        <div className="absolute z-30 left-0 right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-500">
          Sin resultados. El item quedará SIN vínculo (stock manual).
        </div>
      )}
    </div>
  )
}

function ItemModal({ item, canSeeCosts, onClose, onSaved }) {
  // tipoItem default: si tipo='Servicio' o 'Recurrente' → SERVICIO. Si VentaUnica → ARTICULO.
  // El usuario puede sobreescribir explícitamente en el form.
  const empty = { nombre: '', descripcion: null, imagenUrl: '', tipo: 'Recurrente', categoria: 'WISP', precio: '', costo: '0', stock: '', productoId: null, planId: null, activo: true, tipoItem: 'SERVICIO', esBundle: false }
  const [form, setForm] = useState(
    item
      ? { ...item, precio: String(item.precio), costo: String(item.costo ?? 0), stock: item.stock != null ? String(item.stock) : '', imagenUrl: item.imagenUrl ?? '', productoId: item.productoId ?? null, planId: item.planId ?? null, descripcion: _descParse(item.descripcion), tipoItem: item.tipoItem ?? 'SERVICIO', esBundle: !!item.esBundle }
      : empty
  )
  // Mejora #15: lista de Planes ISP para vincular. Carga 1 vez al abrir.
  const [planes, setPlanes] = useState([])
  useEffect(() => {
    let cancel = false
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/planes?activo=true&limit=200`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => { if (!cancel) setPlanes(Array.isArray(j.data) ? j.data : []) })
      .catch(() => {})
    return () => { cancel = true }
  }, [])
  // El producto físico actual (para mostrar nombre/stock en el badge). Se hidrata
  // si el item ya está vinculado o se setea al seleccionar uno nuevo.
  const [productoActual, setProductoActual] = useState(item?.producto ?? null)
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function save() {
    if (!form.nombre.trim()) return setErr('Nombre requerido.')
    if (!form.precio || isNaN(parseFloat(form.precio))) return setErr('Precio inválido.')
    setSaving(true); setErr('')
    try {
      const body = {
        nombre:      form.nombre.trim(),
        descripcion: form.descripcion ?? null,        // objeto v=1 o string legacy
        imagenUrl:   form.imagenUrl || null,
        tipo:        form.tipo,
        categoria:   form.categoria,
        tipoItem:    form.tipoItem,
        esBundle:    form.esBundle,
        precio:      parseFloat(form.precio),
        ...(canSeeCosts ? { costo: parseFloat(form.costo) || 0 } : {}),
        stock:       form.tipoItem === 'ARTICULO' && form.stock !== '' && !form.productoId ? parseInt(form.stock) : null,
        productoId:  form.productoId ?? null,
        planId:      form.planId ?? null,
        activo:      form.activo,
      }
      const r = await apiFetch(item ? `/api/catalogo/${item.id}` : '/api/catalogo', {
        method: item ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      })
      if (!r.ok) { const j = await r.json(); setErr(j.error ?? 'Error al guardar.'); return }
      toast.success(item ? 'Item actualizado.' : 'Item creado.')
      onSaved()
    } catch { setErr('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700/50 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 flex-shrink-0">
          <h2 className="text-sm font-bold text-slate-100">{item ? 'Editar Item del Catálogo' : 'Nuevo Item del Catálogo'}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <div>
            <label className={LABEL_CLS}>Nombre *</label>
            <input value={form.nombre} onChange={e => set('nombre', e.target.value)}
              placeholder="Ej. Plan WISP 25Mbps · Cámara Hikvision 4MP"
              className={INPUT_CLS} />
          </div>

          <div>
            <label className={LABEL_CLS}>Descripción Comercial</label>
            <EditorDescripcion
              value={form.descripcion}
              onChange={v => set('descripcion', v)}
              mostrarImagen={false}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Naturaleza del item *</label>
              <select value={form.tipoItem} onChange={e => set('tipoItem', e.target.value)} className={SELECT_CLS}>
                <option value="SERVICIO">🛠️ Servicio (sin stock)</option>
                <option value="ARTICULO">📦 Artículo Físico (con stock)</option>
              </select>
              <p className="text-[10px] text-slate-600 mt-1 leading-tight">
                {form.tipoItem === 'SERVICIO' ? 'No consume inventario. Cantidad libre en factura.' : 'Consume stock. Vincúlalo a un Producto físico para Kardex.'}
              </p>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.esBundle} onChange={e => set('esBundle', e.target.checked)}
                  className="w-4 h-4 accent-blue-600" />
                <span>Es un Bundle (kit con BOM)</span>
              </label>
            </div>
          </div>

          {/* Imagen del Catálogo: SOURCE OF TRUTH = Inventario (Producto.imagenUrl).
              Single source of truth: la foto vive en el Producto físico (o en el
              registro de Servicios). Aquí mostramos solo preview de lo que se
              renderiza al cliente. Para SUBIR/CAMBIAR una imagen:
                · Item con productoId → editar en Inventario → Producto.
                · Item sin productoId (servicio puro) → editar en Servicios.
              Antes había un ImageDropzone aquí que permitía colocar una foto
              distinta a la del Producto → drift visual (Inventario decía "X" y
              Catálogo decía "Y"). Eliminado por política de single source. */}
          <div className="rounded-lg border border-slate-700/40 bg-slate-900/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-slate-200">Imagen del Item</p>
                <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                  La foto vive en <strong>Inventario → Producto</strong> (o Servicios).
                  El Catálogo solo la lee — no la edita.
                </p>
              </div>
              {form.imagenUrl ? (
                <img src={form.imagenUrl} alt="Preview" className="h-16 w-16 object-cover rounded border border-slate-700" />
              ) : (
                <span className="text-[10px] text-slate-600 italic">— sin imagen —</span>
              )}
            </div>
          </div>

          {/* Vínculo con producto físico (sincroniza stock + imagen del inventario) */}
          <div>
            <label className={LABEL_CLS}>Vínculo con Producto Físico (Inventario)</label>
            <ProductoSearchInput
              value={form.productoId}
              productoActual={productoActual}
              onChange={(pid, prod) => { set('productoId', pid); setProductoActual(prod ?? null) }}
            />
            <div className={`mt-2 px-3 py-2 rounded-lg text-[11px] flex items-start gap-2 ${form.productoId ? 'bg-emerald-900/20 border border-emerald-700/30 text-emerald-300' : 'bg-amber-900/15 border border-amber-700/30 text-amber-300'}`}>
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-current" />
              {form.productoId ? (
                <span>El stock se lee del <strong>Producto físico</strong> (Inventario). Cualquier venta POS descuenta del kardex automáticamente.</span>
              ) : (
                <span>Sin vínculo → el stock se gestiona manualmente en este item. Recomendado vincular si el ítem corresponde a algo físico para evitar drift.</span>
              )}
            </div>
          </div>

          {/* Mejora #15: Vínculo con Plan ISP. Si seteado, al facturar este
              item el POS auto-crea un Servicio activo para el cliente con
              precio derivado del Plan. Útil solo para tipoItem=SERVICIO. */}
          <div>
            <label className={LABEL_CLS}>Vínculo con Plan ISP (auto-crea Servicio al facturar)</label>
            <select
              value={form.planId ?? ''}
              onChange={e => set('planId', e.target.value || null)}
              className={INPUT_CLS + ' font-mono'}
            >
              <option value="">— Sin vínculo —</option>
              {planes.map(p => (
                <option key={p.id} value={p.id}>
                  {p.sku ? `${p.sku} · ` : ''}{p.nombre} · {p.tipo} · RD$ {Number(p.precioMensualBase || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}/mes
                </option>
              ))}
            </select>
            <div className={`mt-2 px-3 py-2 rounded-lg text-[11px] flex items-start gap-2 ${form.planId ? 'bg-blue-900/20 border border-blue-700/30 text-blue-300' : 'bg-slate-800/40 border border-slate-700/30 text-slate-500'}`}>
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-current" />
              {form.planId ? (
                <span>Al facturar este ítem desde POS, se crea automáticamente un <strong>Servicio Pendiente</strong> para el cliente. Dedup por (cliente, plan).</span>
              ) : (
                <span>Sin vínculo a Plan ISP. Facturarlo NO genera Servicio activo en el módulo Servicios.</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Tipo *</label>
              <select value={form.tipo} onChange={e => set('tipo', e.target.value)} className={SELECT_CLS}>
                {TIPOS.map(t => <option key={t} value={t}>{t === 'VentaUnica' ? 'Venta Única' : t}</option>)}
              </select>
              <p className="text-[10px] text-slate-600 mt-1 leading-tight">
                {form.tipo === 'Recurrente' ? 'Factura mensual automática' : form.tipo === 'VentaUnica' ? 'Factura única al entregar' : 'Mano de obra / visita técnica'}
              </p>
            </div>
            <div>
              <label className={LABEL_CLS}>Categoría *</label>
              <select value={form.categoria} onChange={e => set('categoria', e.target.value)} className={SELECT_CLS}>
                {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className={`grid gap-3 ${canSeeCosts ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <div>
              <label className={LABEL_CLS}>Precio (DOP) *</label>
              <input type="number" min="0" step="0.01" value={form.precio} onChange={e => set('precio', e.target.value)}
                placeholder="0.00" className={INPUT_CLS} />
            </div>
            {canSeeCosts && (
              <div>
                <label className={LABEL_CLS}>Costo (DOP)</label>
                <input type="number" min="0" step="0.01" value={form.costo} onChange={e => set('costo', e.target.value)}
                  placeholder="0.00" className={INPUT_CLS} />
              </div>
            )}
          </div>

          {form.tipoItem === 'ARTICULO' && !form.productoId && (
            <div>
              <label className={LABEL_CLS}>Stock manual (unidades)</label>
              <input type="number" min="0" value={form.stock} onChange={e => set('stock', e.target.value)}
                placeholder="Dejar vacío si no aplica" className={INPUT_CLS} />
              <p className="text-[10px] text-slate-600 mt-1">Solo si NO está vinculado a un producto físico.</p>
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-slate-400">Activo</span>
            <button type="button" onClick={() => set('activo', !form.activo)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.activo ? 'bg-blue-600' : 'bg-slate-700'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${form.activo ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {err && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />{err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-slate-400 hover:text-slate-100 text-sm font-medium transition-colors">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {item ? 'Guardar Cambios' : 'Crear Item'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── PanelCatalogo ─────────────────────────────────────────────────────────────

// 'all' | 'servicios' (tipo=Servicio) | 'articulos' (tipo=Recurrente|VentaUnica)
const TABS = [
  { id: 'all',        label: 'Todos',     icon: Layers,  match: () => true },
  { id: 'articulos',  label: 'Artículos', icon: Package, match: t => t === 'Recurrente' || t === 'VentaUnica' },
  { id: 'servicios',  label: 'Servicios', icon: Wrench,  match: t => t === 'Servicio' },
]

export default function PanelCatalogo({ canEdit, canSeeCosts, canSeePrecio = true, canSeeMargen = false, canPOS, onSellNow }) {
  const [items,           setItems]           = useState([])
  const [loading,         setLoading]         = useState(false)
  const [search,          setSearch]          = useState('')
  const [tab,             setTab]             = useState('all')
  const [filtroCategoria, setFiltroCategoria] = useState('')
  const [filtroActivo,    setFiltroActivo]    = useState('true')
  const [modalItem,       setModalItem]       = useState(null)
  const [detalle,         setDetalle]         = useState(null)

  const fetchCatalogo = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroCategoria) p.set('categoria', filtroCategoria)
      if (filtroActivo)    p.set('activo',    filtroActivo)
      if (search)          p.set('search',    search)
      const r = await apiFetch(`/api/catalogo?${p}`)
      if (r.ok) { const j = await r.json(); setItems(j.data ?? []) }
    } catch {}
    finally { setLoading(false) }
  }, [filtroCategoria, filtroActivo, search])

  useEffect(() => { fetchCatalogo() }, [fetchCatalogo])

  const tabMatcher = TABS.find(t => t.id === tab)?.match ?? (() => true)
  const itemsFiltrados = useMemo(() => items.filter(it => tabMatcher(it.tipo)), [items, tabMatcher])

  const categoriasDisponibles = useMemo(() => {
    const set = new Set()
    items.filter(it => tabMatcher(it.tipo)).forEach(it => it.categoria && set.add(it.categoria))
    return CATEGORIAS.filter(c => set.has(c))
  }, [items, tabMatcher])

  const counts = useMemo(() => ({
    all:       items.length,
    articulos: items.filter(it => it.tipo === 'Recurrente' || it.tipo === 'VentaUnica').length,
    servicios: items.filter(it => it.tipo === 'Servicio').length,
  }), [items])

  async function toggleActivo(item) {
    try {
      const r = await apiFetch(`/api/catalogo/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...item, precio: Number(item.precio), costo: Number(item.costo) || 0, activo: !item.activo }),
      })
      if (r.ok) { toast.success(`Item ${!item.activo ? 'activado' : 'desactivado'}.`); fetchCatalogo() }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="inline-flex bg-slate-900/60 border border-slate-700/60 rounded-xl p-1 gap-1">
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.id
            const count = counts[t.id]
            return (
              <button key={t.id}
                onClick={() => { setTab(t.id); setFiltroCategoria('') }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  active
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-600/40 shadow-inner'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}>
                <Icon size={13} />{t.label}
                <span className={`ml-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono ${active ? 'bg-blue-600/30 text-blue-200' : 'bg-slate-800/80 text-slate-500'}`}>{count}</span>
              </button>
            )
          })}
        </div>
        {canEdit && (
          <button onClick={() => setModalItem(false)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap">
            <Plus size={16} />Nuevo Item
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nombre…"
            className="pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-52 transition-colors" />
        </div>
        <select value={filtroActivo} onChange={e => setFiltroActivo(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
          <option value="">Todos los estados</option>
          <option value="true">Activos</option>
          <option value="false">Inactivos</option>
        </select>
        <button onClick={fetchCatalogo} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {categoriasDisponibles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setFiltroCategoria('')}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${
              filtroCategoria === ''
                ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-200 hover:border-slate-600'
            }`}>
            Todas
          </button>
          {categoriasDisponibles.map(cat => (
            <button key={cat} onClick={() => setFiltroCategoria(cat === filtroCategoria ? '' : cat)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${
                filtroCategoria === cat
                  ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                  : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:text-slate-100 hover:border-slate-600'
              }`}>
              {cat}
            </button>
          ))}
        </div>
      )}

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className={TH}>Código</th>
                <th className={TH}>Nombre</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Categoría</th>
                {canSeePrecio && <th className={TH}>Precio</th>}
                {canSeeCosts  && <th className={TH}>Costo</th>}
                {canSeeMargen && <th className={TH}>Margen</th>}
                <th className={TH}>Stock</th>
                <th className={TH}>Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={6 + (canSeePrecio?1:0) + (canSeeCosts?1:0) + (canSeeMargen?1:0) + 1} className="text-center py-12">
                  <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                </td></tr>
              ) : itemsFiltrados.length === 0 ? (
                <tr><td colSpan={6 + (canSeePrecio?1:0) + (canSeeCosts?1:0) + (canSeeMargen?1:0) + 1} className="text-center py-12 text-slate-500 text-xs font-mono">
                  No hay items en el catálogo.
                </td></tr>
              ) : itemsFiltrados.map(item => {
                const precio = Number(item.precio)
                const costo  = Number(item.costo)
                const margen = precio > 0 ? Math.round(((precio - costo) / precio) * 100) : 0
                // Badge color por prefijo: SRV=azul, ART=ámbar, REC=violeta
                const codBg = item.sku ? 'bg-emerald-600/15 text-emerald-300 border-emerald-600/30'
                  : item.codigo?.startsWith('SRV') ? 'bg-blue-600/15 text-blue-300 border-blue-600/30'
                  : item.codigo?.startsWith('ART') ? 'bg-amber-600/15 text-amber-300 border-amber-600/30'
                  : item.codigo?.startsWith('REC') ? 'bg-violet-600/15 text-violet-300 border-violet-600/30'
                  : 'bg-slate-700/40 text-slate-400 border-slate-700'
                return (
                  <tr key={item.id} onClick={() => setDetalle(item)}
                    className="hover:bg-slate-800/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold border ${codBg}`}>
                        {item.sku ?? item.codigo ?? '—'}
                      </span>
                      {item.sku && item.codigo && (
                        <div className="text-[9px] text-slate-600 font-mono mt-0.5">{item.codigo}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-100 whitespace-nowrap">{item.nombre}</div>
                      {item.descripcion && (
                        <div className="text-xs text-slate-500 truncate max-w-[220px] mt-0.5">{item.descripcion}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><TipoBadge tipo={item.tipo} /></td>
                    <td className="px-4 py-3 whitespace-nowrap"><CatBadge cat={item.categoria} /></td>
                    {canSeePrecio && <td className="px-4 py-3 font-mono text-sm text-emerald-400 whitespace-nowrap">{formatCurrency(precio)}</td>}
                    {canSeeCosts  && <td className="px-4 py-3 font-mono text-sm text-slate-500 whitespace-nowrap">{formatCurrency(costo)}</td>}
                    {canSeeMargen && (
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`text-xs font-mono font-bold ${margen >= 30 ? 'text-emerald-400' : margen >= 10 ? 'text-amber-400' : 'text-red-400'}`}>
                          {margen}%
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-3 text-xs font-mono whitespace-nowrap">
                      {item.stock != null
                        ? <span className={item.stock <= 0 ? 'text-red-400 font-semibold' : 'text-slate-300'}>{item.stock}</span>
                        : <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {item.activo
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"><CheckCircle size={11} />Activo</span>
                        : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-500 border border-slate-500/30"><XCircle size={11} />Inactivo</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5 justify-end">
                        {canPOS && onSellNow && item.activo && (
                          <button onClick={() => onSellNow(item)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-orange-600/15 hover:bg-orange-600/25 border border-orange-600/30 hover:border-orange-600/50 text-orange-400 hover:text-orange-300 text-xs font-medium transition-all">
                            <ShoppingBag size={12} />Vender
                          </button>
                        )}
                        {canEdit && (
                          <>
                            <button onClick={() => setModalItem(item)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 text-slate-300 hover:text-white text-xs font-medium transition-all">
                              <Pencil size={12} />Editar
                            </button>
                            <button onClick={() => toggleActivo(item)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                                item.activo
                                  ? 'bg-slate-700/40 hover:bg-red-900/20 border-slate-600/40 hover:border-red-700/30 text-slate-500 hover:text-red-400'
                                  : 'bg-emerald-600/10 hover:bg-emerald-600/20 border-emerald-600/20 hover:border-emerald-600/40 text-emerald-600 hover:text-emerald-400'
                              }`}>
                              {item.activo ? <XCircle size={12} /> : <CheckCircle size={12} />}
                              {item.activo ? 'Desactivar' : 'Activar'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-700/50 flex items-center justify-between">
          <p className="text-xs text-slate-600 font-mono">{itemsFiltrados.length} item{itemsFiltrados.length !== 1 ? 's' : ''}</p>
          {canSeeCosts && <p className="text-[10px] text-slate-700 font-mono">Margen: verde ≥30% · ámbar ≥10% · rojo &lt;10%</p>}
        </div>
      </div>

      {modalItem !== null && (
        <ItemModal
          item={modalItem === false ? null : modalItem}
          canSeeCosts={canSeeCosts}
          onClose={() => setModalItem(null)}
          onSaved={() => { setModalItem(null); fetchCatalogo() }}
        />
      )}

      {detalle && (
        <CatalogoDetalleDrawer
          item={detalle}
          canSeeCosts={canSeeCosts}
          canPOS={canPOS}
          onSellNow={onSellNow}
          onEdit={canEdit ? () => { setDetalle(null); setModalItem(detalle) } : null}
          onClose={() => setDetalle(null)}
        />
      )}
    </div>
  )
}

// ── CatalogoDetalleDrawer ────────────────────────────────────────────────────
// Slide-over lateral: muestra todos los detalles del item (SKU/Código, precios,
// stock, vínculo a producto físico, descripción rica) sin sacar al usuario del
// listado. Click en backdrop o X cierra. Acciones rápidas: editar / vender.
function CatalogoDetalleDrawer({ item, canSeeCosts, canPOS, onSellNow, onEdit, onClose }) {
  const precio = Number(item.precio)
  const costo  = Number(item.costo ?? 0)
  const margen = precio > 0 ? Math.round(((precio - costo) / precio) * 100) : 0
  const descParsed = _descParse(item.descripcion)
  const descTexto = descParsed && typeof descParsed === 'object' && descParsed.v === 1
    ? (descParsed.titulo ?? '') + (descParsed.lineas?.length ? '\n' + descParsed.lineas.map(l => `• ${l.texto ?? ''}`).join('\n') : '')
    : (typeof descParsed === 'string' ? descParsed : '')
  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-[60] w-full sm:w-[28rem] lg:w-[34rem] bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col">
        <header className="px-5 py-4 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-slate-100 truncate">{item.nombre}</h2>
            <p className="text-[10px] font-mono text-blue-400 mt-0.5">{item.sku ?? item.codigo ?? '—'}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors flex-shrink-0 ml-2"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {item.imagenUrl && (
            <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-900">
              <img src={item.imagenUrl} alt={item.nombre} className="w-full h-44 object-cover" />
            </div>
          )}

          <section className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Tipo</p>
              <TipoBadge tipo={item.tipo} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Categoría</p>
              <CatBadge cat={item.categoria} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Naturaleza</p>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                item.tipoItem === 'ARTICULO'
                  ? 'bg-amber-600/15 text-amber-300 border-amber-600/30'
                  : 'bg-sky-600/15 text-sky-300 border-sky-600/30'
              }`}>
                {item.tipoItem === 'ARTICULO' ? <Package size={11} /> : <Wrench size={11} />}
                {item.tipoItem === 'ARTICULO' ? 'Artículo' : 'Servicio'}
              </span>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Estado</p>
              {item.activo
                ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"><CheckCircle size={11} />Activo</span>
                : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/15 text-slate-500 border border-slate-500/30"><XCircle size={11} />Inactivo</span>
              }
            </div>
            {item.esBundle && (
              <div className="col-span-2">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold bg-violet-600/15 text-violet-300 border border-violet-600/30">
                  <Layers size={11} />Bundle (kit con BOM)
                </span>
              </div>
            )}
          </section>

          <section className="grid grid-cols-2 gap-3 bg-slate-900/50 border border-slate-800 rounded-lg p-3">
            <div>
              <p className="text-[10px] text-slate-500">Precio</p>
              <p className="text-lg font-bold text-emerald-400 font-mono">{formatCurrency(precio)}</p>
            </div>
            {canSeeCosts && (
              <div>
                <p className="text-[10px] text-slate-500">Costo</p>
                <p className="text-lg font-bold text-slate-300 font-mono">{formatCurrency(costo)}</p>
              </div>
            )}
            {canSeeCosts && (
              <div className="col-span-2 flex items-center gap-2">
                <p className="text-[10px] text-slate-500">Margen:</p>
                <span className={`text-xs font-mono font-bold ${margen >= 30 ? 'text-emerald-400' : margen >= 10 ? 'text-amber-400' : 'text-red-400'}`}>
                  {margen}%
                </span>
              </div>
            )}
          </section>

          {(item.tipoItem === 'ARTICULO' || item.producto) && (
            <section>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Inventario</p>
              <div className={`rounded-lg p-3 border ${item.producto ? 'bg-emerald-900/15 border-emerald-700/30' : 'bg-amber-900/10 border-amber-700/30'}`}>
                {item.producto ? (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <Link2 size={12} className="text-emerald-400" />
                      <p className="text-xs font-semibold text-slate-200">{item.producto.nombre}</p>
                    </div>
                    <p className="text-[10px] font-mono text-slate-400">
                      SKU <span className="text-emerald-300">{item.producto.sku}</span> · Stock actual:
                      <span className={`ml-1 ${item.producto.stockActual <= 0 ? 'text-red-400' : 'text-emerald-400'}`}>{item.producto.stockActual}</span>
                    </p>
                  </>
                ) : item.stock != null ? (
                  <p className="text-xs text-amber-300">Stock manual: <span className="font-mono font-bold">{item.stock}</span> uds. (sin vínculo a producto físico)</p>
                ) : (
                  <p className="text-xs text-amber-300">Sin stock asociado. Vincúlalo a un producto del inventario.</p>
                )}
              </div>
            </section>
          )}

          {descTexto && (
            <section>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Descripción comercial</p>
              <p className="text-xs text-slate-300 whitespace-pre-wrap bg-slate-900/50 border border-slate-800 rounded-lg p-2.5">{descTexto}</p>
            </section>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-800 flex items-center justify-end gap-2 flex-shrink-0">
          {canPOS && onSellNow && item.activo && (
            <button onClick={() => { onSellNow(item); onClose() }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600/15 hover:bg-orange-600/25 border border-orange-600/30 text-orange-300 text-xs font-semibold transition-all">
              <ShoppingBag size={12} />Vender
            </button>
          )}
          {onEdit && (
            <button onClick={onEdit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 border border-blue-600/30 text-blue-300 text-xs font-semibold transition-all">
              <Pencil size={12} />Editar
            </button>
          )}
          <button onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-100 text-xs font-semibold transition-colors">
            Cerrar
          </button>
        </footer>
      </aside>
    </>
  )
}
