import { useState, useEffect, useCallback, useRef } from 'react'
import { useReactToPrint } from 'react-to-print'
import { Plus, Search, X, RefreshCw, ChevronLeft, ChevronRight, Pencil, ToggleLeft, ToggleRight, Eye, ClipboardList, Wrench, Package, CheckCircle, XCircle, Clock, AlertCircle, Wifi, Camera, Network, Zap, ShoppingBag, Layers, Stethoscope, Hammer, MonitorCog, Printer, ShieldOff } from 'lucide-react'
import FormularioPlan from '../components/servicios/FormularioPlan'
import FormularioServicio from '../components/servicios/FormularioServicio'
import FormularioOrden from '../components/servicios/FormularioOrden'
import ConduceOrden from '../components/servicios/ConduceOrden'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../utils/api'
import { EmptyState } from './panels/_shared'
const fmt = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })

const TIPO_COLOR = {
  WISP:           { bg: 'bg-blue-600/10',    text: 'text-blue-400',    border: 'border-blue-600/30',    icon: Wifi },
  CCTV:           { bg: 'bg-cyan-600/10',    text: 'text-cyan-400',    border: 'border-cyan-600/30',    icon: Camera },
  Redes:          { bg: 'bg-violet-600/10',  text: 'text-violet-400',  border: 'border-violet-600/30',  icon: Network },
  CercoElectrico: { bg: 'bg-amber-600/10',   text: 'text-amber-400',   border: 'border-amber-600/30',   icon: Zap },
  VentaDirecta:   { bg: 'bg-emerald-600/10', text: 'text-emerald-400', border: 'border-emerald-600/30', icon: ShoppingBag },
  Mixto:          { bg: 'bg-slate-700/30',   text: 'text-slate-400',   border: 'border-slate-600/30',   icon: Layers },
  SoporteTecnico: { bg: 'bg-sky-600/10',     text: 'text-sky-400',     border: 'border-sky-600/30',     icon: MonitorCog },
  Reparacion:     { bg: 'bg-orange-600/10',  text: 'text-orange-400',  border: 'border-orange-600/30',  icon: Hammer },
  ProyectoCCTV:   { bg: 'bg-teal-600/10',    text: 'text-teal-400',    border: 'border-teal-600/30',    icon: Camera },
}

const ESTADO_SERVICIO_COLOR = {
  Pendiente:     { text: 'text-slate-400',   bg: 'bg-slate-700/30',   border: 'border-slate-600/30',   icon: Clock },
  EnInstalacion: { text: 'text-amber-400',   bg: 'bg-amber-600/10',   border: 'border-amber-600/30',   icon: Wrench },
  Activo:        { text: 'text-emerald-400', bg: 'bg-emerald-600/10', border: 'border-emerald-600/30', icon: CheckCircle },
  Suspendido:    { text: 'text-red-400',     bg: 'bg-red-600/10',     border: 'border-red-600/30',     icon: AlertCircle },
  Cancelado:     { text: 'text-slate-600',   bg: 'bg-slate-800/30',   border: 'border-slate-700/30',   icon: XCircle },
}

const ESTADO_ORDEN_COLOR = {
  Pendiente:  { text: 'text-amber-400',   bg: 'bg-amber-600/10',   border: 'border-amber-600/30' },
  Completada: { text: 'text-emerald-400', bg: 'bg-emerald-600/10', border: 'border-emerald-600/30' },
  Cancelada:  { text: 'text-red-400',     bg: 'bg-red-600/10',     border: 'border-red-600/30' },
}

const TIPO_ORDEN_COLOR = {
  Instalacion:     { bg: 'bg-blue-600/10',   text: 'text-blue-400',   border: 'border-blue-600/30',   icon: Wrench },
  Retiro:          { bg: 'bg-amber-600/10',  text: 'text-amber-400',  border: 'border-amber-600/30',  icon: Package },
  ServicioTecnico: { bg: 'bg-sky-600/10',    text: 'text-sky-400',    border: 'border-sky-600/30',    icon: MonitorCog },
  Mantenimiento:   { bg: 'bg-violet-600/10', text: 'text-violet-400', border: 'border-violet-600/30', icon: Stethoscope },
}

function TipoBadge({ tipo }) {
  const c = TIPO_COLOR[tipo] ?? TIPO_COLOR.Mixto
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      <Icon size={10} />{tipo}
    </span>
  )
}

