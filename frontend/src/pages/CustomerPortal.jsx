// build: 2026-05-11
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, Polygon, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { toast } from 'sonner'
import {
  Zap, Wifi, Shield, Wrench, Globe, Phone, Mail, MapPin,
  CheckCircle, ChevronRight, ShoppingCart, X, LogIn, LogOut,
  Activity, FileText, CreditCard, MessageCircle, Star, Building2,
  Home, User, Lock, Eye, EyeOff, Loader2, AlertTriangle, Siren,
} from 'lucide-react'

const API = import.meta.env.VITE_API_URL ?? ''

// ─── Dominican provinces ──────────────────────────────────────────────────────

const RD_PROVINCIAS = [
  'Azua', 'Baoruco', 'Barahona', 'Dajabón', 'Distrito Nacional',
  'Duarte', 'El Seibo', 'Elías Piña', 'Espaillat', 'Hato Mayor',
  'Hermanas Mirabal', 'Independencia', 'La Altagracia', 'La Romana',
  'La Vega', 'María Trinidad Sánchez', 'Monseñor Nouel', 'Monte Cristi',
  'Monte Plata', 'Pedernales', 'Peravia', 'Puerto Plata', 'Samaná',
  'San Cristóbal', 'San José de Ocoa', 'San Juan', 'San Pedro de Macorís',
  'Sánchez Ramírez', 'Santiago', 'Santiago Rodríguez', 'Santo Domingo',
  'Valverde',
]

// ─── Coverage polygon: Cristo Rey, Santo Domingo ──────────────────────────────

const CRISTO_REY_POLYGON = [
  [18.4978, -69.9458], [18.4978, -69.9310],
  [18.4918, -69.9290], [18.4862, -69.9310],
  [18.4850, -69.9400], [18.4862, -69.9458],
  [18.4920, -69.9480],
]

// ─── Services catalog ─────────────────────────────────────────────────────────

const SERVICES = [
  { id: 1, category: 'WISP',    icon: Wifi,    color: 'blue',    nombre: 'Internet Residencial Basic',   descripcion: '15 Mbps simétrico. Ideal para hogares.',              precio: 1500,  features: ['15 Mbps simétrico', 'IP dinámica', 'Soporte 24/7'] },
  { id: 2, category: 'WISP',    icon: Wifi,    color: 'blue',    nombre: 'Internet Residencial Pro',     descripcion: '30 Mbps. Streaming y trabajo desde casa.',            precio: 2500,  features: ['30 Mbps simétrico', 'IP dinámica', 'Router incluido', 'Soporte 24/7'], badge: 'Popular' },
  { id: 3, category: 'WISP',    icon: Globe,   color: 'indigo',  nombre: 'Internet Empresarial',         descripcion: '100 Mbps + IP estática. Para negocios exigentes.',   precio: 6000,  features: ['100 Mbps simétrico', 'IP estática', 'SLA 99.8%', 'Soporte prioritario'], badge: 'Business' },
  { id: 4, category: 'CCTV',    icon: Shield,  color: 'emerald', nombre: 'Kit CCTV Básico 4 Cámaras',   descripcion: 'Sistema HD con DVR 4 canales y disco 1TB.',           precio: 18500, features: ['4 cámaras HD 1080p', 'DVR 4 canales', '1TB almacenamiento', 'Acceso remoto'] },
  { id: 5, category: 'CCTV',    icon: Shield,  color: 'emerald', nombre: 'Kit CCTV Pro 8 Cámaras',      descripcion: 'Cámaras IP 4K, NVR y visión nocturna avanzada.',      precio: 42000, features: ['8 cámaras IP 4K', 'NVR 8 canales', '2TB almacenamiento', 'Analíticas IA', 'Nube'], badge: 'Pro' },
  { id: 6, category: 'Redes',   icon: Wrench,  color: 'amber',   nombre: 'Instalación Red LAN',          descripcion: 'Cableado Cat6, puntos de red, switches configurados.', precio: 12000, features: ['Cableado Cat6', 'Hasta 8 puntos', 'Switch incluido', 'Certificación'] },
  { id: 7, category: 'Redes',   icon: Wrench,  color: 'amber',   nombre: 'WiFi Corporativo Mesh',        descripcion: 'APs UniFi mesh para alta densidad empresarial.',      precio: 25000, features: ['3 APs UniFi', 'Cobertura 200m²', 'Gestión centralizada', 'VLANs'], badge: 'Enterprise' },
  { id: 8, category: 'Soporte', icon: Wrench,  color: 'purple',  nombre: 'Mantenimiento Mensual',        descripcion: 'Soporte preventivo y correctivo con visita mensual.',  precio: 3500,  features: ['1 visita mensual', 'Soporte remoto', 'Reporte de estado', 'Prioridad alta'] },
]

const CATEGORIES = ['Todos', 'WISP', 'CCTV', 'Redes', 'Soporte']

