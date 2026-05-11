import { useState } from 'react'
import { toast } from 'sonner'
import {
  Zap, Wifi, Shield, Wrench, Globe, Phone, Mail, MapPin,
  CheckCircle, ChevronRight, ShoppingCart,
} from 'lucide-react'

const SERVICES = [
  {
    id: 1,
    category: 'WISP',
    icon: Wifi,
    color: 'blue',
    nombre: 'Internet Residencial Basic',
    descripcion: 'Velocidad 15 Mbps simétrico. Ideal para hogares con uso moderado.',
    precio: 1500,
    features: ['15 Mbps simétrico', 'IP dinámica', 'Soporte 24/7'],
  },
  {
    id: 2,
    category: 'WISP',
    icon: Wifi,
    color: 'blue',
    nombre: 'Internet Residencial Pro',
    descripcion: 'Velocidad 30 Mbps simétrico. Streaming y trabajo desde casa.',
    precio: 2500,
    features: ['30 Mbps simétrico', 'IP dinámica', 'Router incluido', 'Soporte 24/7'],
    badge: 'Popular',
  },
  {
    id: 3,
    category: 'WISP',
    icon: Globe,
    color: 'indigo',
    nombre: 'Internet Empresarial',
    descripcion: 'Velocidad 100 Mbps simétrico con IP estática. Para negocios exigentes.',
    precio: 6000,
    features: ['100 Mbps simétrico', 'IP estática', 'SLA 99.9%', 'Soporte prioritario'],
    badge: 'Business',
  },
  {
    id: 4,
    category: 'CCTV',
    icon: Shield,
    color: 'emerald',
    nombre: 'Kit CCTV Básico 4 Cámaras',
    descripcion: 'Sistema de vigilancia HD con DVR de 4 canales y disco duro 1TB.',
    precio: 18500,
    features: ['4 cámaras HD 1080p', 'DVR 4 canales', '1TB almacenamiento', 'Acceso remoto'],
  },
  {
    id: 5,
    category: 'CCTV',
    icon: Shield,
    color: 'emerald',
    nombre: 'Kit CCTV Profesional 8 Cámaras',
    descripcion: 'Vigilancia completa con cámaras IP, NVR y visión nocturna avanzada.',
    precio: 42000,
    features: ['8 cámaras IP 4K', 'NVR 8 canales', '2TB almacenamiento', 'Analíticas IA', 'Acceso nube'],
    badge: 'Pro',
  },
  {
    id: 6,
    category: 'Redes',
    icon: Wrench,
    color: 'amber',
    nombre: 'Instalación de Red LAN',
    descripcion: 'Cableado estructurado Cat6, puntos de red y configuración de switches.',
    precio: 12000,
    features: ['Cableado Cat6', 'Hasta 8 puntos', 'Switch incluido', 'Certificación'],
  },
  {
    id: 7,
    category: 'Redes',
    icon: Wrench,
    color: 'amber',
    nombre: 'WiFi Corporativo Mesh',
    descripcion: 'Red WiFi de alta densidad con puntos de acceso mesh UniFi para empresas.',
    precio: 25000,
    features: ['3 APs UniFi', 'Cobertura 200m²', 'Gestión centralizada', 'VLAN segmentada'],
    badge: 'Enterprise',
  },
  {
    id: 8,
    category: 'Soporte',
    icon: Wrench,
    color: 'purple',
    nombre: 'Mantenimiento Mensual',
    descripcion: 'Soporte técnico preventivo y correctivo con visitas programadas al mes.',
    precio: 3500,
    features: ['1 visita mensual', 'Soporte remoto', 'Reporte de estado', 'Prioridad alta'],
  },
]

const CATEGORIES = ['Todos', 'WISP', 'CCTV', 'Redes', 'Soporte']

const COLOR_MAP = {
  blue:    { bg: 'bg-blue-600/10',   border: 'border-blue-600/20',   icon: 'text-blue-400',   badge: 'bg-blue-600/20 text-blue-300 border-blue-600/30'   },
  indigo:  { bg: 'bg-indigo-600/10', border: 'border-indigo-600/20', icon: 'text-indigo-400', badge: 'bg-indigo-600/20 text-indigo-300 border-indigo-600/30' },
  emerald: { bg: 'bg-emerald-600/10',border: 'border-emerald-600/20',icon: 'text-emerald-400',badge: 'bg-emerald-600/20 text-emerald-300 border-emerald-600/30' },
  amber:   { bg: 'bg-amber-600/10',  border: 'border-amber-600/20',  icon: 'text-amber-400',  badge: 'bg-amber-600/20 text-amber-300 border-amber-600/30'   },
  purple:  { bg: 'bg-purple-600/10', border: 'border-purple-600/20', icon: 'text-purple-400', badge: 'bg-purple-600/20 text-purple-300 border-purple-600/30' },
}

const fmt = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 0 })

