import {
  Package, Wrench, Wifi, Camera, Zap, ShoppingCart, AlertCircle, Inbox,
} from 'lucide-react'

// ── Constants ─────────────────────────────────────────────────────────────────

export const TIPOS      = ['Recurrente', 'VentaUnica', 'Servicio']
export const CATEGORIAS = ['WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV', 'Mixto']
export const TIPOS_OT   = ['ISP', 'CCTV', 'Reparacion', 'CercoElectrico', 'VentaDirecta', 'General']
export const ESTADOS_OT = ['Pendiente', 'EnProceso', 'Completada', 'Cancelada']

export const META_DEFAULTS = {
  ISP:            { ip: '', macAddress: '', router: '', diaCorte: '' },
  CCTV:           { cantidadCamaras: '', tipoGrabacion: 'NVR', ipNVR: '' },
  Reparacion:     { equipoTipo: '', falla: '', diagnostico: '' },
  CercoElectrico: { voltaje: '', zonas: '', marca: '' },
  VentaDirecta:   { metodoPago: 'Efectivo', entrega: '' },
  General:        {},
}

export const TIPO_COLORS = {
  Recurrente: { text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  VentaUnica:  { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  Servicio:    { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
}

export const CAT_COLORS = {
  WISP:          { text: 'text-cyan-400',    bg: 'bg-cyan-500/15',    border: 'border-cyan-500/30'    },
  CCTV:          { text: 'text-violet-400',  bg: 'bg-violet-500/15',  border: 'border-violet-500/30'  },
  Redes:         { text: 'text-sky-400',     bg: 'bg-sky-500/15',     border: 'border-sky-500/30'     },
  CercoElectrico:{ text: 'text-orange-400',  bg: 'bg-orange-500/15',  border: 'border-orange-500/30'  },
  VentaDirecta:  { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  SoporteTecnico:{ text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  Reparacion:    { text: 'text-red-400',     bg: 'bg-red-500/15',     border: 'border-red-500/30'     },
  ProyectoCCTV:  { text: 'text-purple-400',  bg: 'bg-purple-500/15',  border: 'border-purple-500/30'  },
  Mixto:         { text: 'text-slate-400',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
}

export const OT_TIPO_META = {
  ISP:            { icon: Wifi,         color: 'cyan',    label: 'ISP / WISP'      },
  CCTV:           { icon: Camera,       color: 'violet',  label: 'CCTV'            },
  Reparacion:     { icon: Wrench,       color: 'amber',   label: 'Reparación'      },
  CercoElectrico: { icon: Zap,          color: 'orange',  label: 'Cerco Eléc.'     },
  VentaDirecta:   { icon: ShoppingCart, color: 'emerald', label: 'Venta Directa'   },
  General:        { icon: Package,      color: 'slate',   label: 'General'         },
}

export const OT_TIPO_COLOR_MAP = {
  cyan:    { text: 'text-cyan-400',    bg: 'bg-cyan-500/15',    border: 'border-cyan-500/30'    },
  violet:  { text: 'text-violet-400',  bg: 'bg-violet-500/15',  border: 'border-violet-500/30'  },
  amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
  orange:  { text: 'text-orange-400',  bg: 'bg-orange-500/15',  border: 'border-orange-500/30'  },
  emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  slate:   { text: 'text-slate-400',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
}

export const OT_ESTADO_COLORS = {
  Pendiente:  { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
  EnProceso:  { text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  Completada: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  Cancelada:  { text: 'text-slate-500',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
}

export const FACTURA_ESTADOS = ['Borrador', 'Emitida', 'Pagada', 'Vencida', 'Anulada']

export const FACTURA_ESTADO_COLORS = {
  Borrador: { text: 'text-slate-400',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
  Emitida:  { text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  Pagada:   { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  Vencida:  { text: 'text-red-400',     bg: 'bg-red-500/15',     border: 'border-red-500/30'     },
  Anulada:  { text: 'text-slate-600',   bg: 'bg-slate-700/20',   border: 'border-slate-700/30'   },
}

export const PAGE_SIZE = 20

// ── Style constants ───────────────────────────────────────────────────────────

export const TH = 'text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap'

export const LABEL_CLS  = 'block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5'
export const INPUT_BASE = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors'
export const INPUT_CLS  = `w-full ${INPUT_BASE}`
export const SELECT_CLS = `w-full ${INPUT_BASE}`

// ── Functions ─────────────────────────────────────────────────────────────────

export function formatCurrency(v) {
  return new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP', minimumFractionDigits: 0 }).format(Number(v) || 0)
}

export function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── Inventory category color map (Prisma Categoria.nombre) ───────────────────

export const INV_CAT_COLORS = {
  'WISP':                { text: 'text-cyan-400',    bg: 'bg-cyan-500/15',    border: 'border-cyan-500/30'    },
  'CCTV':                { text: 'text-violet-400',  bg: 'bg-violet-500/15',  border: 'border-violet-500/30'  },
  'Redes':               { text: 'text-sky-400',     bg: 'bg-sky-500/15',     border: 'border-sky-500/30'     },
  'Fibra Óptica':        { text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  'Equipos de Cómputo':  { text: 'text-slate-300',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
  'Videovigilancia (CCTV)': { text: 'text-violet-400', bg: 'bg-violet-500/15', border: 'border-violet-500/30' },
  'Redes y Switching':   { text: 'text-sky-400',     bg: 'bg-sky-500/15',     border: 'border-sky-500/30'     },
}

export function InvCatBadge({ nombre }) {
  const c = INV_CAT_COLORS[nombre] ?? { text: 'text-slate-400', bg: 'bg-slate-500/15', border: 'border-slate-500/30' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {nombre ?? '—'}
    </span>
  )
}

// ── Catalog badges ────────────────────────────────────────────────────────────

export function TipoBadge({ tipo }) {
  const c = TIPO_COLORS[tipo] || TIPO_COLORS.Servicio
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {tipo === 'VentaUnica' ? 'Venta Única' : tipo}
    </span>
  )
}

export function CatBadge({ cat }) {
  const c = CAT_COLORS[cat] || { text: 'text-slate-400', bg: 'bg-slate-500/15', border: 'border-slate-500/30' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {cat}
    </span>
  )
}

// ── OT badges ─────────────────────────────────────────────────────────────────

export function OtTipoBadge({ tipo }) {
  const m = OT_TIPO_META[tipo] ?? OT_TIPO_META.General
  const Icon = m.icon
  const c = OT_TIPO_COLOR_MAP[m.color] ?? OT_TIPO_COLOR_MAP.slate
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      <Icon size={10} />{m.label}
    </span>
  )
}

export function OtEstadoBadge({ estado }) {
  const c = OT_ESTADO_COLORS[estado] ?? OT_ESTADO_COLORS.Pendiente
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {estado}
    </span>
  )
}

export function ComingSoon({ title, desc }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-slate-600">
      <AlertCircle size={36} className="text-slate-700" />
      <div className="text-center">
        <p className="text-base font-semibold text-slate-500">{title}</p>
        <p className="text-sm mt-1">{desc}</p>
        <p className="text-xs mt-3 font-mono text-slate-700">Próximamente</p>
      </div>
    </div>
  )
}

export function EmptyState({ icon: Icon = Inbox, title = 'Sin registros', description }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-600">
      <div className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/50">
        <Icon size={28} className="text-slate-600" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-semibold text-slate-500">{title}</p>
        {description && <p className="text-xs text-slate-600">{description}</p>}
      </div>
    </div>
  )
}

export function FacturaEstadoBadge({ estado }) {
  const c = FACTURA_ESTADO_COLORS[estado] ?? FACTURA_ESTADO_COLORS.Borrador
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {estado}
    </span>
  )
}
