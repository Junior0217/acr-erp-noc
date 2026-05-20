// build: 2026-05-13
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { useAuth, AuthProvider } from '@shared/contexts/AuthContext'
import { CartProvider } from '@shared/contexts/CartContext'
import { EmpresaProvider } from '@shared/contexts/EmpresaContext'
import PWAUpdatePrompt from '@shared/components/PWAUpdatePrompt'
import ErrorBoundary from '@shared/components/ErrorBoundary'
import { apiFetch } from '@shared/utils/api'

// ─── EAGER (route shell + Login) ──────────────────────────────────────────────
// AdminLayout + Login se cargan al inicio porque son el camino de entrada.
import AdminLayout from '@shared/layouts/AdminLayout'
import Login from '@features/auth/Login'

// ─── LAZY (split por ruta para reducir bundle inicial) ────────────────────────
const Dashboard       = lazy(() => import('@features/dashboard/Dashboard'))
const Ventas          = lazy(() => import('@features/sales/Ventas'))
const Inventario      = lazy(() => import('@features/inventory/Inventario'))
const Contabilidad    = lazy(() => import('@features/accounting/Contabilidad'))
const RRHH            = lazy(() => import('@features/hr/RRHH'))
const CRM             = lazy(() => import('@features/crm/CRM'))
const MapaNOC         = lazy(() => import('@features/map/MapaNOC'))
const Reportes        = lazy(() => import('@features/reports/Reportes'))
const ReportesDGII    = lazy(() => import('@features/dgii/ReportesDGII'))
const ComprasDGII     = lazy(() => import('@features/dgii/Compras'))
const Configuracion   = lazy(() => import('@features/settings/Configuracion'))
const Servicios       = lazy(() => import('@features/services/Servicios'))
const OrdenesServicio = lazy(() => import('@features/services/OrdenesServicio'))
const Taller          = lazy(() => import('@features/workshop/Taller'))
const CustomerPortal  = lazy(() => import('@features/portal/CustomerPortal'))
const PortalTracking  = lazy(() => import('@features/portal/PortalTracking'))
const TrackTicket     = lazy(() => import('@features/portal/TrackTicket'))
const Tienda          = lazy(() => import('@features/store/Tienda'))
const CotizacionDGII  = lazy(() => import('@features/settings/CotizacionDGII'))
const MiEmpresa       = lazy(() => import('@features/company/MiEmpresa'))
const VerifyDocument  = lazy(() => import('@features/settings/VerifyDocument'))

function PageLoader() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs font-mono tracking-wider">Cargando módulo...</p>
      </div>
    </div>
  )
}

function FullPageLoader() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function AppRoutes() {
  const { user } = useAuth()

  if (user === undefined) return <FullPageLoader />

  if (user === null) {
    return (
      <Suspense fallback={<FullPageLoader />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/portal" element={<CustomerPortal />} />
          <Route path="/portal/tracking/:ordenId" element={<PortalTracking />} />
          <Route path="/track" element={<TrackTicket />} />
          <Route path="/track/:pin" element={<TrackTicket />} />
          <Route path="/tienda" element={<Tienda />} />
          <Route path="/cotizacion-dgii" element={<CotizacionDGII />} />
          <Route path="/verify/:hash" element={<Suspense fallback={<PageLoader />}><VerifyDocument /></Suspense>} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <Suspense fallback={<FullPageLoader />}>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/portal" element={<CustomerPortal />} />
        <Route path="/portal/tracking/:ordenId" element={<PortalTracking />} />
        <Route path="/track" element={<TrackTicket />} />
        <Route path="/track/:pin" element={<TrackTicket />} />
        <Route path="/cotizacion-dgii" element={<CotizacionDGII />} />
        {/* /verify/:hash es PÚBLICO — debe abrir igual estando logueado.
            Antes el fallback "*" lo capturaba y redirigía a "/" cuando el
            usuario hacía click en el QR de un PDF con sesión activa. */}
        <Route path="/verify/:hash" element={<Suspense fallback={<PageLoader />}><VerifyDocument /></Suspense>} />
        <Route path="/" element={<AdminLayout />}>
          <Route index            element={<Suspense fallback={<PageLoader />}><Dashboard /></Suspense>} />
          <Route path="ventas"    element={<Suspense fallback={<PageLoader />}><Ventas /></Suspense>} />
          <Route path="inventario" element={<Suspense fallback={<PageLoader />}><Inventario /></Suspense>} />
          <Route path="contabilidad" element={<Suspense fallback={<PageLoader />}><Contabilidad /></Suspense>} />
          <Route path="rrhh"      element={<Suspense fallback={<PageLoader />}><RRHH /></Suspense>} />
          <Route path="servicios" element={<Suspense fallback={<PageLoader />}><Servicios /></Suspense>} />
          <Route path="servicios/ordenes" element={<Suspense fallback={<PageLoader />}><OrdenesServicio /></Suspense>} />
          <Route path="taller"    element={<Suspense fallback={<PageLoader />}><Taller /></Suspense>} />
          <Route path="crm"       element={<Suspense fallback={<PageLoader />}><CRM /></Suspense>} />
          <Route path="mapa"      element={<Suspense fallback={<PageLoader />}><MapaNOC /></Suspense>} />
          <Route path="reportes"  element={<Suspense fallback={<PageLoader />}><Reportes /></Suspense>} />
          <Route path="dgii"      element={<Suspense fallback={<PageLoader />}><ReportesDGII /></Suspense>} />
          <Route path="dgii/compras" element={<Suspense fallback={<PageLoader />}><ComprasDGII /></Suspense>} />
          <Route path="empresa"   element={<Suspense fallback={<PageLoader />}><MiEmpresa /></Suspense>} />
          <Route path="configuracion" element={<Suspense fallback={<PageLoader />}><Configuracion /></Suspense>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

// Listener global: cuando apiFetch detecte version drift, mostrar toast antes
// del reload forzado (la recarga la dispara el propio utils/api.js).
function VersionDriftWatcher() {
  useEffect(() => {
    const onDrift = () => {
      toast.warning('Nueva versión detectada', {
        description: 'Recargando para aplicar los últimos cambios…',
        duration: 1500,
      })
    }
    window.addEventListener('app:version-mismatch', onDrift)
    // Heartbeat: pulsa /api/health cada 60s para detectar drift cuando el user
    // está idle (sin clicks que disparen otras requests).
    const t = setInterval(() => { apiFetch('/api/health').catch(() => {}) }, 60_000)
    return () => { window.removeEventListener('app:version-mismatch', onDrift); clearInterval(t) }
  }, [])
  return null
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <EmpresaProvider>
          <CartProvider>
            <BrowserRouter>
              <Toaster position="top-right" richColors closeButton duration={4000} />
              <VersionDriftWatcher />
              <AppRoutes />
              <PWAUpdatePrompt />
            </BrowserRouter>
          </CartProvider>
        </EmpresaProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}