function ServiceCard({ service }) {
  const colors = COLOR_MAP[service.color] ?? COLOR_MAP.blue
  const Icon = service.icon

  function handleAdd() {
    toast.success(`"${service.nombre}" añadido. Te contactaremos pronto.`, { duration: 4000 })
  }

  return (
    <div className={`relative bg-slate-900 border ${colors.border} rounded-xl overflow-hidden flex flex-col hover:border-opacity-60 transition-all hover:shadow-lg hover:shadow-black/30 group`}>
      {service.badge && (
        <div className={`absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold border ${colors.badge}`}>
          {service.badge}
        </div>
      )}

      <div className={`p-5 ${colors.bg}`}>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colors.bg} border ${colors.border} mb-3`}>
          <Icon size={20} className={colors.icon} />
        </div>
        <div className="text-[10px] font-semibold text-slate-600 uppercase tracking-widest mb-1">{service.category}</div>
        <h3 className="text-base font-bold text-slate-100 leading-tight">{service.nombre}</h3>
        <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">{service.descripcion}</p>
      </div>

      <div className="p-5 flex-1 flex flex-col">
        <ul className="space-y-1.5 flex-1 mb-4">
          {service.features.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-slate-400">
              <CheckCircle size={12} className={colors.icon + ' flex-shrink-0'} />
              {f}
            </li>
          ))}
        </ul>

        <div className="flex items-end justify-between mt-auto">
          <div>
            <div className="text-[10px] text-slate-600 uppercase tracking-wider">Desde</div>
            <div className="text-xl font-black text-slate-100">RD$ {fmt(service.precio)}</div>
            <div className="text-[10px] text-slate-600">/mes o instalación</div>
          </div>
          <button
            onClick={handleAdd}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold ${colors.bg} border ${colors.border} ${colors.icon} hover:opacity-80 transition-all`}
          >
            <ShoppingCart size={14} />
            Añadir
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CustomerPortal() {
  const [catActiva, setCatActiva] = useState('Todos')
  const [contactVisible, setContactVisible] = useState(false)

  const serviciosFiltrados = catActiva === 'Todos'
    ? SERVICES
    : SERVICES.filter(s => s.category === catActiva)

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">

      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-600/30 flex items-center justify-center">
              <Zap size={16} className="text-blue-400" />
            </div>
            <div>
              <div className="text-sm font-black text-slate-100 leading-none">ACR Networks</div>
              <div className="text-[9px] text-slate-600 font-mono leading-none mt-0.5">& Solutions</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setContactVisible(v => !v)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <Phone size={14} /> Contactar
            </button>
          </div>
        </div>
      </header>

      {/* Contact overlay */}
      {contactVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setContactVisible(false)} />
          <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-lg font-bold text-slate-100">Contáctanos</h3>
            <div className="space-y-3">
              <a href="tel:+18095550000" className="flex items-center gap-3 p-3 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">
                <Phone size={16} className="text-blue-400" />
                <div>
                  <div className="text-sm font-medium text-slate-200">Teléfono</div>
                  <div className="text-xs text-slate-500">809-555-0000</div>
                </div>
              </a>
              <a href="mailto:ventas@acrnetworks.do" className="flex items-center gap-3 p-3 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">
                <Mail size={16} className="text-blue-400" />
                <div>
                  <div className="text-sm font-medium text-slate-200">Email</div>
                  <div className="text-xs text-slate-500">ventas@acrnetworks.do</div>
                </div>
              </a>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800">
                <MapPin size={16} className="text-blue-400" />
                <div>
                  <div className="text-sm font-medium text-slate-200">Oficina</div>
                  <div className="text-xs text-slate-500">Santo Domingo, Rep. Dom.</div>
                </div>
              </div>
            </div>
            <button onClick={() => setContactVisible(false)} className="w-full py-2 rounded-lg text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 py-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-600/10 border border-blue-600/20 text-blue-400 text-xs font-semibold mb-6">
          <Zap size={12} /> ISP · CCTV · Infraestructura de Redes
        </div>
        <h1 className="text-4xl sm:text-5xl font-black text-slate-100 leading-tight mb-4">
          Conectividad y Seguridad<br />
          <span className="text-blue-400">para tu negocio</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-xl mx-auto mb-8">
          Soluciones WISP, videovigilancia e infraestructura de redes para empresas y hogares en Santo Domingo.
        </p>
        <button
          onClick={() => document.getElementById('servicios')?.scrollIntoView({ behavior: 'smooth' })}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors"
        >
          Ver Servicios <ChevronRight size={16} />
        </button>
      </section>

      {/* Services */}
      <section id="servicios" className="max-w-6xl mx-auto px-4 pb-20">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-bold text-slate-100">Nuestros Servicios</h2>
        </div>

        {/* Category filter */}
        <div className="flex gap-2 flex-wrap mb-8">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => setCatActiva(cat)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                catActiva === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-slate-700'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {serviciosFiltrados.map(s => (
            <ServiceCard key={s.id} service={s} />
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-8">
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-blue-400" />
            <span className="text-sm text-slate-500 font-mono">ACR Networks & Solutions · Santo Domingo, DO</span>
          </div>
          <span className="text-xs text-slate-700 font-mono">v1.0.0 · {new Date().getFullYear()}</span>
        </div>
      </footer>
    </div>
  )
}
