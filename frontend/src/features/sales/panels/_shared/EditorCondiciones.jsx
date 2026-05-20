/**
 * frontend/src/features/sales/panels/_shared/EditorCondiciones.jsx
 *
 * Scaffold compartido del editor de condiciones del documento. Combina los 5
 * CondicionToggle (Validez / Forma de Pago / Entrega / Garantía / Notas)
 * con la lógica común de habilitar/deshabilitar via PIN supervisor.
 *
 * Pensado para reutilizar en:
 *   - PanelPOS (Nueva factura/cotización) — uso actual
 *   - PanelFacturas (editar condiciones de un doc emitido — futuro refactor)
 *   - PanelCotizaciones (mismo) — futuro
 *
 * Props:
 *   values        — { validez, pago, entrega, garantia, notas } textos override
 *   onChange      — (key, value) => void
 *   mostrar       — { validez, pago, entrega, garantia, notas } booleans
 *   onMostrar     — (key, bool) => void
 *   obligatorios  — { validez, entrega, garantia } booleans heredados de
 *                   EmpresaPerfil.condicionesDefault._obligatorio
 *   locked        — true si requiere PIN para editar texto/toggle
 *   onRequestUnlock — () => void para abrir modal de PIN
 *   formaPagoChildren — opcional: render del <select> de Forma de Pago
 *                       (lo deja el padre porque las opciones son específicas)
 *   placeholders  — opcional: { validez, pago, entrega, garantia, notas }
 */

import CondicionToggle from '@shared/components/CondicionToggle'

// Lista completa de toggles que el editor puede renderizar. Cada panel
// consumidor puede pasar `keys` para filtrar (ej. PanelFacturas/Cotizaciones
// no editan "notas" desde aquí — usan otra UI).
const ALL_KEYS = ['validez', 'pago', 'entrega', 'garantia', 'notas']

const META = {
  validez:  { label: 'Validez',              placeholder: 'Ej: Esta cotización es válida por 15 días.',          multiline: false, maxLength: 500  },
  pago:     { label: 'Forma de Pago',        placeholder: '',                                                     multiline: false, maxLength: 500  },
  entrega:  { label: 'Tiempo de Entrega',    placeholder: 'Ej: Entrega en 3-5 días laborables tras confirmación.', multiline: false, maxLength: 500 },
  garantia: { label: 'Garantía',             placeholder: 'Ej: 30 días contra defectos de fabricación.',         multiline: false, maxLength: 500  },
  notas:    { label: 'Notas / Aclaraciones', placeholder: 'Notas internas o aclaraciones para el cliente.',      multiline: true,  maxLength: 2000 },
}

export default function EditorCondiciones({
  values, onChange, mostrar, onMostrar,
  obligatorios = {}, locked = false, onRequestUnlock,
  formaPagoChildren, placeholders = {},
  keys,
}) {
  const renderKeys = Array.isArray(keys) && keys.length > 0
    ? keys.filter(k => ALL_KEYS.includes(k))
    : ALL_KEYS

  return (
    <div className="space-y-2">
      {renderKeys.map((k) => {
        const meta = META[k]
        const isPago = k === 'pago'
        const placeholder = placeholders[k] ?? meta.placeholder
        return (
          <CondicionToggle
            key={k}
            label={meta.label}
            texto={values?.[k] ?? ''}
            onTexto={(v) => onChange(k, v)}
            mostrar={!!mostrar?.[k]}
            onMostrar={(b) => onMostrar(k, b)}
            obligatorio={!!obligatorios[k]}
            locked={locked}
            onRequestUnlock={onRequestUnlock}
            multiline={meta.multiline}
            maxLength={meta.maxLength}
            placeholder={placeholder}
            variant={isPago && formaPagoChildren ? 'select' : 'default'}
          >
            {isPago && formaPagoChildren}
          </CondicionToggle>
        )
      })}
    </div>
  )
}
