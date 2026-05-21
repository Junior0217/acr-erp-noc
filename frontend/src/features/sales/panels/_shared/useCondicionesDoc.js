/**
 * frontend/src/features/sales/panels/_shared/useCondicionesDoc.js
 *
 * Hook DRY para editar condiciones comerciales (validez/pago/entrega/garantía)
 * de un documento Factura/Cotización ya emitido. Consolida la lógica que se
 * duplicaba entre PanelFacturas y PanelCotizaciones:
 *
 *   - Shape interno: { [k]: { incluir, texto } } por cada condición.
 *   - `normField`: tolera ingreso legacy (string puro) y nuevo shape (objeto).
 *   - `onChange(k, v)`: si el campo se llena, auto-marca incluir=true (UX:
 *     escribir un valor implica que el usuario lo quiere visible).
 *   - `onMostrar(k, b)`: toggle independiente del texto (el cajero puede
 *     dejar texto y solo apagar la visibilidad temporalmente).
 *   - `serialize()`: devuelve la forma que el backend espera (`{ k: string|null }`)
 *     respetando el toggle `incluir`. Si incluir=false, ese campo va a null.
 *
 * Diseño: el hook NO conoce HTTP — solo expone state + handlers. El caller
 * dispara el PUT con el resultado de `serialize()`.
 *
 * @param {{ validez?, pago?, entrega?, garantia? }} initial — opcional;
 *   cada campo puede ser string legacy o { incluir, texto }.
 */

import { useCallback, useRef, useState } from 'react'

const KEYS = ['validez', 'pago', 'entrega', 'garantia']

export function normCondField(v) {
  if (v == null) return { incluir: false, texto: '' }
  if (typeof v === 'string') return { incluir: !!v.trim(), texto: v }
  return { incluir: !!v.incluir, texto: String(v.texto ?? '') }
}

export function buildCondState(initial = {}) {
  const out = {}
  for (const k of KEYS) out[k] = normCondField(initial?.[k])
  return out
}

// Comparación dirty: dos estados son iguales si todas las claves tienen el
// mismo `texto` e `incluir`. Solo 4 claves × 2 props → comparación manual es
// O(8) y evita la indirección de JSON.stringify (que puede serializar
// distinto si los objetos tienen propiedades en orden diferente).
function condEquals(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  for (const k of KEYS) {
    const av = a[k] ?? { incluir: false, texto: '' }
    const bv = b[k] ?? { incluir: false, texto: '' }
    if (av.incluir !== bv.incluir) return false
    if ((av.texto ?? '') !== (bv.texto ?? '')) return false
  }
  return true
}

export default function useCondicionesDoc(initial) {
  const [cond, setCond] = useState(() => buildCondState(initial))
  // `baseline`: snapshot del último estado "persistido" / "cargado". Se actualiza
  // SOLO en `reset()`. `isDirty` compara `cond` contra `baseline` — apagar el
  // botón Guardar cuando el usuario aún no ha cambiado nada evita PATCH no-op
  // (gasto de cuota billingLimiter + audit-log innecesario).
  const baselineRef = useRef(buildCondState(initial))

  // setters.texto[k]?.(v) — análogo al patrón usado en PanelPOS. Inyecta
  // texto en la condición `k` y auto-marca incluir si pasa de vacío a no-vacío.
  const onChange = useCallback((k, v) => {
    setCond((c) => ({
      ...c,
      [k]: { incluir: c[k]?.incluir || !!v, texto: v ?? '' },
    }))
  }, [])

  const onMostrar = useCallback((k, b) => {
    setCond((c) => ({
      ...c,
      [k]: { ...(c[k] ?? { texto: '' }), incluir: !!b },
    }))
  }, [])

  const reset = useCallback((next) => {
    const fresh = buildCondState(next)
    baselineRef.current = fresh
    setCond(fresh)
  }, [])

  // Derivados para pasar tal cual a <EditorCondiciones />:
  //   values  → { k: string }
  //   mostrar → { k: boolean }
  const values  = {}
  const mostrar = {}
  for (const k of KEYS) {
    values[k]  = cond[k]?.texto ?? ''
    mostrar[k] = !!cond[k]?.incluir
  }

  // serialize → payload listo para PATCH /api/facturas/:id/condiciones.
  // Si la condición está desactivada (incluir=false), enviamos null para
  // que el backend la borre del JSON (no quede texto fantasma).
  const serialize = useCallback(() => {
    const out = {}
    for (const k of KEYS) {
      const c = cond[k]
      out[k] = c?.incluir && c.texto ? c.texto : null
    }
    return out
  }, [cond])

  const isDirty = !condEquals(cond, baselineRef.current)

  return { cond, setCond, values, mostrar, onChange, onMostrar, reset, serialize, isDirty }
}
