import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, ShoppingCart, PackageSearch, Boxes, BookOpen,
  Users, Handshake, Globe, BarChart2, Settings, Menu, X, ChevronRight,
  Zap, Wrench, AlertTriangle, ClipboardList, LogOut,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useCart } from '../contexts/CartContext'
import { apiFetch } from '../utils/api'
import { useOfflineStatus } from '../hooks/useOfflineStatus'
import CarritoSlideOver from '../components/CarritoSlideOver'

function useNocAlerts() {
  const [alerts, setAlerts] = useState({ stockCritico: 0, ordenesPendientes: 0 })

  useEffect(() => {
    async function fetchAlerts() {
      try {
        const r = await apiFetch('/api/dashboard')
        if (!r.ok) return
        const j = await r.json()
        setAlerts({ stockCritico: j.stockCritico?.length ?? 0, ordenesPendientes: j.ordenesPendientes ?? 0 })
      } catch {}
    }
    fetchAlerts()
    const id = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(id)
  }, [])

  return alerts
}

const navItems = [
  { to: '/',             label: 'Dashboard',     icon: LayoutDashboard, sub: null,                        permiso: 'dashboard:ver'  },
  { to: '/ventas',       label: 'Ventas',         icon: ShoppingCart,    sub: 'Cotizaciones · Facturas ISP', permiso: null             },
  { to: '/compras',      label: 'Compras',        icon: PackageSearch,   sub: 'Órdenes · Proveedores',       permiso: null             },
  { to: '/inventario',   label: 'Inventario',     icon: Boxes,           sub: 'Fibra · Equipos · CCTV',     permiso: 'inventario:ver' },
  { to: '/contabilidad', label: 'Contabilidad',   icon: BookOpen,        sub: 'Cuentas · Balances',         permiso: null             },
  { to: '/rrhh',         label: 'RRHH',           icon: Users,           sub: 'Técnicos · Nómina',          permiso: 'rrhh:ver'       },
  { to: '/servicios',    label: 'Servicios',      icon: Wrench,          sub: 'Planes · Instalaciones',     permiso: 'servicios:ver'  },
  { to: '/crm',          label: 'CRM',            icon: Handshake,       sub: 'Clientes · Suplidores',      permiso: 'crm:ver'        },
  { to: '/mapa',         label: 'Mapa NOC',       icon: Globe,           sub: 'Cobertura · Geo',            permiso: 'mapa:ver'       },
  { to: '/reportes',     label: 'Reportes',       icon: BarChart2,       sub: 'KPIs · Exportar',            permiso: 'reportes:ver'   },
  { to: '/configuracion',label: 'Configuración',  icon: Settings,        sub: 'Perfil · Seguridad',         permiso: null             },
]

function SidebarContent({ onClose }) {
  const { user, tienePermiso } = useAuth()
  const visibleItems = navItems.filter(({ permiso }) => !permiso || tienePermiso(permiso))

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 flex items-center justify-between px-4 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-blue-400" />
          <span className="text-xs font-mono text-blue-400 tracking-widest uppercase">ACR&nbsp;NOC</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors lg:hidden">
            <X size={18} />
          </button>
        )}
      </div>

      <nav className="flex-1 py-3 space-y-0.5 px-2 overflow-y-auto">
        {visibleItems.map(({ to, label, icon: Icon, sub }) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all group ${
                isActive
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100 border border-transparent'
              }`
            }
          >
            <Icon size={16} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="leading-tight">{label}</div>
              {sub && <div className="text-[10px] text-slate-600 group-hover:text-slate-500 truncate leading-tight mt-0.5">{sub}</div>}
            </div>
            <ChevronRight size={13} className="opacity-0 group-hover:opacity-40 transition-opacity flex-shrink-0" />
          </NavLink>
        ))}
      </nav>

      <div className="px-4 py-3 border-t border-slate-800 flex-shrink-0">
        <p className="text-xs font-medium text-slate-400 truncate">{user?.nombre}</p>
        <p className="text-[10px] text-slate-700 font-mono mt-0.5">ACR Networks · v1.0.0</p>
      </div>
    </div>
  )
}

export default function AdminLayout() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const alerts    = useNocAlerts()
  const offline   = useOfflineStatus()
  const { user, logout } = useAuth()
  const { totalItems, setOpen: openCart } = useCart()
  const navigate  = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-screen bg-slate-900 text-slate-100 overflow-hidden">
      <aside className="hidden lg:flex w-64 flex-shrink-0 bg-slate-950 border-r border-slate-800 flex-col">
        <SidebarContent />
      </aside>

      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsMobileMenuOpen(false)} />
          <aside className="relative z-50 w-72 h-full bg-slate-950 border-r border-slate-800 flex flex-col shadow-2xl">
            <SidebarContent onClose={() => setIsMobileMenuOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {offline && (
          <div className="flex items-center justify-center gap-2 bg-amber-600/90 text-white text-[11px] font-mono py-1.5 px-4 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse flex-shrink-0" />
            Sin conexión — modo solo lectura. Las escrituras requieren conexión activa.
          </div>
        )}
        <header className="h-14 flex-shrink-0 bg-slate-950 border-b border-slate-800 flex items-center justify-between px-4 gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsMobileMenuOpen(true)} className="lg:hidden text-slate-400 hover:text-slate-100 transition-colors">
              <Menu size={20} />
            </button>
            <img src="/logo-acr.png" alt="ACR Networks" className="h-7 hidden sm:block" onError={e => { e.target.style.display = 'none' }} />
            <div className="flex items-center gap-1.5 sm:hidden">
              <Zap size={14} className="text-blue-400" />
              <span className="text-xs font-mono text-blue-400 tracking-widest uppercase">ACR NOC</span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => openCart(true)}
              title="Carrito POS"
              className="relative w-9 h-9 rounded-full bg-slate-800 hover:bg-blue-900/30 border border-slate-700 hover:border-blue-700/40 flex items-center justify-center flex-shrink-0 transition-colors"
            >
              <ShoppingCart size={15} className="text-slate-400" />
              {totalItems > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] font-bold flex items-center justify-center">
                  {totalItems > 9 ? '9+' : totalItems}
                </span>
              )}
            </button>
            {alerts.ordenesPendientes > 0 && (
              <div title={`${alerts.ordenesPendientes} órdenes pendientes`}
                className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-600/15 border border-amber-600/30 text-amber-400 text-xs font-semibold cursor-default">
                <ClipboardList size={12} />
                <span>{alerts.ordenesPendientes}</span>
              </div>
            )}
            {alerts.stockCritico > 0 && (
              <div title={`${alerts.stockCritico} productos con stock crítico`}
                className="flex items-center gap-1 px-2 py-1 rounded-full bg-red-600/15 border border-red-600/30 text-red-400 text-xs font-semibold cursor-default">
                <AlertTriangle size={12} />
                <span>{alerts.stockCritico}</span>
              </div>
            )}
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium text-slate-100 leading-tight">{user?.nombre}</p>
              <p className="text-xs text-slate-500 leading-tight">ACR Networks</p>
            </div>
            <button
              onClick={handleLogout}
              title="Cerrar sesión"
              className="w-9 h-9 rounded-full bg-slate-800 hover:bg-red-900/30 border border-slate-700 hover:border-red-700/40 flex items-center justify-center flex-shrink-0 transition-colors"
            >
              <LogOut size={15} className="text-slate-400 hover:text-red-400" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-slate-900 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>

      <CarritoSlideOver />
    </div>
  )
}
