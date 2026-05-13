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

  // ─── Carrito POS persistente (localStorage) ────────────────────────────────
  // El POS vende ItemCatalogo (no Producto físico directo). Antes se guardaba en
  // useState local de PanelPOS y se evaporaba al cambiar de tab. Ahora vive aquí,
  // se hidrata desde localStorage y sobrevive a navegación + refresh.
  const POS_CART_KEY = 'acr_pos_cart'
  const [posCart, setPosCart] = useState(() => {
    try { const raw = localStorage.getItem(POS_CART_KEY); return raw ? JSON.parse(raw) : [] }
    catch { return [] }
  })
  // Persiste cada cambio (debounced no necesario — operaciones del POS son lentas).
  useEffect(() => {
    try { localStorage.setItem(POS_CART_KEY, JSON.stringify(posCart)) } catch {}
  }, [posCart])

  const posItemsCount = posCart.reduce((s, l) => s + (l.cantidad ?? 0), 0)

  function posAddItem(item, qty = 1) {
    // Discrimina la fuente:
    //   item.id (UUID)        -> venta desde ItemCatalogo
    //   item.productoId (Int) -> venta directa de Producto físico (cross-sell, scanner)
    // Cada modo se identifica por línea via itemCatalogoId XOR productoId
    // (el backend valida exactly-one-of con Zod).
    const isProducto = !item.id && item.productoId != null
    setPosCart(prev => {
      const matchIdx = isProducto
        ? prev.findIndex(l => l.productoId === item.productoId)
        : prev.findIndex(l => l.itemCatalogoId === item.id)
      if (matchIdx >= 0) {
        const next = [...prev]
        next[matchIdx] = { ...next[matchIdx], cantidad: next[matchIdx].cantidad + qty }
        return next
      }
      return [...prev, {
        itemCatalogoId: isProducto ? null : item.id,
        productoId:     isProducto ? item.productoId : null,
        nombre:         item.nombre,
        cantidad:       qty,
        precioUnitario: Number(item.precio),
        descuentoPorcentaje: 0,
        descuentoMonto:      0,
        imagenUrl:      item.imagenUrl ?? null,
        codigo:         item.codigo ?? item.sku ?? null,
      }]
    })
  }
  function posUpdateLine(idx, changes) { setPosCart(prev => prev.map((l, i) => i === idx ? { ...l, ...changes } : l)) }
  function posRemoveLine(idx)          { setPosCart(prev => prev.filter((_, i) => i !== idx)) }
  function posClear()                  { setPosCart([]) }

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

  async function checkout(esCotizacion = false, tipoNcfOverride, nombreTemporal, descuentoGlobal = {}) {
    setLoading(true)
    try {
      const body = { esCotizacion }
      if (tipoNcfOverride) body.tipoNcfOverride = tipoNcfOverride
      if (nombreTemporal)  body.nombreTemporal  = nombreTemporal
      if (descuentoGlobal.descuentoGlobalPct   > 0) body.descuentoGlobalPct   = descuentoGlobal.descuentoGlobalPct
      if (descuentoGlobal.descuentoGlobalMonto > 0) body.descuentoGlobalMonto = descuentoGlobal.descuentoGlobalMonto
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
      posCart, posItemsCount, posAddItem, posUpdateLine, posRemoveLine, posClear,
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
