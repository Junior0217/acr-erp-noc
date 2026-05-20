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

export default function EditorCondiciones({
  values, onChange, mostrar, onMostrar,
  obligatorios = {}, locked = false, onRequestUnlock,
  formaPagoChildren, placeholders = {},
}) {
  const ph = {
    validez:  placeholders.validez  ?? 'Ej: Esta cotización es válida por 15 días.',
    pago:     placeholders.pago     ?? '',
    entrega:  placeholders.entrega  ?? 'Ej: Entrega en 3-5 días laborables tras confirmación.',
    garantia: placeholders.garantia ?? 'Ej: 30 días contra defectos de fabricación.',
    notas:    placeholders.notas    ?? 'Notas internas o aclaraciones para el cliente.',
  }

  return (
    <div className="space-y-2">
      <CondicionToggle
        label="Validez"
        texto={values.validez ?? ''}
        onTexto={(v) => onChange('validez', v)}
        mostrar={mostrar.validez}
        onMostrar={(b) => onMostrar('validez', b)}
        obligatorio={!!obligatorios.validez}
        locked={locked}
        onRequestUnlock={onRequestUnlock}
        placeholder={ph.validez}
      />

      <CondicionToggle
        label="Forma de Pago"
        texto={values.pago ?? ''}
        onTexto={(v) => onChange('pago', v)}
        mostrar={mostrar.pago}
        onMostrar={(b) => onMostrar('pago', b)}
        obligatorio={false}
        locked={locked}
        onRequestUnlock={onRequestUnlock}
        variant={formaPagoChildren ? 'select' : 'default'}
        placeholder={ph.pago}
      >
        {formaPagoChildren}
      </CondicionToggle>

      <CondicionToggle
        label="Tiempo de Entrega"
        texto={values.entrega ?? ''}
        onTexto={(v) => onChange('entrega', v)}
        mostrar={mostrar.entrega}
        onMostrar={(b) => onMostrar('entrega', b)}
        obligatorio={!!obligatorios.entrega}
        locked={locked}
        onRequestUnlock={onRequestUnlock}
        placeholder={ph.entrega}
      />

      <CondicionToggle
        label="Garantía"
        texto={values.garantia ?? ''}
        onTexto={(v) => onChange('garantia', v)}
        mostrar={mostrar.garantia}
        onMostrar={(b) => onMostrar('garantia', b)}
        obligatorio={!!obligatorios.garantia}
        locked={locked}
        onRequestUnlock={onRequestUnlock}
        placeholder={ph.garantia}
      />

      <CondicionToggle
        label="Notas / Aclaraciones"
        texto={values.notas ?? ''}
        onTexto={(v) => onChange('notas', v)}
        mostrar={mostrar.notas}
        onMostrar={(b) => onMostrar('notas', b)}
        obligatorio={false}
        locked={locked}
        onRequestUnlock={onRequestUnlock}
        multiline
        maxLength={2000}
        placeholder={ph.notas}
      />
    </div>
  )
}
