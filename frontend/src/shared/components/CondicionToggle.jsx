/**
 * frontend/src/shared/components/CondicionToggle.jsx
 *
 * Bloque reusable para condiciones del documento (Validez / Forma de Pago /
 * Entrega / Garantía / Notas). Extraído del PanelPOS para reutilizarlo en
 * panels de facturas y cotizaciones (editor de condiciones post-emisión).
 *
 * API:
 *   label           : string — texto del header del bloque (ej. "Validez")
 *   texto           : string — valor actual del override
 *   onTexto         : (s) => void — callback al cambiar texto
 *   mostrar         : boolean — switch on/off (visible en PDF)
 *   onMostrar       : (b) => void — callback al cambiar switch
 *   obligatorio     : boolean — si true, switch locked ON con ícono candado
 *                     (owner lo forzó desde EmpresaPerfil._obligatorio)
 *   multiline       : boolean — usar <textarea> en lugar de <input>
 *   placeholder     : string
 *   maxLength       : number
 *   locked          : boolean — texto en read-only (requiere PIN supervisor)
 *   onRequestUnlock : () => void — callback para abrir modal de PIN
 *   variant         : 'default' | 'select' — si 'select', el children es un
 *                     <select> u otro control en lugar del input de texto
 *   children        : ReactNode — render alternativo (si variant='select')
 */

import { Lock } from 'lucide-react'

export default function CondicionToggle({
  label, texto, onTexto, mostrar, onMostrar,
  obligatorio = false, multiline = false, placeholder = '', maxLength = 500,
  locked = false, onRequestUnlock,
  variant = 'default',
  children,
}) {
  const on = obligatorio ? true : mostrar
  const textoLocked = locked

  return (
    <div className={`w-full overflow-hidden rounded-lg border px-2.5 py-1.5 transition-colors ${on ? 'border-blue-600/30 bg-blue-600/5' : 'border-slate-800 bg-slate-900/40'}`}>
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium text-slate-200">{label}</span>
          {obligatorio && <Lock size={9} className="flex-shrink-0 text-amber-400" />}
          <span className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${on ? 'bg-blue-600/20 text-blue-300 border-blue-600/30' : 'bg-slate-800 text-slate-500 border-slate-700'}`}>
            {obligatorio ? 'Forzado' : (on ? 'En PDF' : 'Oculto')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (obligatorio) return
            if (locked) { onRequestUnlock?.(); return }
            onMostrar(!on)
          }}
          disabled={obligatorio}
          aria-pressed={on}
          aria-label={`Toggle ${label}`}
          className={`relative inline-flex h-4 w-8 flex-shrink-0 rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-slate-700'} ${obligatorio ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>
      {on && variant === 'select' && (
        <div className={`mt-1 ${textoLocked ? 'opacity-60 pointer-events-none' : ''}`}>
          {children}
        </div>
      )}
      {on && variant === 'default' && (multiline ? (
        <textarea
          rows={2} maxLength={maxLength} value={texto}
          onChange={e => onTexto(e.target.value)}
          placeholder={textoLocked ? 'Override bloqueado · requiere PIN supervisor (clic en el switch)' : placeholder}
          disabled={textoLocked}
          onClick={() => { if (textoLocked) onRequestUnlock?.() }}
          className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500 resize-y disabled:opacity-40 disabled:cursor-not-allowed"
        />
      ) : (
        <input
          type="text" maxLength={maxLength} value={texto}
          onChange={e => onTexto(e.target.value)}
          placeholder={textoLocked ? 'Override bloqueado · requiere PIN supervisor' : placeholder}
          disabled={textoLocked}
          onClick={() => { if (textoLocked) onRequestUnlock?.() }}
          className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
        />
      ))}
      {on && multiline && variant === 'default' && (
        <span className="text-[9px] text-slate-600">{(texto?.length ?? 0)}/{maxLength}</span>
      )}
    </div>
  )
}
