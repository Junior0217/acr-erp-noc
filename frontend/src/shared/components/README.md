# shared/components

Componentes reusables del frontend. Cada uno tiene una sola responsabilidad y se importa desde `@shared/components/<Nombre>`.

## CondicionToggle

Bloque de "switch + input" para condiciones del documento (Validez, Forma de Pago, Entrega, Garantía, Notas). Mantiene la unificación visual del POS y los paneles de facturas/cotizaciones — **NO duplicar el patrón en otros archivos.**

### Cuándo usarlo

- Cualquier sección donde el cajero deba decidir si una condición se imprime en el PDF (toggle on/off) **y** opcionalmente edite el texto override.
- Tres consumidores actuales:
  1. `PanelPOS.jsx` — al construir factura/cotización nueva
  2. `_shared/EditorCondiciones.jsx` — wrapper que combina los 5 toggles + PIN unlock (reutilizado por paneles de listado al editar un documento ya emitido)
  3. Cualquier futuro panel de edición post-emisión

### API (props)

| Prop | Tipo | Required | Descripción |
|---|---|---|---|
| `label` | `string` | sí | Etiqueta del header ("Validez", "Forma de Pago", etc.) |
| `texto` | `string` | sí | Valor actual del override (controlled) |
| `onTexto` | `(s: string) => void` | sí | Callback al cambiar el texto |
| `mostrar` | `boolean` | sí | Estado del switch (visible en PDF) |
| `onMostrar` | `(b: boolean) => void` | sí | Callback al cambiar el switch |
| `obligatorio` | `boolean` | no | Si `true`, el switch queda ON y deshabilitado (icono candado). Configurable desde `EmpresaPerfil.condicionesDefault._obligatorio` |
| `multiline` | `boolean` | no | Usa `<textarea>` en vez de `<input>` (para Notas) |
| `placeholder` | `string` | no | Placeholder del input |
| `maxLength` | `number` | no | Default `500`. Para Notas usar `2000` |
| `locked` | `boolean` | no | Si `true`, el texto no se puede editar — el usuario debe autenticar con PIN supervisor primero |
| `onRequestUnlock` | `() => void` | no | Callback para abrir el modal de PIN cuando `locked === true` |
| `variant` | `'default' \| 'select'` | no | Si `'select'`, el children es un control alternativo (ej. `<select>` para Forma de Pago) en lugar del input de texto |
| `children` | `ReactNode` | no | Solo aplica con `variant='select'` |

### Restricciones (NO hacer)

1. **NO** copiar la lógica del componente en otros archivos. Si necesitas variar el look, **extiende** el componente con nueva prop, no duplicar.
2. **NO** inlinear directamente el toggle visual (`<button>` + badge) en otros forms — eso rompe la unificación con POS.
3. **NO** persistir el valor `mostrar` localmente al estado del componente. El componente es controlled — el padre maneja el estado (típicamente via `usePreferenciasPOS` para POS o estado local del modal para post-emisión).
4. **NO** mezclar la lógica de PIN dentro del componente. Si requieres bloqueo por PIN, pasa `locked={true}` + `onRequestUnlock` desde el padre.
5. **NO** asumir que `obligatorio` viene del frontend. Backend `mergeCondiciones` enforce los obligatorios desde `EmpresaPerfil.condicionesDefault._obligatorio` — el frontend solo lo refleja visualmente.

### Patrón canónico de consumo

```jsx
import CondicionToggle from '@shared/components/CondicionToggle'

<CondicionToggle
  label="Validez"
  texto={validezTexto}
  onTexto={setValidezTexto}
  mostrar={mostrarValidez}
  onMostrar={setMostrarValidez}
  obligatorio={obligValidez}
  locked={!effectiveUnlocked}
  onRequestUnlock={() => setPinModalOpen(true)}
  placeholder="Ej: Esta cotización es válida por 15 días."
/>
```

### Para 5 toggles juntos: usar EditorCondiciones

Si necesitas los 5 toggles (Validez + Pago + Entrega + Garantía + Notas), **NO los compongas a mano** — importa el scaffold:

```jsx
import EditorCondiciones from '@features/sales/panels/_shared/EditorCondiciones'

<EditorCondiciones
  values={{ validez, pago, entrega, garantia, notas }}
  onChange={(key, val) => setCondicion(key, val)}
  mostrar={mostrarFlags}
  onMostrar={(key, b) => setMostrar(key, b)}
  obligatorios={empresa?.condicionesDefault?._obligatorio ?? {}}
  locked={!effectiveUnlocked}
  onRequestUnlock={() => setPinModalOpen(true)}
  formaPagoChildren={<select>...</select>}
/>
```

---

## Otros componentes

Lista actualizable según se agreguen. Cada componente nuevo debe tener su sección aquí con: cuándo usarlo, API completa, restricciones, y patrón canónico.

| Componente | Propósito | Archivo |
|---|---|---|
| `CondicionToggle` | Toggle de condición del documento | `CondicionToggle.jsx` |
| `ACRBranding` | Wordmark + colors corporativos | `ACRBranding.jsx` |
| `ACRLogo` | Logo SVG inline | `ACRLogo.jsx` |
| `CarritoSlideOver` | Drawer lateral del carrito POS | `CarritoSlideOver.jsx` |
| `EditorDescripcion` | Editor markdown ligero para descripciones | `EditorDescripcion.jsx` |
| `ErrorBoundary` | React error boundary global | `ErrorBoundary.jsx` |
| `ImageDropzone` | Upload + preview imágenes | `ImageDropzone.jsx` |
| `PdfPreviewDrawer` | Drawer para preview PDFs | `PdfPreviewDrawer.jsx` |
| `PinAuthModal` | Modal PIN supervisor (Zero Trust) | `PinAuthModal.jsx` |
| `PWAUpdatePrompt` | Banner de "nueva versión disponible" | `PWAUpdatePrompt.jsx` |
| `SessionsWidget` | Lista de sesiones activas | `SessionsWidget.jsx` |
| `VoiceDictationButton` | Botón de dictado voz → texto | `VoiceDictationButton.jsx` |
