import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Plus, Search, X, RefreshCw, ChevronLeft, ChevronRight,
  Pencil, Trash2, AlertTriangle, Package, Tag, ArrowDownCircle,
  ArrowUpCircle, BarChart2, Loader2, Download, ShieldOff, Wrench, ShoppingCart,
  Table2, LayoutGrid,
} from 'lucide-react'
import FormularioProducto  from '../components/inventario/FormularioProducto'
import FormularioCategoria from '../components/inventario/FormularioCategoria'
import { useDebounce }     from '../hooks/useDebounce'
import { exportCsv }       from '../utils/exportCsv'
import { apiFetch }        from '../utils/api'
import { useAuth }         from '../contexts/AuthContext'
import { useCart }         from '../contexts/CartContext'
import { InvCatBadge, EmptyState } from './panels/_shared'

const LOW_STOCK = 5
const fmt       = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })
const fmtDate   = d => new Date(d).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const TH = 'px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap bg-slate-800/60'
const TD = 'px-4 py-3 text-sm text-slate-300'

function Pager({ meta, onPage }) {
  if (meta.totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
      <span className="text-xs text-slate-500">{meta.total} registros · pág. {meta.page}/{meta.totalPages}</span>
      <div className="flex gap-1">
        <button onClick={() => onPage(meta.page - 1)} disabled={meta.page <= 1}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          <ChevronLeft size={16} />
        </button>
        <button onClick={() => onPage(meta.page + 1)} disabled={meta.page >= meta.totalPages}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

function StockBadge({ stock }) {
  if (stock <= LOW_STOCK) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30">
      <AlertTriangle size={10} /> {stock}
    </span>
  )
  return <span className="text-sm text-slate-200 tabular-nums">{stock}</span>
}

function MovBadge({ tipo }) {
  if (tipo === 'Entrada') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-600/10 text-emerald-400 border border-emerald-600/30">
      <ArrowDownCircle size={10} /> Entrada
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-600/10 text-orange-400 border border-orange-600/30">
      <ArrowUpCircle size={10} /> Salida
    </span>
  )
}

// ─── Modal Vista Producto (read mode) ─────────────────────────────────────────

