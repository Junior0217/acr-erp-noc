import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { useAuth, AuthProvider } from './contexts/AuthContext'
import { CartProvider } from './contexts/CartContext'
import ErrorBoundary from './components/ErrorBoundary'
import AdminLayout from './layouts/AdminLayout'
import Dashboard from './pages/Dashboard'
import Ventas from './pages/Ventas'
import Compras from './pages/Compras'
import Inventario from './pages/Inventario'
import Contabilidad from './pages/Contabilidad'
import RRHH from './pages/RRHH'
import CRM from './pages/CRM'
import MapaNOC from './pages/MapaNOC'
import Reportes from './pages/Reportes'
import Configuracion from './pages/Configuracion'
import Servicios from './pages/Servicios'
import Login from './pages/Login'

function AppRoutes() {
  const { user } = useAuth()

  if (user === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (user === null) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/" element={<AdminLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="ventas" element={<Ventas />} />
        <Route path="compras" element={<Compras />} />
        <Route path="inventario" element={<Inventario />} />
        <Route path="contabilidad" element={<Contabilidad />} />
        <Route path="rrhh" element={<RRHH />} />
        <Route path="servicios" element={<Servicios />} />
        <Route path="crm" element={<CRM />} />
        <Route path="mapa" element={<MapaNOC />} />
        <Route path="reportes" element={<Reportes />} />
        <Route path="configuracion" element={<Configuracion />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <CartProvider>
          <BrowserRouter>
            <Toaster position="top-right" richColors closeButton duration={4000} />
            <AppRoutes />
          </BrowserRouter>
        </CartProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}