const COLOR_MAP = {
  blue:    { bg: 'bg-blue-600/10',    border: 'border-blue-600/20',    icon: 'text-blue-400',    badge: 'bg-blue-600/20 text-blue-300 border-blue-600/30'    },
  indigo:  { bg: 'bg-indigo-600/10',  border: 'border-indigo-600/20',  icon: 'text-indigo-400',  badge: 'bg-indigo-600/20 text-indigo-300 border-indigo-600/30' },
  emerald: { bg: 'bg-emerald-600/10', border: 'border-emerald-600/20', icon: 'text-emerald-400', badge: 'bg-emerald-600/20 text-emerald-300 border-emerald-600/30' },
  amber:   { bg: 'bg-amber-600/10',   border: 'border-amber-600/20',   icon: 'text-amber-400',   badge: 'bg-amber-600/20 text-amber-300 border-amber-600/30'   },
  purple:  { bg: 'bg-purple-600/10',  border: 'border-purple-600/20',  icon: 'text-purple-400',  badge: 'bg-purple-600/20 text-purple-300 border-purple-600/30' },
}

const QUOTER_PLANS = [
  { id: 'basic',       label: 'Basic 15 Mbps',  base: 1500, icon: '🏠' },
  { id: 'pro',         label: 'Pro 30 Mbps',     base: 2500, icon: '💼', popular: true },
  { id: 'empresarial', label: 'Empresarial 100', base: 6000, icon: '🏢' },
  { id: 'fibra',       label: 'Fibra 200 Mbps',  base: 9500, icon: '⚡' },
]

const fmt = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 0 })

// ─── Tawk.to injection ────────────────────────────────────────────────────────

function TawktoWidget() {
  useEffect(() => {
    if (document.getElementById('tawkto-script')) return
    const s = document.createElement('script')
    s.id = 'tawkto-script'
    s.async = true
    s.src = 'https://embed.tawk.to/placeholder/default'
    s.charset = 'UTF-8'
    s.setAttribute('crossorigin', '*')
    document.body.appendChild(s)
    return () => { try { document.getElementById('tawkto-script')?.remove() } catch {} }
  }, [])
  return null
}

// ─── Coverage Map ─────────────────────────────────────────────────────────────

function CoverageMap() {
  return (
    <div className="relative rounded-xl overflow-hidden border border-slate-700/50" style={{ height: 340 }}>
      <MapContainer center={[18.488, -69.938]} zoom={14} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }} className="z-0">
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        />
        <Polygon
          positions={CRISTO_REY_POLYGON}
          pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.25, weight: 2 }}
        >
          <Tooltip permanent direction="center" className="bg-blue-900 text-blue-200 border-blue-600 text-xs font-semibold rounded-lg px-2 py-1">
            📡 Cobertura WISP — Cristo Rey
          </Tooltip>
        </Polygon>
      </MapContainer>
      <div className="absolute bottom-3 right-3 z-[400] flex flex-col gap-1.5">
        <span className="px-2.5 py-1 rounded-full bg-blue-600/90 text-white text-[10px] font-bold border border-blue-400/40 backdrop-blur-sm">🟦 Zona WISP Activa</span>
        <span className="px-2.5 py-1 rounded-full bg-slate-800/90 text-slate-300 text-[10px] font-bold border border-slate-600/40 backdrop-blur-sm">🌐 Venta Nacional de Equipos</span>
        <span className="px-2.5 py-1 rounded-full bg-emerald-600/90 text-white text-[10px] font-bold border border-emerald-400/40 backdrop-blur-sm">✅ SLA: 99.8% Estabilidad</span>
      </div>
    </div>
  )
}

// ─── Service card ─────────────────────────────────────────────────────────────

