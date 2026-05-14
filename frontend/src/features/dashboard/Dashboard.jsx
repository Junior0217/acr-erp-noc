import { useState, useEffect } from 'react'
import { Users, Package, ClipboardList, Wifi, DollarSign, AlertTriangle, Wrench, TrendingUp, Loader2, RefreshCw, Receipt, CheckCircle, XCircle, Hammer, BellRing } from 'lucide-react'
import { apiFetch } from '@shared/utils/api'
const fmt = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 0 })
const fmtMoney = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })

const ACCENT = {
  emerald: { bg: 'bg-emerald-600/10', border: 'border-emerald-600/30', icon: 'text-emerald-400', badge: 'bg-emerald-600/20 text-emerald-300' },
  blue:    { bg: 'bg-blue-600/10',    border: 'border-blue-600/30',    icon: 'text-blue-400',    badge: 'bg-blue-600/20 text-blue-300'    },
  amber:   { bg: 'bg-amber-600/10',   border: 'border-amber-600/30',   icon: 'text-amber-400',   badge: 'bg-amber-600/20 text-amber-300'   },
  cyan:    { bg: 'bg-cyan-600/10',    border: 'border-cyan-600/30',    icon: 'text-cyan-400',    badge: 'bg-cyan-600/20 text-cyan-300'    },
  violet:  { bg: 'bg-violet-600/10', border: 'border-violet-600/30',  icon: 'text-violet-400',  badge: 'bg-violet-600/20 text-violet-300' },
  red:     { bg: 'bg-red-600/10',    border: 'border-red-600/30',     icon: 'text-red-400',     badge: 'bg-red-600/20 text-red-300'      },
}

const ESTADO_COLOR = {
  activos:       { bar: 'bg-emerald-500', label: 'Activos',        text: 'text-emerald-400' },
  enInstalacion: { bar: 'bg-amber-500',   label: 'En Instalación', text: 'text-amber-400'   },
  pendientes:    { bar: 'bg-slate-500',   label: 'Pendientes',     text: 'text-slate-400'   },
  suspendidos:   { bar: 'bg-red-500',     label: 'Suspendidos',    text: 'text-red-400'     },
  cancelados:    { bar: 'bg-slate-700',   label: 'Cancelados',     text: 'text-slate-600'   },
}