function ModalVistaProducto({ producto, onClose, onEdit }) {
  const esServicio = producto.tipoItem === 'SERVICIO'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            {esServicio ? <Wrench size={16} className="text-purple-400" /> : <Package size={16} className="text-blue-400" />}
            <h2 className="font-semibold text-slate-100 truncate">{producto.nombre}</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors flex-shrink-0"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">SKU</p>
              <p className="text-sm font-mono text-slate-200 mt-0.5">{producto.sku}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Categoría</p>
              <p className="text-sm text-slate-200 mt-0.5">{producto.categoria?.nombre ?? '—'}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Precio</p>
              <p className="text-lg font-bold text-emerald-400 mt-0.5">RD$ {fmt(producto.precio)}</p>
            </div>
            {!esServicio && (
              <div>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Stock Actual</p>
                <div className="mt-1"><StockBadge stock={producto.stockActual} /></div>
              </div>
            )}
            <div className={!esServicio ? 'col-span-2' : ''}>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Tipo</p>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium mt-0.5 ${esServicio ? 'bg-purple-600/10 text-purple-400 border border-purple-600/30' : 'bg-blue-600/10 text-blue-400 border border-blue-600/30'}`}>
                {esServicio ? <Wrench size={9} /> : <Package size={9} />} {esServicio ? 'Servicio' : 'Artículo Físico'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">Cerrar</button>
          <button onClick={onEdit} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
            <Pencil size={13} /> Editar
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Catálogo (Artículos o Servicios) ────────────────────────────────────

function TabCatalogo({ tipoItem, categorias, canCreate, canExport }) {
  const { addItem, loading: cartLoading } = useCart()
  const [rows, setRows]       = useState([])
  const [meta, setMeta]       = useState({ total: 0, page: 1, totalPages: 1 })
  const [search, setSearch]   = useState('')
  const [catFiltro, setCatFiltro] = useState('')
  const [canibFiltro, setCanibFiltro] = useState('')
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  // Persistido por user-preference: vuelve a la última vista al recargar.
  const [vista, setVista] = useState(() => {
    try { return localStorage.getItem('acr_inv_view') ?? 'tabla' } catch { return 'tabla' }
  })
  function cambiarVista(v) { setVista(v); try { localStorage.setItem('acr_inv_view', v) } catch {} }
  const [modal, setModal]     = useState(null)
  const [viewModal, setViewModal] = useState(null)
  const debouncedSearch       = useDebounce(search, 400)

  const esServicio = tipoItem === 'SERVICIO'

  const fetch_ = useCallback(async (p, s, c, canib) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: p, limit: 50, tipoItem })
      if (s)     params.set('search', s)
      if (c)     params.set('categoriaId', c)
      if (canib) params.set('canibalizados', canib)
      const r = await apiFetch(`/api/inventario/productos?${params}`)
      if (!r.ok) throw new Error()
      const j = await r.json()
      setRows(j.data ?? [])
      setMeta(j.meta ?? { total: 0, page: 1, totalPages: 1 })
    } catch { toast.error('Error al cargar productos.') }
    finally { setLoading(false) }
  }, [tipoItem])

  useEffect(() => { setPage(1); fetch_(1, debouncedSearch, catFiltro, canibFiltro) }, [debouncedSearch, catFiltro, canibFiltro, fetch_])
  useEffect(() => { fetch_(page, debouncedSearch, catFiltro, canibFiltro) }, [page])

  async function eliminar(p) {
    if (!window.confirm(`¿Eliminar "${p.nombre}"?`)) return
    const r = await apiFetch(`/api/inventario/productos/${p.id}`, { method: 'DELETE' })
    if (r.status === 204) { toast.success('Eliminado.'); fetch_(page, debouncedSearch, catFiltro); return }
    const j = await r.json()
    toast.error(j.error ?? 'Error al eliminar.')
  }

  function exportar() {
    if (!rows.length) { toast.warning('Sin datos para exportar.'); return }
    exportCsv(`${esServicio ? 'servicios' : 'articulos'}-${new Date().toISOString().slice(0, 10)}`, [
      { header: 'SKU',        getValue: r => r.sku },
      { header: 'Nombre',     getValue: r => r.nombre },
      { header: 'Categoría',  getValue: r => r.categoria?.nombre ?? '' },
      { header: 'Precio RD$', getValue: r => r.precio },
      ...(!esServicio ? [{ header: 'Stock', getValue: r => r.stockActual }] : []),
    ], rows)
    toast.success(`${rows.length} ${esServicio ? 'servicios' : 'artículos'} exportados.`)
  }

  const catsFiltradas = categorias.filter(c =>
    esServicio
      ? ['Mano de Obra', 'Instalaciones', 'Fusiones'].some(k => c.nombre.includes(k))
      : !['Mano de Obra', 'Instalaciones', 'Fusiones'].some(k => c.nombre.includes(k))
  )

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 p-4 border-b border-slate-800">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            placeholder={`Buscar ${esServicio ? 'servicio' : 'producto'} por nombre o SKU...`}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"><X size={14} /></button>}
        </div>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors min-w-[150px]"
          value={catFiltro}
          onChange={e => setCatFiltro(e.target.value)}
        >
          <option value="">Todas las categorías</option>
          {catsFiltradas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
        {!esServicio && (
          <select
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 min-w-[150px]"
            value={canibFiltro}
            onChange={e => setCanibFiltro(e.target.value)}
          >
            <option value="">Todos los artículos</option>
            <option value="false">Solo nuevos</option>
            <option value="true">Solo canibalizados</option>
          </select>
        )}
        {canExport && (
          <button onClick={exportar} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-emerald-400 border border-slate-700 hover:border-emerald-600/40 transition-colors" title="Exportar CSV">
            <Download size={14} /> <span className="hidden sm:inline">CSV</span>
          </button>
        )}
        {canCreate && (
          <button onClick={() => setModal({ _new: true, tipoItem })} className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap">
            <Plus size={14} /> {esServicio ? 'Nuevo Servicio' : 'Nuevo Artículo'}
          </button>
        )}
        <div className="inline-flex bg-slate-800 border border-slate-700 rounded-lg p-0.5" title="Vista">
          <button onClick={() => cambiarVista('tabla')}
            className={`p-1.5 rounded ${vista === 'tabla' ? 'bg-slate-700 text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}
            title="Vista tabla">
            <Table2 size={14} />
          </button>
          <button onClick={() => cambiarVista('galeria')}
            className={`p-1.5 rounded ${vista === 'galeria' ? 'bg-slate-700 text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}
            title="Vista galería">
            <LayoutGrid size={14} />
          </button>
        </div>
        <button onClick={() => fetch_(page, debouncedSearch, catFiltro)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {vista === 'galeria' && !loading && rows.length > 0 && (
        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {rows.map(p => (
            <div key={p.id} onClick={() => setViewModal(p)}
              className="group bg-slate-800/40 hover:bg-slate-800/80 border border-slate-700/50 hover:border-blue-500/50 rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-lg hover:shadow-blue-600/10 flex flex-col">
              <div className="aspect-square bg-slate-900 border-b border-slate-800 overflow-hidden flex items-center justify-center">
                {p.imagenUrl ? (
                  <img src={p.imagenUrl} alt={p.nombre} className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    onError={e => { e.currentTarget.style.display = 'none' }} />
                ) : (
                  <Package size={42} className="text-slate-700" strokeWidth={1.2} />
                )}
                {!esServicio && (
                  <div className="absolute top-2 right-2"><StockBadge stock={p.stockActual} /></div>
                )}
              </div>
              <div className="p-3 flex-1 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold text-slate-100 leading-tight line-clamp-2 flex-1">{p.nombre}</p>
                </div>
                <p className="text-[10px] font-mono text-slate-500 truncate">{p.sku}</p>
                {p.descripcion && (
                  <p className="text-[10px] text-slate-500 line-clamp-2">{p.descripcion.replace(/[*_`#-]/g, '').trim()}</p>
                )}
                <div className="flex items-center justify-between mt-auto pt-1.5">
                  <span className="text-sm font-bold font-mono text-emerald-400">RD$ {fmt(p.precio)}</span>
                  {!esServicio && (
                    <span className={`text-[10px] font-mono ${p.stockActual <= 0 ? 'text-red-400' : p.stockActual <= 5 ? 'text-amber-400' : 'text-slate-500'}`}>
                      Stk {p.stockActual}
                    </span>
                  )}
                </div>
                <div className="flex gap-1 mt-1.5" onClick={e => e.stopPropagation()}>
                  <button onClick={() => addItem(p.id, 1)} disabled={cartLoading || (!esServicio && p.stockActual <= 0)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 hover:bg-emerald-600/40 transition-colors disabled:opacity-40">
                    <ShoppingCart size={11} />Añadir
                  </button>
                  {canCreate && (
                    <button onClick={() => setModal(p)}
                      className="px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors">
                      <Pencil size={11} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {vista === 'tabla' && <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={TH}>Código</th>
              <th className={TH}>SKU</th>
              <th className={TH}>Nombre</th>
              <th className={TH}>Categoría</th>
              <th className={TH + ' text-right'}>Precio</th>
              {!esServicio && <th className={TH + ' text-right'}>Stock</th>}
              <th className={TH}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && rows.length === 0 && (
              <tr><td colSpan={esServicio ? 6 : 7} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={esServicio ? 6 : 7}><EmptyState title={`Sin ${esServicio ? 'servicios' : 'artículos'}`} description="Agrega el primero con el botón +" /></td></tr>
            )}
            {rows.map(p => (
              <tr key={p.id} onClick={() => setViewModal(p)} className="hover:bg-slate-800/40 transition-colors cursor-pointer">
                <td className="px-4 py-3 whitespace-nowrap">
                  <span className="text-xs font-mono font-bold text-amber-400 bg-amber-600/10 border border-amber-600/20 px-2 py-0.5 rounded">
                    ART-{String(p.id).padStart(3, '0')}
                  </span>
                </td>
                <td className={TD + ' font-mono text-xs text-slate-400'}>{p.sku}</td>
                <td className={TD + ' font-medium text-slate-200'}>{p.nombre}</td>
                <td className={TD}>
                  <InvCatBadge nombre={p.categoria?.nombre} />
                </td>
                <td className={TD + ' text-right tabular-nums'}>RD$ {fmt(p.precio)}</td>
                {!esServicio && (
                  <td className="px-4 py-3 text-right"><StockBadge stock={p.stockActual} /></td>
                )}
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => addItem(p.id, 1)}
                      disabled={cartLoading}
                      title="Añadir al carrito"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 hover:bg-emerald-600/40 hover:text-emerald-300 transition-colors disabled:opacity-40"
                    >
                      <ShoppingCart size={12} /> Añadir
                    </button>
                    {canCreate && (
                      <>
                        <button onClick={() => setModal(p)} className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition-colors"><Pencil size={14} /></button>
                        <button onClick={() => eliminar(p)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"><Trash2 size={14} /></button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}

      <Pager meta={meta} onPage={p => setPage(p)} />

      {modal && (
        <FormularioProducto
          producto={modal._new ? null : modal}
          tipoItemDefault={tipoItem}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); fetch_(page, debouncedSearch, catFiltro); toast.success('Guardado.') }}
        />
      )}
      {viewModal && (
        <ModalVistaProducto
          producto={viewModal}
          onClose={() => setViewModal(null)}
          onEdit={() => { setModal(viewModal); setViewModal(null) }}
        />
      )}
    </div>
  )
}

// ─── Tab: Categorías ──────────────────────────────────────────────────────────

function TabCategorias({ categorias, loading, onRefresh, canCreate }) {
  const [modal, setModal] = useState(null)

  async function eliminar(c) {
    if (!window.confirm(`¿Eliminar categoría "${c.nombre}"?`)) return
    const r = await apiFetch(`/api/inventario/categorias/${c.id}`, { method: 'DELETE' })
    if (r.status === 204) { toast.success('Categoría eliminada.'); onRefresh(); return }
    const j = await r.json()
    toast.error(j.error ?? 'Error al eliminar.')
  }

  return (
    <div>
      <div className="flex items-center justify-between p-4 border-b border-slate-800">
        <span className="text-sm text-slate-500">{categorias.length} categorías</span>
        <div className="flex gap-2">
          {canCreate && (
            <button onClick={() => setModal('nueva')} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
              <Plus size={14} /> Nueva Categoría
            </button>
          )}
          <button onClick={onRefresh} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[400px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={TH}>Nombre</th>
              <th className={TH + ' text-right'}>Productos</th>
              <th className={TH}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && categorias.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && categorias.length === 0 && (
              <tr><td colSpan={3}><EmptyState title="Sin categorías" description="Crea la primera categoría." /></td></tr>
            )}
            {categorias.map(c => (
              <tr key={c.id} className="hover:bg-slate-800/40 transition-colors">
                <td className={TD + ' font-medium text-slate-200'}>
                  <span className="inline-flex items-center gap-2"><Tag size={13} className="text-slate-500" />{c.nombre}</span>
                </td>
                <td className={TD + ' text-right tabular-nums text-slate-400'}>{c._count?.productos ?? 0}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => setModal(c)} className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition-colors"><Pencil size={14} /></button>
                    <button onClick={() => eliminar(c)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <FormularioCategoria
          categoria={modal === 'nueva' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); onRefresh(); toast.success('Categoría guardada.') }}
        />
      )}
    </div>
  )
}

// ─── Tab: Movimientos (Kardex) ────────────────────────────────────────────────

function TabMovimientos({ canExport }) {
  const [rows, setRows]       = useState([])
  const [meta, setMeta]       = useState({ total: 0, page: 1, totalPages: 1 })
  const [search, setSearch]   = useState('')
  const [tipo, setTipo]       = useState('')
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  const debouncedSearch       = useDebounce(search, 400)

  const fetch_ = useCallback(async (p, s, t) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: p, limit: 50 })
      if (s) params.set('search', s)
      if (t) params.set('tipo', t)
      const r = await apiFetch(`/api/inventario/movimientos?${params}`)
      if (!r.ok) throw new Error()
      const j = await r.json()
      setRows(j.data ?? [])
      setMeta(j.meta ?? { total: 0, page: 1, totalPages: 1 })
    } catch { toast.error('Error al cargar movimientos.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { setPage(1); fetch_(1, debouncedSearch, tipo) }, [debouncedSearch, tipo, fetch_])
  useEffect(() => { fetch_(page, debouncedSearch, tipo) }, [page])

  function exportar() {
    if (!rows.length) { toast.warning('Sin datos para exportar.'); return }
    exportCsv(`kardex-${new Date().toISOString().slice(0, 10)}`, [
      { header: 'Tipo',     getValue: r => r.tipo },
      { header: 'SKU',      getValue: r => r.producto?.sku ?? '' },
      { header: 'Producto', getValue: r => r.producto?.nombre ?? '' },
      { header: 'Cantidad', getValue: r => r.tipo === 'Entrada' ? r.cantidad : -r.cantidad },
      { header: 'Fecha',    getValue: r => fmtDate(r.fecha) },
    ], rows)
    toast.success(`${rows.length} movimientos exportados.`)
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 p-4 border-b border-slate-800">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Buscar producto..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"><X size={14} /></button>}
        </div>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors"
          value={tipo}
          onChange={e => setTipo(e.target.value)}
        >
          <option value="">Entrada y Salida</option>
          <option value="Entrada">Solo Entradas</option>
          <option value="Salida">Solo Salidas</option>
        </select>
        {canExport && (
          <button onClick={exportar} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-emerald-400 border border-slate-700 hover:border-emerald-600/40 transition-colors">
            <Download size={14} /> <span className="hidden sm:inline">CSV</span>
          </button>
        )}
        <button onClick={() => fetch_(page, debouncedSearch, tipo)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={TH}>Tipo</th>
              <th className={TH}>Producto</th>
              <th className={TH + ' text-right'}>Cantidad</th>
              <th className={TH}>Fecha</th>
              <th className={TH}>Origen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5}><EmptyState title="Sin movimientos" description="Los movimientos de entradas y salidas aparecerán aquí." /></td></tr>
            )}
            {rows.map(m => (
              <tr key={m.id} className="hover:bg-slate-800/40 transition-colors">
                <td className="px-4 py-3"><MovBadge tipo={m.tipo} /></td>
                <td className={TD}>
                  <div className="font-medium text-slate-200 leading-tight">{m.producto?.nombre ?? '—'}</div>
                  <div className="text-xs text-slate-500 font-mono">{m.producto?.sku}</div>
                </td>
                <td className={TD + ' text-right tabular-nums font-semibold ' + (m.tipo === 'Entrada' ? 'text-emerald-400' : 'text-orange-400')}>
                  {m.tipo === 'Entrada' ? '+' : '−'}{m.cantidad}
                </td>
                <td className={TD + ' text-xs text-slate-400 whitespace-nowrap'}>{fmtDate(m.fecha)}</td>
                <td className="px-4 py-3">
                  {m.orden ? (
                    <div>
                      <div className="text-xs text-slate-300 font-mono">{m.orden.id?.slice(0, 8)}…</div>
                      <div className="text-xs text-slate-500">{m.orden.servicio?.cliente?.razonSocial ?? '—'}</div>
                    </div>
                  ) : <span className="text-xs text-slate-600">Manual</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager meta={meta} onPage={p => setPage(p)} />
    </div>
  )
}

// ─── Tab: Catálogo Web (ItemCatalogo) ─────────────────────────────────────────

const TIPO_FACTURACION = ['VentaUnica', 'Recurrente', 'Servicio']
const TIPO_SERVICIO    = ['WISP', 'CCTV', 'Redes', 'SoporteTecnico', 'Reparacion', 'General']

function TabCatalogoWeb({ canCreate }) {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [modal,   setModal]   = useState(null)  // null | 'new' | item
  const [saving,  setSaving]  = useState(false)
  const [deleting, setDeleting] = useState(null)

  const emptyForm = { nombre: '', descripcion: '', tipo: 'VentaUnica', categoria: 'Redes', tipoItem: 'ARTICULO', precio: '', costo: '', stock: 0, activo: true }
  const [form, setForm] = useState(emptyForm)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/catalogo')
      if (!r.ok) throw new Error()
      const j = await r.json()
      setRows(j.data ?? [])
    } catch { toast.error('Error al cargar catálogo web.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function openNew()  { setForm(emptyForm); setModal('new') }
  function openEdit(item) {
    setForm({ nombre: item.nombre, descripcion: item.descripcion ?? '', tipo: item.tipo, categoria: item.categoria, tipoItem: item.tipoItem, precio: String(item.precio), costo: String(item.costo ?? ''), stock: item.stock ?? 0, activo: item.activo })
    setModal(item)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.nombre.trim() || !form.precio) { toast.error('Nombre y precio son obligatorios.'); return }
    setSaving(true)
    try {
      const body = { ...form, precio: Number(form.precio), costo: Number(form.costo) || 0 }
      const isNew = modal === 'new'
      const r = await apiFetch(isNew ? '/api/catalogo' : `/api/catalogo/${modal.id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) { const d = await r.json(); toast.error(d.error ?? 'Error al guardar.'); return }
      toast.success(isNew ? 'Ítem creado en catálogo web.' : 'Ítem actualizado.')
      setModal(null)
      load()
    } catch { toast.error('Error de conexión.') }
    finally { setSaving(false) }
  }

  async function handleDelete(id) {
    setDeleting(id)
    try {
      const r = await apiFetch(`/api/catalogo/${id}`, { method: 'DELETE' })
      if (!r.ok) { const d = await r.json(); toast.error(d.error ?? 'No se puede eliminar.'); return }
      toast.success('Ítem eliminado del catálogo web.')
      load()
    } catch { toast.error('Error de conexión.') }
    finally { setDeleting(null) }
  }

  async function toggleActivo(item) {
    try {
      const r = await apiFetch(`/api/catalogo/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, precio: Number(item.precio), costo: Number(item.costo ?? 0), activo: !item.activo }),
      })
      if (!r.ok) return
      setRows(prev => prev.map(x => x.id === item.id ? { ...x, activo: !x.activo } : x))
    } catch {}
  }

  const inp = 'w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors'
  const sel = inp + ' cursor-pointer'

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">Ítems visibles en el Portal B2C. Gestiona nombre, precio y disponibilidad.</p>
        {canCreate && (
          <button onClick={openNew}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white transition-colors">
            <Plus size={15} />Nuevo Ítem
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-600">
          <ShoppingCart size={32} />
          <p className="text-sm">Catálogo web vacío. Crea el primer ítem.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800/60 border-b border-slate-700/70">
                <th className={TH}>Nombre</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Categoría</th>
                <th className={TH}>Precio</th>
                <th className={TH}>Stock</th>
                <th className={TH}>Activo</th>
                {canCreate && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {rows.map(item => (
                <tr key={item.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className={TD}>
                    <div className="font-medium text-slate-100">{item.nombre}</div>
                    {item.descripcion && <div className="text-xs text-slate-500 truncate max-w-xs">{item.descripcion}</div>}
                  </td>
                  <td className={TD}><span className="text-xs px-2 py-0.5 rounded-full bg-blue-600/15 text-blue-400 border border-blue-600/30">{item.tipo}</span></td>
                  <td className={TD}><span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 border border-slate-600">{item.categoria}</span></td>
                  <td className={TD + ' font-semibold text-emerald-400 tabular-nums'}>RD$ {fmt(item.precio)}</td>
                  <td className={TD + ' tabular-nums'}>{item.tipoItem === 'ARTICULO' ? <StockBadge stock={item.stock ?? 0} /> : <span className="text-slate-600 text-xs">N/A</span>}</td>
                  <td className={TD}>
                    <button onClick={() => canCreate && toggleActivo(item)} disabled={!canCreate}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${item.activo ? 'bg-blue-600' : 'bg-slate-700'} ${canCreate ? 'cursor-pointer' : 'cursor-default opacity-50'}`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${item.activo ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                  </td>
                  {canCreate && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button onClick={() => openEdit(item)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 text-slate-300 hover:text-white text-xs font-medium transition-all">
                          <Pencil size={11} />Editar
                        </button>
                        <button onClick={() => handleDelete(item.id)} disabled={deleting === item.id}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-600/10 hover:bg-red-600/20 border border-red-600/20 text-red-400 text-xs font-medium transition-all disabled:opacity-40">
                          {deleting === item.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal crear/editar */}
      {modal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setModal(null)} />
          <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900">
              <div className="flex items-center gap-2">
                <ShoppingCart size={15} className="text-blue-400" />
                <h2 className="font-semibold text-slate-100">{modal === 'new' ? 'Nuevo Ítem Catálogo Web' : 'Editar Ítem'}</h2>
              </div>
              <button onClick={() => setModal(null)} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
            </div>
            <form onSubmit={handleSave} className="p-5 space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Nombre *</label>
                <input className={inp} value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Ej: Cámara IP 4K Exterior" required />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Descripción</label>
                <textarea className={inp + ' resize-none'} rows={2} value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} placeholder="Descripción visible al cliente" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Tipo Facturación</label>
                  <select className={sel} value={form.tipo} onChange={e => setForm(f => ({ ...f, tipo: e.target.value }))}>
                    {TIPO_FACTURACION.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Categoría</label>
                  <select className={sel} value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}>
                    {TIPO_SERVICIO.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Tipo Ítem</label>
                  <select className={sel} value={form.tipoItem} onChange={e => setForm(f => ({ ...f, tipoItem: e.target.value }))}>
                    <option value="ARTICULO">Artículo Físico</option>
                    <option value="SERVICIO">Servicio</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Stock (artículos)</label>
                  <input className={inp} type="number" min={0} value={form.stock} onChange={e => setForm(f => ({ ...f, stock: +e.target.value }))} disabled={form.tipoItem === 'SERVICIO'} />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Precio (RD$) *</label>
                  <input className={inp} type="number" min={0} step="0.01" value={form.precio} onChange={e => setForm(f => ({ ...f, precio: e.target.value }))} required />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Costo (RD$)</label>
                  <input className={inp} type="number" min={0} step="0.01" value={form.costo} onChange={e => setForm(f => ({ ...f, costo: e.target.value }))} />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setForm(f => ({ ...f, activo: !f.activo }))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.activo ? 'bg-blue-600' : 'bg-slate-700'} cursor-pointer`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.activo ? 'translate-x-4' : 'translate-x-1'}`} />
                </button>
                <span className="text-sm text-slate-400">Visible en portal ({form.activo ? 'Activo' : 'Inactivo'})</span>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setModal(null)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">Cancelar</button>
                <button type="submit" disabled={saving}
                  className="flex items-center gap-1.5 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50">
                  {saving ? <Loader2 size={13} className="animate-spin" /> : null}
                  {modal === 'new' ? 'Crear' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'articulos',    label: '📦 Productos Físicos', Icon: Package,     tipoItem: 'ARTICULO' },
  { key: 'servicios',    label: '🛠️ Servicios',          Icon: Wrench,      tipoItem: 'SERVICIO' },
  { key: 'categorias',   label: 'Categorías',            Icon: Tag,         tipoItem: null       },
  { key: 'movimientos',  label: 'Movimientos (Kardex)',  Icon: BarChart2,   tipoItem: null       },
  { key: 'catalogo_web', label: '🛒 Catálogo Web',       Icon: ShoppingCart, tipoItem: null      },
]

export default function Inventario() {
  const { tienePermiso }            = useAuth()
  const [tab, setTab]               = useState('articulos')
  const [categorias, setCategorias] = useState([])
  const [catLoading, setCatLoading] = useState(false)

  const fetchCategorias = useCallback(async () => {
    setCatLoading(true)
    try {
      const r = await apiFetch('/api/inventario/categorias')
      const j = await r.json()
      setCategorias(j.data ?? [])
    } catch { toast.error('Error al cargar categorías.') }
    finally { setCatLoading(false) }
  }, [])

  useEffect(() => { fetchCategorias() }, [fetchCategorias])

  if (!tienePermiso('inventario:ver')) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
      <ShieldOff size={32} />
      <p className="text-sm font-medium">Sin acceso al módulo Inventario</p>
    </div>
  )

  const canCreate = tienePermiso('inventario:editar')
  const canExport = tienePermiso('inventario:exportar')
  const activeTab = TABS.find(t => t.key === tab)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight">Inventario</h1>
        <p className="text-sm text-slate-500 mt-0.5">Artículos Físicos · Servicios · Kardex</p>
      </div>

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="flex border-b border-slate-800 overflow-x-auto">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                tab === key
                  ? 'text-blue-400 border-blue-500 bg-blue-900/10'
                  : 'text-slate-400 border-transparent hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {activeTab?.tipoItem && (
          <TabCatalogo
            key={activeTab.tipoItem}
            tipoItem={activeTab.tipoItem}
            categorias={categorias}
            canCreate={canCreate}
            canExport={canExport}
          />
        )}
        {tab === 'categorias'   && <TabCategorias categorias={categorias} loading={catLoading} onRefresh={fetchCategorias} canCreate={canCreate} />}
        {tab === 'movimientos'  && <TabMovimientos canExport={canExport} />}
        {tab === 'catalogo_web' && <TabCatalogoWeb canCreate={canCreate} />}
      </div>
    </div>
  )
}
