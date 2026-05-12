import { useEffect, useState, useMemo } from "react"
import { Loader2, Search, RefreshCw, Shield, ShieldCheck, ShieldAlert, Globe, ChevronDown, ChevronRight, Activity } from "lucide-react"
import { apiFetch } from "../../utils/api"

const METHOD_COLOR = {
  GET:    'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  POST:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
  PATCH:  'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  PUT:    'bg-orange-500/15 text-orange-400 border-orange-500/30',
  DELETE: 'bg-red-500/15 text-red-400 border-red-500/30',
}

const AUTH_BADGE = {
  JWT:         { Icon: ShieldCheck, color: 'text-blue-400 border-blue-500/30 bg-blue-500/10',         label: 'Admin' },
  PortalJWT:   { Icon: ShieldCheck, color: 'text-purple-400 border-purple-500/30 bg-purple-500/10',   label: 'Portal' },
  'rate-limit':{ Icon: ShieldAlert, color: 'text-orange-400 border-orange-500/30 bg-orange-500/10',   label: 'RateLimit' },
  public:      { Icon: Globe,       color: 'text-slate-400 border-slate-600/30 bg-slate-700/30',      label: 'Público' },
}

export default function PanelApiEstado() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [methodFilter, setMethodFilter] = useState('')
  const [authFilter, setAuthFilter]     = useState('')
  const [openGroups, setOpenGroups]     = useState({})

  async function cargar() {
    setLoading(true)
    try {
      const r = await apiFetch('/api/_meta/endpoints')
      if (r.ok) setData(await r.json())
      else      setData({ endpoints: [], total: 0, _error: 'No autorizado' })
    } catch { setData({ endpoints: [], total: 0, _error: 'Error de red' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { cargar() }, [])

  const filtered = useMemo(() => {
    if (!data?.endpoints) return []
    return data.endpoints.filter(e => {
      if (methodFilter && e.method !== methodFilter) return false
      if (authFilter   && e.auth   !== authFilter)   return false
      if (search) {
        const q = search.toLowerCase()
        if (!e.path.toLowerCase().includes(q) && !e.method.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [data, search, methodFilter, authFilter])

  const grouped = useMemo(() => {
    return filtered.reduce((acc, e) => {
      const grupo = e.path.split('/')[2] || 'root'
      ;(acc[grupo] = acc[grupo] || []).push(e)
      return acc
    }, {})
  }, [filtered])

  const groups = Object.keys(grouped).sort()

  function toggleGroup(g) { setOpenGroups(p => ({ ...p, [g]: !p[g] })) }
  function expandAll()   { setOpenGroups(Object.fromEntries(groups.map(g => [g, true]))) }
  function collapseAll() { setOpenGroups({}) }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-blue-400" />
          <h2 className="text-lg font-bold text-slate-100">Estado de API · {data?.total ?? 0} endpoints</h2>
        </div>
        <button onClick={cargar} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />Refrescar
        </button>
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar ruta o método..."
            className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
        </div>
        <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300">
          <option value="">Todos los métodos</option>
          {['GET','POST','PATCH','PUT','DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={authFilter} onChange={e => setAuthFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300">
          <option value="">Todo nivel de auth</option>
          <option value="JWT">JWT (Admin)</option>
          <option value="PortalJWT">PortalJWT (B2C)</option>
          <option value="rate-limit">Solo rate-limit</option>
          <option value="public">Público</option>
        </select>
      </div>

      <div className="flex gap-2 text-xs">
        <button onClick={expandAll}   className="text-slate-500 hover:text-slate-200">Expandir todo</button>
        <span className="text-slate-700">·</span>
        <button onClick={collapseAll} className="text-slate-500 hover:text-slate-200">Colapsar</button>
        <span className="ml-auto text-slate-600">Mostrando {filtered.length} de {data?.total ?? 0}</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
      ) : (data?._error || !data?.endpoints?.length) ? (
        <p className="text-center text-sm text-slate-600 py-12">{data?._error ?? 'Sin endpoints registrados.'}</p>
      ) : groups.map(g => {
        const items = grouped[g]
        const open  = openGroups[g] !== false
        return (
          <div key={g} className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
            <button onClick={() => toggleGroup(g)} className="w-full flex items-center gap-2 px-4 py-3 hover:bg-slate-800/60 text-left">
              {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
              <span className="text-sm font-bold text-slate-200 uppercase tracking-wider">/api/{g}</span>
              <span className="ml-auto text-xs text-slate-500">{items.length} endpoint{items.length !== 1 ? 's' : ''}</span>
            </button>
            {open && (
              <div className="divide-y divide-slate-800/60 border-t border-slate-700/40">
                {items.map((e, i) => {
                  const authConf = AUTH_BADGE[e.auth] ?? AUTH_BADGE.public
                  const AuthIcon = authConf.Icon
                  return (
                    <div key={`${e.method}-${e.path}-${i}`} className="px-4 py-2.5 flex items-center gap-3 hover:bg-slate-800/30">
                      <span className={`inline-flex items-center justify-center min-w-[56px] px-2 py-0.5 rounded text-[10px] font-bold border ${METHOD_COLOR[e.method] ?? 'bg-slate-700/30 text-slate-400 border-slate-600/30'}`}>
                        {e.method}
                      </span>
                      <code className="text-xs font-mono text-slate-200 flex-1 truncate">{e.path}</code>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${authConf.color}`}>
                        <AuthIcon size={10} />{authConf.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