function ServiceCard({ service, onAdd, blockedByDebt }) {
  const colors = COLOR_MAP[service.color] ?? COLOR_MAP.blue
  const Icon   = service.icon
  return (
    <div className={`relative bg-slate-900 border ${colors.border} rounded-xl overflow-hidden flex flex-col hover:border-opacity-60 transition-all hover:shadow-lg hover:shadow-black/30 group`}>
      {service.badge && (
        <div className={`absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold border ${colors.badge}`}>{service.badge}</div>
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
              <CheckCircle size={12} className={colors.icon + ' flex-shrink-0'} />{f}
            </li>
          ))}
        </ul>
        <div className="flex items-end justify-between mt-auto">
          <div>
            <div className="text-[10px] text-slate-600 uppercase tracking-wider">Desde</div>
            <div className="text-xl font-black text-slate-100">RD$ {fmt(service.precio)}</div>
            <div className="text-[10px] text-slate-600">/mes o instalación</div>
          </div>
          <div className="relative group/btn">
            <button
              onClick={() => { if (blockedByDebt) return; onAdd(service) }}
              disabled={blockedByDebt}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold ${colors.bg} border ${colors.border} ${colors.icon} transition-all ${blockedByDebt ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80'}`}>
              <ShoppingCart size={14} />Añadir
            </button>
            {blockedByDebt && (
              <div className="absolute bottom-full right-0 mb-2 w-52 px-3 py-2 rounded-lg bg-slate-800 border border-red-600/40 text-xs text-red-300 shadow-xl z-10 hidden group-hover/btn:block pointer-events-none">
                Regulariza tu deuda para solicitar nuevos servicios.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Auth Modal (Login / Register / Forgot Password tabs) ─────────────────────

function AuthModal({ onClose, onLogin }) {
  const [tab,        setTab]      = useState('login')   // 'login' | 'register' | 'forgot'
  const [nombre,     setNombre]   = useState('')
  const [email,      setEmail]    = useState('')
  const [password,   setPassword] = useState('')
  const [showPwd,    setShowPwd]  = useState(false)
  const [busy,       setBusy]     = useState(false)
  const [forgotSent, setForgotSent] = useState(false)

  async function handleLogin(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await fetch(`${API}/api/portal/auth/login`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      })
      const data = await r.json()
      if (!r.ok) { toast.error(data.error ?? 'Error al iniciar sesión.'); return }
      onLogin(data)
    } finally {
      setBusy(false)
    }
  }

  async function handleRegister(e) {
    e.preventDefault()
    if (password.length < 6) { toast.error('Contraseña mínimo 6 caracteres.'); return }
    setBusy(true)
    try {
      const r = await fetch(`${API}/api/portal/auth/register`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: nombre.trim(), email: email.trim().toLowerCase(), password }),
      })
      const data = await r.json()
      if (!r.ok) { toast.error(data.error ?? 'Error al registrarse.'); return }
      onLogin(data)
    } finally {
      setBusy(false)
    }
  }

  async function handleForgot(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await fetch(`${API}/api/portal/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      })
      if (!r.ok) {
        const data = await r.json()
        toast.error(data.error ?? 'Error al enviar el correo.')
        return
      }
      setForgotSent(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-blue-600/5">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-blue-400" />
            <span className="text-sm font-bold text-slate-100">Acceso al Portal</span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={16} /></button>
        </div>

        {/* Tabs — only show login/register, not forgot */}
        {tab !== 'forgot' && (
          <div className="flex border-b border-slate-800">
            {[['login', 'Iniciar Sesión'], ['register', 'Registrarse']].map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${tab === id ? 'text-blue-400 border-b-2 border-blue-500 bg-blue-600/5' : 'text-slate-500 hover:text-slate-300'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Forgot Password panel */}
        {tab === 'forgot' && (
          <div className="p-6">
            <button onClick={() => { setTab('login'); setForgotSent(false) }}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors mb-5">
              <ChevronRight size={12} className="rotate-180" />Volver al inicio de sesión
            </button>
            <h3 className="text-sm font-bold text-slate-100 mb-1">Recuperar contraseña</h3>
            <p className="text-xs text-slate-500 mb-5">Te enviaremos un enlace para restablecer tu contraseña.</p>
            {forgotSent ? (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-600/10 border border-emerald-600/30">
                <CheckCircle size={18} className="text-emerald-400 flex-shrink-0" />
                <p className="text-sm font-semibold text-emerald-300">Revisa tu correo</p>
              </div>
            ) : (
              <form onSubmit={handleForgot} className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Email</label>
                  <div className="relative">
                    <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                    <input
                      type="email" value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="tu@email.com" required autoComplete="email"
                      className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                    />
                  </div>
                </div>
                <button type="submit" disabled={busy}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                  Enviar enlace
                </button>
              </form>
            )}
          </div>
        )}

        {/* Login / Register form */}
        {tab !== 'forgot' && (
          <form onSubmit={tab === 'login' ? handleLogin : handleRegister} className="p-6 space-y-4">
            {tab === 'register' && (
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Nombre completo</label>
                <div className="relative">
                  <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                  <input
                    type="text" value={nombre} onChange={e => setNombre(e.target.value)}
                    placeholder="Tu nombre" required minLength={2}
                    className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Email</label>
              <div className="relative">
                <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="tu@email.com" required autoComplete="email"
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Contraseña</label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" required minLength={6}
                  className="w-full pl-9 pr-10 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
                <button type="button" onClick={() => setShowPwd(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400 transition-colors">
                  {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={busy}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
              {tab === 'login' ? 'Entrar' : 'Crear cuenta'}
            </button>

            {tab === 'login' && (
              <div className="text-center">
                <button type="button" onClick={() => { setTab('forgot'); setForgotSent(false) }}
                  className="text-xs text-slate-500 hover:text-blue-400 transition-colors">
                  ¿Olvidaste tu contraseña?
                </button>
              </div>
            )}

            <p className="text-center text-xs text-slate-600">
              {tab === 'login' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}{' '}
              <button type="button" onClick={() => setTab(tab === 'login' ? 'register' : 'login')}
                className="text-blue-400 hover:text-blue-300 transition-colors font-medium">
                {tab === 'login' ? 'Regístrate' : 'Inicia sesión'}
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Customer Dashboard ───────────────────────────────────────────────────────

const MOCK_FACTURAS = [
  { id: '1', noFactura: 'B01-000234', fecha: '2026-04-01', monto: 2500, estado: 'Pagada',  servicio: 'Internet Pro 30 Mbps' },
  { id: '2', noFactura: 'B01-000275', fecha: '2026-05-01', monto: 2500, estado: 'Vencida', servicio: 'Internet Pro 30 Mbps' },
  { id: '3', noFactura: 'B01-000310', fecha: '2026-06-01', monto: 2500, estado: 'Emitida', servicio: 'Internet Pro 30 Mbps' },
]

function Dashboard({ cliente, onLogout, navigate }) {
  const [sosBusy, setSosBusy] = useState(false)

  const deudaTotal    = MOCK_FACTURAS.filter(f => f.estado === 'Vencida').reduce((s, f) => s + f.monto, 0)
  const countVencidas = MOCK_FACTURAS.filter(f => f.estado === 'Vencida').length
  const blockedByDebt = countVencidas >= 3

  async function handleSOS() {
    setSosBusy(true)
    try {
      const r = await fetch(`${API}/api/portal/sos`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!r.ok) {
        const data = await r.json()
        toast.error(data.error ?? 'Error al crear la orden de soporte.')
        return
      }
      toast.success('Orden de soporte creada. Un técnico te contactará pronto.')
    } catch {
      toast.error('No se pudo conectar con el servidor.')
    } finally {
      setSosBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-blue-400" />
            <span className="text-sm font-black text-slate-100">Mi Portal ACR</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 font-mono hidden sm:block">{cliente.noCliente}</span>
            <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-200 transition-colors">
              <LogOut size={13} />Salir
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-100">Hola, {cliente.razonSocial ?? cliente.nombre} 👋</h1>
            <p className="text-sm text-slate-500 mt-0.5">Aquí tienes el resumen de tu cuenta.</p>
          </div>
          <button
            onClick={handleSOS}
            disabled={sosBusy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-bold transition-colors disabled:opacity-50 border border-red-500/50 shadow-lg shadow-red-900/30">
            {sosBusy ? <Loader2 size={14} className="animate-spin" /> : <Siren size={14} />}
            SOS / Soporte Directo
          </button>
        </div>

        {/* Smart Balance Banner */}
        {deudaTotal > 0 && (
          <div className="flex items-center justify-between gap-3 p-4 rounded-xl bg-red-600/10 border border-red-600/30">
            <div className="flex items-center gap-3">
              <AlertTriangle size={18} className="text-red-400 flex-shrink-0" />
              <p className="text-sm font-semibold text-red-200">
                Deuda pendiente: <span className="font-black">RD$ {fmt(deudaTotal)}</span>
              </p>
            </div>
            <button
              onClick={() => toast.info('Redirigiendo al portal de pagos...')}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-colors">
              Pagar ahora →
            </button>
          </div>
        )}

        {/* Service Status */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={14} className="text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Estado del Servicio</h2>
          </div>
          <div className="flex items-center justify-between p-4 rounded-xl bg-emerald-600/5 border border-emerald-600/20">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-600/15 flex items-center justify-center">
                <Wifi size={18} className="text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-100">Internet Pro 30 Mbps</p>
                <p className="text-xs text-slate-500 mt-0.5">Cristo Rey, Santo Domingo</p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-600/15 border border-emerald-600/30 px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />Activo
              </span>
              <button
                onClick={() => navigate('/portal/tracking/ORD-2026-0042')}
                className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors underline underline-offset-2">
                Seguir técnico →
              </button>
            </div>
          </div>
        </div>

        {/* Invoices */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <FileText size={14} className="text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Mis Facturas</h2>
          </div>
          <div className="space-y-2">
            {MOCK_FACTURAS.map(f => (
              <div key={f.id} className={`flex items-center justify-between p-3.5 rounded-xl border transition-colors ${
                f.estado === 'Vencida' ? 'bg-red-600/5 border-red-600/20' :
                f.estado === 'Pagada'  ? 'bg-slate-800/40 border-slate-700/20' :
                'bg-blue-600/5 border-blue-600/20'
              }`}>
                <div>
                  <p className="text-sm font-medium text-slate-200 font-mono">{f.noFactura}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{f.servicio} · {new Date(f.fecha).toLocaleDateString('es-DO')}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                    f.estado === 'Vencida' ? 'bg-red-600/15 text-red-300 border-red-600/30' :
                    f.estado === 'Pagada'  ? 'bg-emerald-600/15 text-emerald-300 border-emerald-600/30' :
                    'bg-blue-600/15 text-blue-300 border-blue-600/30'
                  }`}>{f.estado}</span>
                  <span className="text-sm font-bold text-slate-100">RD$ {fmt(f.monto)}</span>
                  {f.estado === 'Vencida' && (
                    <button
                      onClick={() => toast.info('Redirigiéndote al portal de pagos… (demo)')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-colors">
                      <CreditCard size={11} />Pagar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Support */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle size={14} className="text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Soporte</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <a href="tel:+18095550000" className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/50 hover:bg-slate-800 transition-colors border border-slate-700/30">
              <Phone size={15} className="text-blue-400 flex-shrink-0" />
              <div><p className="text-xs font-medium text-slate-200">Llamar</p><p className="text-[10px] text-slate-500">809-555-0000</p></div>
            </a>
            <a href="mailto:soporte@acrnetworks.do" className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/50 hover:bg-slate-800 transition-colors border border-slate-700/30">
              <Mail size={15} className="text-blue-400 flex-shrink-0" />
              <div><p className="text-xs font-medium text-slate-200">Email</p><p className="text-[10px] text-slate-500">soporte@acrnetworks.do</p></div>
            </a>
            <button
              onClick={() => { if (window.Tawk_API) window.Tawk_API.toggle(); else toast.info('Chat en línea. Abre el widget de soporte.') }}
              className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/50 hover:bg-slate-800 transition-colors border border-slate-700/30 text-left">
              <MessageCircle size={15} className="text-blue-400 flex-shrink-0" />
              <div><p className="text-xs font-medium text-slate-200">Chat</p><p className="text-[10px] text-slate-500">En línea ahora</p></div>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Onboarding Wizard ────────────────────────────────────────────────────────

function OnboardingWizard({ onComplete, onCancel }) {
  const [step,      setStep]      = useState(1)
  const [telefono,  setTelefono]  = useState('')
  const [direccion, setDireccion] = useState('')
  const [sector,    setSector]    = useState('')
  const [provincia, setProvincia] = useState('')

  function handleNext(e) {
    e.preventDefault()
    if (step < 3) setStep(s => s + 1)
  }

  function handleSubmit(e) {
    e.preventDefault()
    toast.success('Documentos enviados. Procesando cotización.')
    onComplete()
  }

  const stepLabels = ['Datos de Contacto', 'Ubicación', 'Verificación']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md bg-slate-950 border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-blue-600/5">
          <div className="flex items-center gap-2">
            <User size={15} className="text-blue-400" />
            <span className="text-sm font-bold text-slate-100">Completa tu perfil</span>
          </div>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={16} /></button>
        </div>

        {/* Step indicators */}
        <div className="flex items-center gap-0 px-5 pt-5 pb-1">
          {stepLabels.map((label, idx) => {
            const n = idx + 1
            const active   = step === n
            const complete = step > n
            return (
              <div key={n} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border transition-colors ${
                    complete ? 'bg-blue-600 border-blue-500 text-white' :
                    active   ? 'bg-blue-600/20 border-blue-500 text-blue-300' :
                               'bg-slate-800 border-slate-700 text-slate-600'
                  }`}>
                    {complete ? <CheckCircle size={14} /> : n}
                  </div>
                  <span className={`text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap ${active ? 'text-blue-400' : 'text-slate-600'}`}>{label}</span>
                </div>
                {idx < stepLabels.length - 1 && (
                  <div className={`flex-1 h-px mx-2 mt-[-14px] transition-colors ${complete ? 'bg-blue-600' : 'bg-slate-800'}`} />
                )}
              </div>
            )
          })}
        </div>

        {/* Step 1: Datos de Contacto */}
        {step === 1 && (
          <form onSubmit={handleNext} className="p-6 space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Teléfono principal</label>
              <div className="relative">
                <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  type="tel" value={telefono} onChange={e => setTelefono(e.target.value)}
                  placeholder="809-000-0000" required
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Dirección</label>
              <div className="relative">
                <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  type="text" value={direccion} onChange={e => setDireccion(e.target.value)}
                  placeholder="Calle, número, residencial..." required minLength={5}
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>
            <div className="flex justify-end pt-1">
              <button type="submit"
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
                Siguiente <ChevronRight size={14} />
              </button>
            </div>
          </form>
        )}

        {/* Step 2: Ubicación */}
        {step === 2 && (
          <form onSubmit={handleNext} className="p-6 space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Sector</label>
              <div className="relative">
                <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  type="text" value={sector} onChange={e => setSector(e.target.value)}
                  placeholder="Ej: Cristo Rey, Naco, Piantini..." required
                  className="w-full pl-9 pr-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Provincia</label>
              <select
                value={provincia} onChange={e => setProvincia(e.target.value)} required
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-blue-500 transition-colors appearance-none">
                <option value="">Selecciona provincia...</option>
                {RD_PROVINCIAS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="flex justify-between pt-1">
              <button type="button" onClick={() => setStep(1)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 text-sm font-medium transition-colors">
                <ChevronRight size={14} className="rotate-180" />Anterior
              </button>
              <button type="submit"
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
                Siguiente <ChevronRight size={14} />
              </button>
            </div>
          </form>
        )}

        {/* Step 3: Verificación */}
        {step === 3 && (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Foto de cédula (frente)</label>
              <div className="flex flex-col items-center justify-center gap-3 p-6 rounded-xl bg-slate-800/60 border-2 border-dashed border-slate-700 hover:border-blue-600/50 transition-colors cursor-pointer">
                <div className="w-10 h-10 rounded-xl bg-blue-600/10 border border-blue-600/20 flex items-center justify-center">
                  <User size={18} className="text-blue-400" />
                </div>
                <div className="text-center">
                  <p className="text-xs font-semibold text-slate-300 mb-0.5">Sube tu cédula de identidad</p>
                  <p className="text-[10px] text-slate-600">JPG, PNG — máx. 5MB</p>
                </div>
                <input
                  type="file" accept="image/*"
                  className="block w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-600/20 file:text-blue-300 hover:file:bg-blue-600/30 transition-all cursor-pointer"
                />
              </div>
            </div>
            <div className="flex justify-between pt-1">
              <button type="button" onClick={() => setStep(2)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 text-sm font-medium transition-colors">
                <ChevronRight size={14} className="rotate-180" />Anterior
              </button>
              <button type="submit"
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
                <CheckCircle size={14} />Finalizar
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Quoter ───────────────────────────────────────────────────────────────────

function Quoter({ onSolicitar, cliente, blockedByDebt }) {
  const [plan,           setPlan]           = useState(QUOTER_PLANS[1].id)
  const [camaras,        setCamaras]        = useState(0)
  const [puntos,         setPuntos]         = useState(0)
  const [tipo,           setTipo]           = useState('hogar')
  const [wizardOpen,     setWizardOpen]     = useState(false)
  const [pendingDatos,   setPendingDatos]   = useState(null)

  const selectedPlan  = QUOTER_PLANS.find(p => p.id === plan)
  const precioCamaras = camaras * 3500
  const precioPuntos  = puntos  * 1200
  const total         = (selectedPlan?.base ?? 0) + precioCamaras + precioPuntos

  function handleSolicitar() {
    const datos = { plan: selectedPlan?.label, camaras, puntos, total }
    const needsOnboarding = cliente && (
      cliente.telefonoPrincipal === '000-000-0000' ||
      cliente.direccion === 'Por completar'
    )
    if (needsOnboarding) {
      setPendingDatos(datos)
      setWizardOpen(true)
    } else {
      onSolicitar(datos)
    }
  }

  function handleWizardComplete() {
    setWizardOpen(false)
    if (pendingDatos) {
      onSolicitar(pendingDatos)
      setPendingDatos(null)
    }
  }

  return (
    <>
      {wizardOpen && (
        <OnboardingWizard
          onComplete={handleWizardComplete}
          onCancel={() => { setWizardOpen(false); setPendingDatos(null) }}
        />
      )}

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-2 mb-1">
          <Star size={16} className="text-amber-400" />
          <h3 className="text-base font-bold text-slate-100">Arma tu Plan</h3>
          <span className="text-[10px] font-semibold text-amber-400 bg-amber-600/15 border border-amber-600/30 px-2 py-0.5 rounded-full ml-1">Cotizador Inbound</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {[{ id: 'hogar', label: 'Hogar / Residencial', icon: Home }, { id: 'empresa', label: 'Empresa / Negocio', icon: Building2 }].map(t => (
            <button key={t.id} onClick={() => setTipo(t.id)}
              className={`flex items-center gap-2 p-3 rounded-xl border text-sm font-medium transition-all ${tipo === t.id ? 'bg-blue-600/15 border-blue-600/40 text-blue-300' : 'bg-slate-800/40 border-slate-700/30 text-slate-400 hover:bg-slate-800/60'}`}>
              <t.icon size={14} />{t.label}
            </button>
          ))}
        </div>

        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Plan de Internet</label>
          <div className="grid grid-cols-2 gap-2">
            {QUOTER_PLANS.map(p => (
              <button key={p.id} onClick={() => setPlan(p.id)}
                className={`relative flex flex-col items-start p-3 rounded-xl border text-left transition-all ${plan === p.id ? 'bg-blue-600/15 border-blue-600/40' : 'bg-slate-800/40 border-slate-700/30 hover:bg-slate-800/60'}`}>
                {p.popular && <span className="absolute top-1.5 right-1.5 text-[8px] font-bold bg-blue-600 text-white px-1.5 py-0.5 rounded-full">HOT</span>}
                <span className="text-base mb-1">{p.icon}</span>
                <span className={`text-xs font-semibold ${plan === p.id ? 'text-blue-300' : 'text-slate-300'}`}>{p.label}</span>
                <span className="text-[10px] text-slate-500 mt-0.5">RD$ {fmt(p.base)}/mes</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
            Cámaras CCTV: <span className="text-slate-300">{camaras === 0 ? 'Ninguna' : `${camaras} cámara${camaras !== 1 ? 's' : ''}`}</span>
          </label>
          <input type="range" min={0} max={16} step={1} value={camaras} onChange={e => setCamaras(+e.target.value)} className="w-full accent-emerald-500 h-1.5" />
          <div className="flex justify-between text-[9px] text-slate-700 mt-1 font-mono"><span>0</span><span>4</span><span>8</span><span>12</span><span>16</span></div>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
            Puntos de Red LAN: <span className="text-slate-300">{puntos === 0 ? 'Ninguno' : `${puntos} punto${puntos !== 1 ? 's' : ''}`}</span>
          </label>
          <input type="range" min={0} max={24} step={1} value={puntos} onChange={e => setPuntos(+e.target.value)} className="w-full accent-amber-500 h-1.5" />
        </div>

        <div className="bg-slate-800/60 rounded-xl p-4 space-y-2 border border-slate-700/30">
          <div className="flex justify-between text-xs text-slate-400">
            <span>Internet {selectedPlan?.label}</span><span>RD$ {fmt(selectedPlan?.base)}/mes</span>
          </div>
          {camaras > 0 && (
            <div className="flex justify-between text-xs text-slate-400">
              <span>{camaras} cámara{camaras !== 1 ? 's' : ''} CCTV</span><span>RD$ {fmt(precioCamaras)}</span>
            </div>
          )}
          {puntos > 0 && (
            <div className="flex justify-between text-xs text-slate-400">
              <span>{puntos} punto{puntos !== 1 ? 's' : ''} de red</span><span>RD$ {fmt(precioPuntos)}</span>
            </div>
          )}
          <div className="border-t border-slate-700 pt-2 flex justify-between items-center">
            <span className="text-xs font-bold text-slate-300">Estimado mensual/instalación</span>
            <span className="text-xl font-black text-slate-100">RD$ {fmt(total)}</span>
          </div>
        </div>

        <div className="relative group/submit">
          <button
            onClick={handleSolicitar}
            disabled={blockedByDebt}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 text-white font-bold text-sm transition-colors ${blockedByDebt ? 'opacity-40 cursor-not-allowed' : 'hover:bg-blue-500'}`}>
            <ChevronRight size={16} />Solicitar Cotización Formal
          </button>
          {blockedByDebt && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 px-3 py-2 rounded-lg bg-slate-800 border border-red-600/40 text-xs text-red-300 text-center shadow-xl z-10 hidden group-hover/submit:block pointer-events-none">
              Regulariza tu deuda para solicitar nuevos servicios.
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Main portal ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = { mostrarMapa: true, mostrarCotizador: true, mostrarServicios: true }

export default function CustomerPortal() {
  const navigate = useNavigate()
  const [catActiva,       setCatActiva]       = useState('Todos')
  const [loginOpen,       setLoginOpen]       = useState(false)
  const [contactVisible,  setContactVisible]  = useState(false)
  const [cliente,         setCliente]         = useState(null)
  const [settings,        setSettings]        = useState(DEFAULT_SETTINGS)
  const [sessionLoading,  setSessionLoading]  = useState(true)

  // Derive public-portal blockedByDebt from mock data (mirrors Dashboard logic)
  const deudaTotal    = MOCK_FACTURAS.filter(f => f.estado === 'Vencida').reduce((s, f) => s + f.monto, 0)
  const countVencidas = MOCK_FACTURAS.filter(f => f.estado === 'Vencida').length
  const blockedByDebt = countVencidas >= 3

  // Restore session + fetch settings on mount
  useEffect(() => {
    let cancelled = false
    async function init() {
      const [meRes, settingsRes] = await Promise.allSettled([
        fetch(`${API}/api/portal/auth/me`, { credentials: 'include' }),
        fetch(`${API}/api/portal/settings`),
      ])
      if (cancelled) return
      if (meRes.status === 'fulfilled' && meRes.value.ok) {
        const data = await meRes.value.json()
        setCliente(data)
      }
      if (settingsRes.status === 'fulfilled' && settingsRes.value.ok) {
        const data = await settingsRes.value.json()
        setSettings(prev => ({ ...prev, ...data }))
      }
      setSessionLoading(false)
    }
    init()
    return () => { cancelled = true }
  }, [])

  async function handleLogout() {
    await fetch(`${API}/api/portal/auth/logout`, { method: 'POST', credentials: 'include' })
    setCliente(null)
    toast.success('Sesión cerrada.')
  }

  function handleLogin(data) {
    setCliente(data)
    setLoginOpen(false)
    toast.success(`Bienvenido, ${data.razonSocial ?? data.nombre}!`)
  }

  function handleSolicitar(datos) {
    toast.success(`¡Cotización enviada! Un asesor te contactará pronto. Estimado: RD$ ${fmt(datos.total)}`, { duration: 6000 })
  }

  function handleAddService(s) {
    toast.success(`"${s.nombre}" añadido. Un asesor te contactará pronto.`, { duration: 4000 })
  }

  const serviciosFiltrados = catActiva === 'Todos' ? SERVICES : SERVICES.filter(s => s.category === catActiva)

  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-blue-500" />
      </div>
    )
  }

  if (cliente) {
    return <Dashboard cliente={cliente} onLogout={handleLogout} navigate={navigate} />
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <TawktoWidget />

      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-600/30 flex items-center justify-center">
              <Zap size={16} className="text-blue-400" />
            </div>
            <div>
              <div className="text-sm font-black text-slate-100 leading-none">ACR Networks</div>
              <div className="text-[9px] text-slate-600 font-mono leading-none mt-0.5">&amp; Solutions</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setContactVisible(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors border border-slate-700">
              <Phone size={13} />Contacto
            </button>
            <button onClick={() => setLoginOpen(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors">
              <LogIn size={13} />Mi Portal
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
                <div><div className="text-sm font-medium text-slate-200">Teléfono</div><div className="text-xs text-slate-500">809-555-0000</div></div>
              </a>
              <a href="mailto:ventas@acrnetworks.do" className="flex items-center gap-3 p-3 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors">
                <Mail size={16} className="text-blue-400" />
                <div><div className="text-sm font-medium text-slate-200">Email</div><div className="text-xs text-slate-500">ventas@acrnetworks.do</div></div>
              </a>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800">
                <MapPin size={16} className="text-blue-400" />
                <div><div className="text-sm font-medium text-slate-200">Oficina</div><div className="text-xs text-slate-500">Santo Domingo, Rep. Dom.</div></div>
              </div>
            </div>
            <button onClick={() => setContactVisible(false)} className="w-full py-2 rounded-lg text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">Cerrar</button>
          </div>
        </div>
      )}

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 py-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-600/10 border border-blue-600/20 text-blue-400 text-xs font-semibold mb-6">
          <Zap size={12} /> ISP · CCTV · Infraestructura de Redes
        </div>
        <h1 className="text-4xl sm:text-5xl font-black text-slate-100 leading-tight mb-4">
          Conectividad y Seguridad<br /><span className="text-blue-400">para tu negocio</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-xl mx-auto mb-8">
          WISP, videovigilancia e infraestructura de redes para empresas y hogares en Santo Domingo.
        </p>
        <div className="flex items-center justify-center gap-3">
          {settings.mostrarCotizador && (
            <button onClick={() => document.getElementById('cotizador')?.scrollIntoView({ behavior: 'smooth' })}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors">
              Armar mi Plan <ChevronRight size={16} />
            </button>
          )}
          <button onClick={() => setLoginOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-slate-700 text-slate-300 hover:text-slate-100 hover:border-slate-600 font-semibold text-sm transition-colors">
            <LogIn size={14} />Acceder
          </button>
        </div>
      </section>

      {/* Coverage Map */}
      {settings.mostrarMapa && (
        <section className="max-w-6xl mx-auto px-4 pb-12">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xl font-bold text-slate-100">Cobertura de Red</h2>
            <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-600/15 border border-emerald-600/30 px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />SLA: 99.8% Estabilidad
            </span>
          </div>
          <CoverageMap />
        </section>
      )}

      {/* Quoter */}
      {settings.mostrarCotizador && (
        <section id="cotizador" className="max-w-6xl mx-auto px-4 pb-16">
          <div className="max-w-2xl mx-auto">
            <Quoter onSolicitar={handleSolicitar} cliente={cliente} blockedByDebt={blockedByDebt} />
          </div>
        </section>
      )}

      {/* Services */}
      {settings.mostrarServicios && (
        <section id="servicios" className="max-w-6xl mx-auto px-4 pb-20">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-slate-100">Nuestros Servicios</h2>
          </div>
          <div className="flex gap-2 flex-wrap mb-6">
            {CATEGORIES.map(cat => (
              <button key={cat} onClick={() => setCatActiva(cat)}
                className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${catActiva === cat ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200 border border-slate-700'}`}>
                {cat}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {serviciosFiltrados.map(s => <ServiceCard key={s.id} service={s} onAdd={handleAddService} blockedByDebt={blockedByDebt} />)}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800 py-8">
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-blue-400" />
            <span className="text-sm text-slate-500 font-mono">ACR Networks &amp; Solutions · Santo Domingo, DO</span>
          </div>
          <span className="text-xs text-slate-700 font-mono">v2.1.0 · {new Date().getFullYear()}</span>
        </div>
      </footer>

      {loginOpen && <AuthModal onClose={() => setLoginOpen(false)} onLogin={handleLogin} />}
    </div>
  )
}
