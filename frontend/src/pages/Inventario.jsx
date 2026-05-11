import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Plus, Search, X, RefreshCw, ChevronLeft, ChevronRight,
  Pencil, Trash2, AlertTriangle, Package, Tag, ArrowDownCircle,
  ArrowUpCircle, BarChart2, Loader2, Download, ShieldOff, Wrench, ShoppingCart,
} from 'lucide-react'
import FormularioProducto  from '../components/inventario/FormularioProducto'
import FormularioCategoria from '../components/inventario/FormularioCategoria'
import { useDebounce }     from '../hooks/useDebounce'
import { exportCsv }       from '../utils/exportCsv'
import { apiFetch }        from '../utils/api'
import { useAuth }         from '../contexts/AuthContext'
import { useCart }         from '../contexts/CartContext'

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

// ─── Tab: Catálogo (Artículos o Servicios) ────────────────────────────────────

function TabCatalogo({ tipoItem, categorias, canCreate, canExport }) {
  const { addItem, loading: cartLoading } = useCart()
  const [rows, setRows]       = useState([])
  const [meta, setMeta]       = useState({ total: 0, page: 1, totalPages: 1 })
  const [search, setSearch]   = useState('')
  const [catFiltro, setCatFiltro] = useState('')
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  const [modal, setModal]     = useState(null)
  const debouncedSearch       = useDebounce(search, 400)

  const esServicio = tipoItem === 'SERVICIO'

  const fetch_ = useCallback(async (p, s, c) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: p, limit: 50, tipoItem })
      if (s) params.set('search', s)
      if (c) params.set('categoriaId', c)
      const r = await apiFetch(`/api/productos?${params}`)
      if (!r.ok) throw new Error()
      const j = await r.json()
      setRows(j.data ?? [])
      setMeta(j.meta ?? { total: 0, page: 1, totalPages: 1 })
    } catch { toast.error('Error al cargar productos.') }
    finally { setLoading(false) }
  }, [tipoItem])

  useEffect(() => { setPage(1); fetch_(1, debouncedSearch, catFiltro) }, [debouncedSearch, catFiltro, fetch_])
  useEffect(() => { fetch_(page, debouncedSearch, catFiltro) }, [page])

  async function eliminar(p) {
    if (!window.confirm(`¿Eliminar "${p.nombre}"?`)) return
    const r = await apiFetch(`/api/productos/${p.id}`, { method: 'DELETE' })
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
        <button onClick={() => fetch_(page, debouncedSearch, catFiltro)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="sticky top-0 z-10">
            <tr>
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
              <tr><td colSpan={esServicio ? 5 : 6} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={esServicio ? 5 : 6} className="px-4 py-8 text-center text-sm text-slate-600">Sin {esServicio ? 'servicios' : 'artículos'}.</td></tr>
            )}
            {rows.map(p => (
              <tr key={p.id} className="hover:bg-slate-800/40 transition-colors">
                <td className={TD + ' font-mono text-xs text-slate-400'}>{p.sku}</td>
                <td className={TD + ' font-medium text-slate-200'}>{p.nombre}</td>
                <td className={TD}>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-slate-700/50 text-slate-400 border border-slate-600/30">
                    <Tag size={9} />{p.categoria?.nombre ?? '—'}
                  </span>
                </td>
                <td className={TD + ' text-right tabular-nums'}>RD$ {fmt(p.precio)}</td>
                {!esServicio && (
                  <td className="px-4 py-3 text-right"><StockBadge stock={p.stockActual} /></td>
                )}
                <td className="px-4 py-3">
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
      </div>

      <Pager meta={meta} onPage={p => setPage(p)} />

      {modal && (
        <FormularioProducto
          producto={modal._new ? null : modal}
          tipoItemDefault={tipoItem}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); fetch_(page, debouncedSearch, catFiltro); toast.success('Guardado.') }}
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
    const r = await apiFetch(`/api/categorias/${c.id}`, { method: 'DELETE' })
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
              <tr><td colSpan={3} className="px-4 py-8 text-center text-sm text-slate-600">Sin categorías.</td></tr>
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
      const r = await apiFetch(`/api/movimientos?${params}`)
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
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-600">Sin movimientos registrados.</td></tr>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'articulos',   label: '📦 Productos Físicos', Icon: Package,  tipoItem: 'ARTICULO' },
  { key: 'servicios',   label: '🛠️ Servicios',          Icon: Wrench,   tipoItem: 'SERVICIO' },
  { key: 'categorias',  label: 'Categorías',            Icon: Tag,      tipoItem: null       },
  { key: 'movimientos', label: 'Movimientos (Kardex)',  Icon: BarChart2, tipoItem: null      },
]

export default function Inventario() {
  const { tienePermiso }            = useAuth()
  const [tab, setTab]               = useState('articulos')
  const [categorias, setCategorias] = useState([])
  const [catLoading, setCatLoading] = useState(false)

  const fetchCategorias = useCallback(async () => {
    setCatLoading(true)
    try {
      const r = await apiFetch('/api/categorias')
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
        {tab === 'categorias'  && <TabCategorias categorias={categorias} loading={catLoading} onRefresh={fetchCategorias} canCreate={canCreate} />}
        {tab === 'movimientos' && <TabMovimientos canExport={canExport} />}
      </div>
    </div>
  )
}