function EstadoServicioBadge({ estado }) {
  const c = ESTADO_SERVICIO_COLOR[estado] ?? ESTADO_SERVICIO_COLOR.Pendiente
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      <Icon size={10} />{estado}
    </span>
  )
}

function EstadoOrdenBadge({ estado }) {
  const c = ESTADO_ORDEN_COLOR[estado] ?? ESTADO_ORDEN_COLOR.Pendiente
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      {estado}
    </span>
  )
}

function TipoOrdenBadge({ tipo }) {
  const c = TIPO_ORDEN_COLOR[tipo] ?? TIPO_ORDEN_COLOR.Instalacion
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      <Icon size={10} />{tipo}
    </span>
  )
}

const TH = 'px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider'
const TD = 'px-4 py-3 text-sm text-slate-300'

function Paginador({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
      <span className="text-xs text-slate-500">{meta.total} registros · Página {meta.page} de {meta.totalPages}</span>
      <div className="flex gap-1">
        <button onClick={() => onPage(meta.page - 1)} disabled={meta.page === 1} className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronLeft size={15} /></button>
        <button onClick={() => onPage(meta.page + 1)} disabled={meta.page === meta.totalPages} className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronRight size={15} /></button>
      </div>
    </div>
  )
}

function SearchBar({ value, onChange, placeholder }) {
  return (
    <div className="relative flex-1 max-w-xs">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full pl-8 pr-8 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
      {value && <button onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-100"><X size={13} /></button>}
    </div>
  )
}

// ─── Tab: Planes ──────────────────────────────────────────────────────────────

function TabPlanes() {
  const [planes, setPlanes] = useState([])
  const [meta, setMeta] = useState(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [modal, setModal] = useState(null)
  const searchRef = useRef('')

  const cargar = useCallback(async (p = 1, q = '') => {
    setLoading(true)
    try {
      const r = await apiFetch(`/api/planes?page=${p}&search=${encodeURIComponent(q)}`)
      const json = await r.json()
      setPlanes(json.data ?? [])
      setMeta(json.meta ?? null)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { cargar(page, search) }, [page])
  useEffect(() => {
    if (search === searchRef.current) return
    searchRef.current = search
    const t = setTimeout(() => { setPage(1); cargar(1, search) }, 300)
    return () => clearTimeout(t)
  }, [search])

  async function toggle(plan) {
    await apiFetch(`/api/planes/${plan.id}/toggle`, { method: 'PATCH' })
    cargar(page, search)
  }

  function onSaved() { setModal(null); cargar(page, search) }

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <SearchBar value={search} onChange={setSearch} placeholder="Buscar plan..." />
        <div className="flex gap-2">
          <button onClick={() => cargar(page, search)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"><RefreshCw size={15} /></button>
          <button onClick={() => setModal('nuevo')} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"><Plus size={15} />Nuevo Plan</button>
        </div>
      </div>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-800/60">
              <tr>
                <th className={TH}>Plan</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Mensual Base</th>
                <th className={TH}>Instalación Base</th>
                <th className={TH}>Equipos</th>
                <th className={TH}>Estado</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-600">Cargando...</td></tr>
              ) : planes.length === 0 ? (
                <tr><td colSpan={7}><EmptyState title="Sin planes" description="Crea el primer plan de servicio." /></td></tr>
              ) : planes.map(p => (
                <tr key={p.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className={TD + ' font-medium text-slate-100'}>{p.nombre}</td>
                  <td className={TD}><TipoBadge tipo={p.tipo} /></td>
                  <td className={TD + ' font-mono'}>RD$ {fmt(p.precioMensualBase)}</td>
                  <td className={TD + ' font-mono'}>RD$ {fmt(p.precioInstalBase)}</td>
                  <td className={TD + ' text-slate-400'}>{p.plantillaEquipos?.length ?? 0} equipo(s)</td>
                  <td className={TD}>
                    {p.activo
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-600/10 text-emerald-400 border-emerald-600/30"><CheckCircle size={10} />Activo</span>
                      : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-700/30 text-slate-500 border-slate-600/30"><XCircle size={10} />Inactivo</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => setModal(p)} className="p-1.5 rounded-md text-slate-500 hover:text-blue-400 hover:bg-blue-600/10 transition-colors"><Pencil size={14} /></button>
                      <button onClick={() => toggle(p)} className="p-1.5 rounded-md text-slate-500 hover:text-slate-100 hover:bg-slate-800 transition-colors">
                        {p.activo ? <ToggleRight size={16} className="text-emerald-400" /> : <ToggleLeft size={16} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Paginador meta={meta} onPage={setPage} />
      </div>
      {modal && <FormularioPlan plan={modal === 'nuevo' ? null : modal} onClose={() => setModal(null)} onSaved={onSaved} />}
    </>
  )
}

// ─── Tab: Servicios ───────────────────────────────────────────────────────────

function TabServicios() {
  const [servicios, setServicios] = useState([])
  const [meta, setMeta] = useState(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [modal, setModal] = useState(null)
  const searchRef = useRef('')

  const cargar = useCallback(async (p = 1, q = '') => {
    setLoading(true)
    try {
      const r = await apiFetch(`/api/servicios?page=${p}&search=${encodeURIComponent(q)}`)
      const json = await r.json()
      setServicios(json.data ?? [])
      setMeta(json.meta ?? null)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { cargar(page, search) }, [page])
  useEffect(() => {
    if (search === searchRef.current) return
    searchRef.current = search
    const t = setTimeout(() => { setPage(1); cargar(1, search) }, 300)
    return () => clearTimeout(t)
  }, [search])

  function onSaved() { setModal(null); cargar(page, search) }

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <SearchBar value={search} onChange={setSearch} placeholder="Buscar por cliente o plan..." />
        <div className="flex gap-2">
          <button onClick={() => cargar(page, search)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"><RefreshCw size={15} /></button>
          <button onClick={() => setModal('nuevo')} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"><Plus size={15} />Nuevo Servicio</button>
        </div>
      </div>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-800/60">
              <tr>
                <th className={TH}>Código</th>
                <th className={TH}>Cliente</th>
                <th className={TH}>Plan</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Estado</th>
                <th className={TH}>Mensual</th>
                <th className={TH}>Instalación</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-600">Cargando...</td></tr>
              ) : servicios.length === 0 ? (
                <tr><td colSpan={8}><EmptyState title="Sin servicios activos" description="Activa el primer servicio para un cliente." /></td></tr>
              ) : servicios.map(s => (
                <tr key={s.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className={TD}>
                    <span className="text-xs font-mono font-bold text-blue-400 bg-blue-600/10 border border-blue-600/20 px-2 py-0.5 rounded">
                      {s.noServicio ?? '—'}
                    </span>
                  </td>
                  <td className={TD}>
                    <p className="font-medium text-slate-100 leading-tight">{s.cliente?.razonSocial}</p>
                    <p className="text-xs text-slate-600 font-mono">{s.cliente?.noCliente}</p>
                  </td>
                  <td className={TD + ' text-slate-200'}>{s.plan?.nombre}</td>
                  <td className={TD}><TipoBadge tipo={s.plan?.tipo} /></td>
                  <td className={TD}><EstadoServicioBadge estado={s.estado} /></td>
                  <td className={TD + ' font-mono'}>RD$ {fmt(s.precioMensual)}</td>
                  <td className={TD + ' font-mono'}>RD$ {fmt(s.precioInstalacion)}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => setModal(s)} className="p-1.5 rounded-md text-slate-500 hover:text-blue-400 hover:bg-blue-600/10 transition-colors"><Pencil size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Paginador meta={meta} onPage={setPage} />
      </div>
      {modal && <FormularioServicio servicio={modal === 'nuevo' ? null : modal} onClose={() => setModal(null)} onSaved={onSaved} />}
    </>
  )
}

// ─── Tab: Órdenes ─────────────────────────────────────────────────────────────

function TabOrdenes() {
  const [ordenes, setOrdenes]   = useState([])
  const [meta, setMeta]         = useState(null)
  const [page, setPage]         = useState(1)
  const [search, setSearch]     = useState('')
  const [loading, setLoading]   = useState(false)
  const [modal, setModal]       = useState(null)
  const [printOrden, setPrintOrden] = useState(null)
  const searchRef  = useRef('')
  const conduceRef = useRef(null)
  const printReady = useRef(false)

  const handlePrint = useReactToPrint({ contentRef: conduceRef, documentTitle: 'Conduce-ACR' })

  useEffect(() => {
    if (printReady.current && printOrden) {
      printReady.current = false
      handlePrint()
    }
  }, [printOrden, handlePrint])

  function imprimirConduce(orden) {
    printReady.current = true
    setPrintOrden(orden)
  }

  const cargar = useCallback(async (p = 1, q = '') => {
    setLoading(true)
    try {
      const r = await apiFetch(`/api/ordenes?page=${p}&search=${encodeURIComponent(q)}`)
      const json = await r.json()
      setOrdenes(json.data ?? [])
      setMeta(json.meta ?? null)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { cargar(page, search) }, [page])
  useEffect(() => {
    if (search === searchRef.current) return
    searchRef.current = search
    const t = setTimeout(() => { setPage(1); cargar(1, search) }, 300)
    return () => clearTimeout(t)
  }, [search])

  function onSaved() { setModal(null); cargar(page, search) }

  return (
    <>
      <div style={{ position: 'absolute', left: '-9999px', top: 0, pointerEvents: 'none' }}>
        <ConduceOrden ref={conduceRef} orden={printOrden} />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <SearchBar value={search} onChange={setSearch} placeholder="Buscar por cliente, plan o técnico..." />
        <div className="flex gap-2">
          <button onClick={() => cargar(page, search)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"><RefreshCw size={15} /></button>
          <button onClick={() => setModal('nuevo')} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"><Plus size={15} />Nueva Orden</button>
        </div>
      </div>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-800/60">
              <tr>
                <th className={TH}>ID</th>
                <th className={TH}>Cliente · Plan</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Estado</th>
                <th className={TH}>Técnico</th>
                <th className={TH}>Equipos</th>
                <th className={TH}>Fecha</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-600">Cargando...</td></tr>
              ) : ordenes.length === 0 ? (
                <tr><td colSpan={8}><EmptyState title="Sin órdenes de trabajo" description="Crea una nueva OT para comenzar." /></td></tr>
              ) : ordenes.map(o => (
                <tr key={o.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className={TD + ' font-mono text-xs text-slate-500'}>{o.id.slice(0,8).toUpperCase()}</td>
                  <td className={TD}>
                    <p className="font-medium text-slate-100 leading-tight">{o.servicio?.cliente?.razonSocial}</p>
                    <p className="text-xs text-slate-500">{o.servicio?.plan?.nombre}</p>
                  </td>
                  <td className={TD}><TipoOrdenBadge tipo={o.tipo} /></td>
                  <td className={TD}><EstadoOrdenBadge estado={o.estado} /></td>
                  <td className={TD + ' text-slate-400'}>{o.tecnico?.nombre}</td>
                  <td className={TD + ' text-slate-400'}>{o.detalles?.length ?? 0}</td>
                  <td className={TD + ' text-xs text-slate-500'}>{new Date(o.createdAt).toLocaleDateString('es-DO')}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => imprimirConduce(o)} className="p-1.5 rounded-md text-slate-500 hover:text-emerald-400 hover:bg-emerald-600/10 transition-colors" title="Imprimir Conduce">
                        <Printer size={14} />
                      </button>
                      <button onClick={() => setModal(o)} className="p-1.5 rounded-md text-slate-500 hover:text-blue-400 hover:bg-blue-600/10 transition-colors">
                        {o.estado === 'Completada' ? <Eye size={14} /> : <Pencil size={14} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Paginador meta={meta} onPage={setPage} />
      </div>
      {modal && <FormularioOrden orden={modal === 'nuevo' ? null : modal} onClose={() => setModal(null)} onSaved={onSaved} />}
    </>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'planes',    label: 'Planes',    icon: ClipboardList },
  { id: 'servicios', label: 'Servicios', icon: Wrench },
  { id: 'ordenes',   label: 'Órdenes',   icon: Package },
]

export default function Servicios() {
  const { tienePermiso } = useAuth()
  const [tab, setTab] = useState('planes')

  if (!tienePermiso('servicios:ver')) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
      <ShieldOff size={32} />
      <p className="text-sm font-medium">Sin acceso al módulo Servicios</p>
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Servicios e Instalaciones</h1>
        <p className="text-sm text-slate-500 mt-0.5">Planes, contratos de servicio y órdenes de trabajo técnico</p>
      </div>
      <div className="flex gap-1 border-b border-slate-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === id ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            <Icon size={15} />{label}
          </button>
        ))}
      </div>
      {tab === 'planes'    && <TabPlanes />}
      {tab === 'servicios' && <TabServicios />}
      {tab === 'ordenes'   && <TabOrdenes />}
    </div>
  )
}