export default function Dashboard() {
  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [ts, setTs]           = useState(null)

  async function fetchData() {
    setLoading(true)
    setError(null)
    try {
      const r = await apiFetch('/api/dashboard')
      const j = await r.json()
      if (!r.ok || j.error) {
        setError(j.error || `Error ${r.status}`)
        setLoading(false)
        return
      }
      setData(j)
      setTs(new Date())
    } catch (e) {
      setError(e.message || 'No se pudo conectar con el servidor.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  if (loading && !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-4 space-y-3">
              <div className="flex justify-between items-start">
                <div className="h-3 w-24 bg-slate-700 rounded" />
                <div className="h-7 w-7 bg-slate-700 rounded-lg" />
              </div>
              <div className="h-7 w-20 bg-slate-700 rounded" />
              <div className="h-3 w-16 bg-slate-700/60 rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-4 space-y-3">
              <div className="h-3 w-28 bg-slate-700 rounded" />
              <div className="h-7 w-24 bg-slate-700 rounded" />
              <div className="h-3 w-16 bg-slate-700/60 rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-5 space-y-4">
              <div className="h-4 w-32 bg-slate-700 rounded" />
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="flex justify-between items-center">
                  <div className="h-3 w-24 bg-slate-700 rounded" />
                  <div className="h-3 w-12 bg-slate-700/60 rounded" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const servicios = data?.servicios ?? {}
  const clientes  = data?.clientes  ?? {}

  const kpis = data?.servicios ? [
    { label: 'Servicios Activos',        value: fmt(servicios.activos ?? 0),                              delta: null,      Icon: Wifi,          accent: 'emerald' },
    { label: 'Ingresos Estimados (RD$)', value: fmtMoney(data.ingresosMensualesEstimados ?? 0),           delta: '/mes',    Icon: DollarSign,    accent: 'blue'    },
    { label: 'Órdenes Pendientes',       value: fmt(data.ordenesPendientes ?? 0),                         delta: null,      Icon: ClipboardList, accent: 'amber'   },
    { label: 'Clientes Activos',         value: fmt(clientes.activos ?? 0), delta: `/ ${fmt(clientes.total ?? 0)} total`, Icon: Users, accent: 'cyan' },
  ] : []

  const billingKpis = data?.billing ? [
    {
      label:  'Facturado este mes',
      value:  fmtMoney(data.billing.facturadoMes),
      delta:  `${fmt(data.billing.facturasEmitidasMes)} facturas`,
      Icon:   Receipt,
      accent: 'blue',
    },
    {
      label:  'Cobrado este mes',
      value:  fmtMoney(data.billing.cobradoMes),
      delta:  'Pagadas',
      Icon:   CheckCircle,
      accent: 'emerald',
    },
    {
      label:  'Facturas Vencidas',
      value:  fmt(data.billing.vencidasCount),
      delta:  data.billing.vencidasCount > 0 ? `RD$ ${fmtMoney(data.billing.vencidasMonto)}` : null,
      Icon:   XCircle,
      accent: data.billing.vencidasCount > 0 ? 'red' : 'cyan',
    },
    {
      label:  'OTs Activas',
      value:  fmt(data.billing.otsEnProceso),
      delta:  `${fmt(data.billing.otsPendientes)} pendientes`,
      Icon:   Hammer,
      accent: 'violet',
    },
  ] : []

  const totalServicios = Object.values(servicios).reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100 tracking-tight">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5 font-mono">Vista general operativa · NOC</p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-800 border border-slate-700 transition-colors"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          {ts ? ts.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }) : 'Actualizar'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-900/30 border border-red-600/50 text-red-300">
          <AlertTriangle size={16} className="text-red-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-200">Error al cargar el dashboard</p>
            <p className="text-xs font-mono text-red-400 truncate">{error}</p>
          </div>
          <button
            onClick={fetchData}
            className="text-xs text-red-300 hover:text-red-100 border border-red-600/40 hover:border-red-500 px-2 py-1 rounded transition-colors flex-shrink-0"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* NCF Alert Banner */}
      {data?.ncfAlerts?.length > 0 && (
        <div className="flex flex-col gap-2">
          {data.ncfAlerts.map(a => (
            <div key={a.tipoNcf} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-900/30 border border-red-600/50 text-red-300">
              <BellRing size={16} className="text-red-400 flex-shrink-0 animate-pulse" />
              <p className="text-sm font-semibold">
                <span className="font-mono text-red-200">{a.tipoNcf}</span>
                {' '}— Secuencia NCF al{' '}
                <span className="text-red-100 font-bold">{a.pct}%</span>
                {'. Solo quedan '}
                <span className="text-red-100 font-bold">{a.restantes.toLocaleString()}</span>
                {' comprobantes. Solicita un nuevo rango a la DGII urgente.'}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* KPI Cards */}
      {kpis.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {kpis.map(({ label, value, delta, Icon, accent }) => {
            const c = ACCENT[accent]
            return (
              <div key={label} className={`rounded-lg border ${c.border} ${c.bg} p-5 flex flex-col gap-4 relative overflow-hidden`}>
                <div className="flex items-start justify-between">
                  <p className="text-xs font-mono text-slate-400 uppercase tracking-widest leading-tight">{label}</p>
                  <div className={`w-8 h-8 rounded-md flex items-center justify-center ${c.bg} border ${c.border}`}>
                    <Icon size={15} className={c.icon} />
                  </div>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-3xl font-bold text-slate-100 tracking-tight">{value}</span>
                  {delta && <span className={`text-xs font-mono px-2 py-0.5 rounded ${c.badge}`}>{delta}</span>}
                </div>
                <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-transparent via-current to-transparent opacity-20" />
              </div>
            )
          })}
        </div>
      )}

      {/* Billing KPI Cards */}
      {billingKpis.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {billingKpis.map(({ label, value, delta, Icon, accent }) => {
            const c = ACCENT[accent]
            return (
              <div key={label} className={`rounded-lg border ${c.border} ${c.bg} p-5 flex flex-col gap-4 relative overflow-hidden`}>
                <div className="flex items-start justify-between">
                  <p className="text-xs font-mono text-slate-400 uppercase tracking-widest leading-tight">{label}</p>
                  <div className={`w-8 h-8 rounded-md flex items-center justify-center ${c.bg} border ${c.border}`}>
                    <Icon size={15} className={c.icon} />
                  </div>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-2xl font-bold text-slate-100 tracking-tight tabular-nums">{value}</span>
                  {delta && <span className={`text-xs font-mono px-2 py-0.5 rounded ${c.badge}`}>{delta}</span>}
                </div>
                <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-transparent via-current to-transparent opacity-20" />
              </div>
            )
          })}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Distribución de Servicios */}
        {data?.servicios && (
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300">Distribución de Servicios</h2>
              <span className="text-xs text-slate-500">{fmt(totalServicios)} total</span>
            </div>
            <div className="space-y-3">
              {Object.entries(ESTADO_COLOR).map(([key, cfg]) => {
                const count = servicios[key] ?? 0
                const pct   = totalServicios > 0 ? (count / totalServicios) * 100 : 0
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
                      <span className="text-xs text-slate-500 tabular-nums">{count}</span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${cfg.bar}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500">
              <span className="flex items-center gap-1.5"><Wrench size={12} className="text-slate-500" /> {data.tecnicos} técnico{data.tecnicos !== 1 ? 's' : ''} registrado{data.tecnicos !== 1 ? 's' : ''}</span>
              <span className="flex items-center gap-1.5"><TrendingUp size={12} className="text-slate-500" />{fmt(data.ingresosMensualesEstimados ?? 0)} RD$ estimados</span>
            </div>
          </div>
        )}

        {/* Stock Crítico */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <AlertTriangle size={14} className="text-orange-400" />
              Stock Crítico (≤ 5 unidades)
            </h2>
            {data?.stockCritico && <span className="text-xs text-slate-500">{data.stockCritico.length} productos</span>}
          </div>
          {!data && !error && <div className="py-6 flex justify-center"><Loader2 size={18} className="animate-spin text-slate-500" /></div>}
          {data?.stockCritico?.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-600">
              Todos los productos tienen stock suficiente.
            </div>
          )}
          {data?.stockCritico?.length > 0 && (
            <div className="space-y-2">
              {data.stockCritico.map(p => (
                <div key={p.id} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
                  p.stockActual === 0
                    ? 'bg-red-900/20 border-red-700/30'
                    : 'bg-orange-900/10 border-orange-700/20'
                }`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-200 font-medium truncate">{p.nombre}</p>
                    <p className="text-xs text-slate-500 font-mono">{p.sku}</p>
                  </div>
                  <span className={`ml-3 text-lg font-bold tabular-nums flex-shrink-0 ${
                    p.stockActual === 0 ? 'text-red-400' : 'text-orange-400'
                  }`}>
                    {p.stockActual}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
