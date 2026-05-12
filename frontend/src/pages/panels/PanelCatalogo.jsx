import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Plus, Search, Pencil, Loader2, Save, X, CheckCircle, XCircle, RefreshCw, ShoppingBag,
} from 'lucide-react'
import { apiFetch } from '../../utils/api'
import {
  TIPOS, CATEGORIAS,
  TH, LABEL_CLS, INPUT_CLS, SELECT_CLS,
  formatCurrency,
  TipoBadge, CatBadge,
} from './_shared'

// ── ItemModal ─────────────────────────────────────────────────────────────────

function ItemModal({ item, canSeeCosts, onClose, onSaved }) {
  const empty = { nombre: '', descripcion: '', tipo: 'Recurrente', categoria: 'WISP', precio: '', costo: '0', stock: '', activo: true }
  const [form, setForm] = useState(
    item
      ? { ...item, precio: String(item.precio), costo: String(item.costo ?? 0), stock: item.stock != null ? String(item.stock) : '' }
      : empty
  )
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
        descripcion: form.descripcion?.trim() || null,
        tipo:        form.tipo,
        categoria:   form.categoria,
        precio:      parseFloat(form.precio),
        ...(canSeeCosts ? { costo: parseFloat(form.costo) || 0 } : {}),
        stock:       form.tipo === 'VentaUnica' && form.stock !== '' ? parseInt(form.stock) : null,
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
            <label className={LABEL_CLS}>Descripción</label>
            <textarea value={form.descripcion || ''} onChange={e => set('descripcion', e.target.value)} rows={2}
              placeholder="Detalles adicionales (opcional)"
              className={`${INPUT_CLS} resize-none`} />
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

          {form.tipo === 'VentaUnica' && (
            <div>
              <label className={LABEL_CLS}>Stock (unidades)</label>
              <input type="number" min="0" value={form.stock} onChange={e => set('stock', e.target.value)}
                placeholder="Dejar vacío si no aplica" className={INPUT_CLS} />
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

export default function PanelCatalogo({ canEdit, canSeeCosts, canPOS, onSellNow }) {
  const [items,           setItems]           = useState([])
  const [loading,         setLoading]         = useState(false)
  const [search,          setSearch]          = useState('')
  const [filtroTipo,      setFiltroTipo]      = useState('')
  const [filtroCategoria, setFiltroCategoria] = useState('')
  const [filtroActivo,    setFiltroActivo]    = useState('true')
  const [modalItem,       setModalItem]       = useState(null)

  const fetchCatalogo = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroTipo)      p.set('tipo',      filtroTipo)
      if (filtroCategoria) p.set('categoria', filtroCategoria)
      if (filtroActivo)    p.set('activo',    filtroActivo)
      if (search)          p.set('search',    search)
      const r = await apiFetch(`/api/catalogo?${p}`)
      if (r.ok) { const j = await r.json(); setItems(j.data ?? []) }
    } catch {}
    finally { setLoading(false) }
  }, [filtroTipo, filtroCategoria, filtroActivo, search])

  useEffect(() => { fetchCatalogo() }, [fetchCatalogo])

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
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..."
              className="pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-40 transition-colors" />
          </div>
          <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos los tipos</option>
            {TIPOS.map(t => <option key={t} value={t}>{t === 'VentaUnica' ? 'Venta Única' : t}</option>)}
          </select>
          <select value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todas las categorías</option>
            {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filtroActivo} onChange={e => setFiltroActivo(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos</option>
            <option value="true">Activos</option>
            <option value="false">Inactivos</option>
          </select>
          <button onClick={fetchCatalogo} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {canEdit && (
          <button onClick={() => setModalItem(false)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap">
            <Plus size={16} />Nuevo Item
          </button>
        )}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className={TH}>Nombre</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Categoría</th>
                <th className={TH}>Precio</th>
                {canSeeCosts && <th className={TH}>Costo</th>}
                {canSeeCosts && <th className={TH}>Margen</th>}
                <th className={TH}>Stock</th>
                <th className={TH}>Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={6 + (canSeeCosts ? 2 : 0) + 1} className="text-center py-12">
                  <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                </td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={6 + (canSeeCosts ? 2 : 0) + 1} className="text-center py-12 text-slate-500 text-xs font-mono">
                  No hay items en el catálogo.
                </td></tr>
              ) : items.map(item => {
                const precio = Number(item.precio)
                const costo  = Number(item.costo)
                const margen = precio > 0 ? Math.round(((precio - costo) / precio) * 100) : 0
                return (
                  <tr key={item.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-100 whitespace-nowrap">{item.nombre}</div>
                      {item.descripcion && (
                        <div className="text-xs text-slate-500 truncate max-w-[220px] mt-0.5">{item.descripcion}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><TipoBadge tipo={item.tipo} /></td>
                    <td className="px-4 py-3 whitespace-nowrap"><CatBadge cat={item.categoria} /></td>
                    <td className="px-4 py-3 font-mono text-sm text-emerald-400 whitespace-nowrap">{formatCurrency(precio)}</td>
                    {canSeeCosts && <td className="px-4 py-3 font-mono text-sm text-slate-500 whitespace-nowrap">{formatCurrency(costo)}</td>}
                    {canSeeCosts && (
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
                    <td className="px-4 py-3 text-right whitespace-nowrap">
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
          <p className="text-xs text-slate-600 font-mono">{items.length} item{items.length !== 1 ? 's' : ''}</p>
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
    </div>
  )
}
