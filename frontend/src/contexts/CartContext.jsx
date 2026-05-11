import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../utils/api'
import { useAuth } from './AuthContext'
import { toast } from 'sonner'

const CartCtx = createContext(null)

export function CartProvider({ children }) {
  const { user } = useAuth()
  const [carrito, setCarrito] = useState(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const fetchCarrito = useCallback(async () => {
    if (!user) { setCarrito(null); return }
    try {
      const r = await apiFetch('/api/carrito')
      if (!r.ok) return
      setCarrito(await r.json())
    } catch {}
  }, [user])

  useEffect(() => { fetchCarrito() }, [fetchCarrito])

  const totalItems = carrito?.lineas?.reduce((s, l) => s + l.cantidad, 0) ?? 0

  async function addItem(productoId, cantidad = 1) {
    setLoading(true)
    try {
      const r = await apiFetch('/api/carrito/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productoId, cantidad }),
      })
      if (!r.ok) { const j = await r.json(); toast.error(j.error ?? 'Error al añadir.'); return }
      setCarrito(await r.json())
      setOpen(true)
      toast.success('Añadido al carrito.')
    } finally { setLoading(false) }
  }

  async function updateItem(lineaId, changes) {
    try {
      const r = await apiFetch(`/api/carrito/item/${lineaId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      if (!r.ok) { const j = await r.json(); toast.error(j.error ?? 'Error.'); return }
      setCarrito(await r.json())
    } catch {}
  }

  async function removeItem(lineaId) {
    try {
      const r = await apiFetch(`/api/carrito/item/${lineaId}`, { method: 'DELETE' })
      if (!r.ok) return
      setCarrito(await r.json())
    } catch {}
  }

  async function clearCart() {
    try {
      const r = await apiFetch('/api/carrito', { method: 'DELETE' })
      if (r.status === 204) await fetchCarrito()
    } catch {}
  }

  async function updateCartMeta(changes) {
    try {
      const r = await apiFetch('/api/carrito', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      if (!r.ok) return
      setCarrito(await r.json())
    } catch {}
  }

  async function checkout(esCotizacion = false, tipoNcfOverride, nombreTemporal) {
    setLoading(true)
    try {
      const body = { esCotizacion }
      if (tipoNcfOverride) body.tipoNcfOverride = tipoNcfOverride
      if (nombreTemporal)  body.nombreTemporal  = nombreTemporal
      const r = await apiFetch('/api/carrito/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error en checkout.'); return null }
      await fetchCarrito()
      toast.success(esCotizacion ? 'Cotización guardada.' : `Factura ${j.noFactura} emitida.`)
      return j
    } finally { setLoading(false) }
  }

  return (
    <CartCtx.Provider value={{
      carrito, open, setOpen, loading, totalItems,
      fetchCarrito, addItem, updateItem, removeItem, clearCart, updateCartMeta, checkout,
    }}>
      {children}
    </CartCtx.Provider>
  )
}

export function useCart() {
  const ctx = useContext(CartCtx)
  if (!ctx) throw new Error('useCart must be inside CartProvider')
  return ctx
}
