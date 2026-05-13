/**
 * EditorDescripcion — formulario estructurado para descripciones de productos,
 * servicios e items de catálogo. SIN markdown manual: campo Título Comercial +
 * lista dinámica de bullets con botón "+". El backend recibe un objeto
 * { v:1, titulo, bullets[], imagenUrl? } que el generador de PDF entiende
 * nativamente.
 *
 * Backwards compat: si recibe un string legacy (markdown viejo) lo deja como
 * está; el campo Título inicia vacío y un toggle "Convertir a estructurado"
 * crea el objeto v=1 a partir del texto plano (mejor que perder el contenido).
 *
 * Props:
 *   value      — string legacy O objeto { v:1, titulo, bullets, imagenUrl }
 *   onChange   — recibe el nuevo objeto (o string si el toggle pasa a legacy)
 *   imageKind  — 'producto' | 'servicio' | 'item-catalogo' (para el dropzone)
 */
import { useMemo, useState } from 'react'
import { Plus, X, Image as ImageIcon, Sparkles, FileText } from 'lucide-react'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const SMALL = 'flex-1 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors'

function valorEstructurado(value) {
  if (value && typeof value === 'object' && value.v === 1) {
    return {
      titulo:    String(value.titulo ?? ''),
      bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b)) : [],
      imagenUrl: value.imagenUrl ?? '',
    }
  }
  // Cualquier otro caso -> objeto vacío base.
  return { titulo: '', bullets: [], imagenUrl: '' }
}

export default function EditorDescripcion({ value, onChange, mostrarImagen = false }) {
  // Detecta si value es markdown legacy (string) vs objeto estructurado.
  const inicialEsLegacy = typeof value === 'string' && value.trim() !== '' && !(value.startsWith('{') && value.includes('"v":1'))
  const [legacyMode, setLegacyMode] = useState(false)
  const [legacyText, setLegacyText] = useState(inicialEsLegacy ? value : '')
  const datos = useMemo(() => valorEstructurado(value), [value])

  function actualizar(parcial) {
    const next = { v: 1, ...datos, ...parcial }
    // Limpia bullets vacíos al guardar (UX: usuario verá los slots vacíos
    // mientras edita, pero el value emitido al padre los descarta).
    next.bullets = next.bullets.filter(b => b.trim() !== '')
    if (!next.imagenUrl) delete next.imagenUrl
    onChange(next)
  }

  function setTitulo(v)            { actualizar({ titulo: v }) }
  function setBullet(i, v)         { const b = [...datos.bullets]; b[i] = v; actualizar({ bullets: b }) }
  function addBullet()             { actualizar({ bullets: [...datos.bullets, ''] }) }
  function delBullet(i)            { actualizar({ bullets: datos.bullets.filter((_, idx) => idx !== i) }) }
  function setImagen(v)            { actualizar({ imagenUrl: v }) }

  function migrarDesdeLegacy() {
    // Parser primitivo: primera línea como título (si arranca con ** o #), resto como bullets.
    const lines = legacyText.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    let titulo = '', bullets = []
    if (lines.length === 0) {
      onChange({ v: 1, titulo: '', bullets: [] }); setLegacyMode(false); return
    }
    const m = lines[0].match(/^\*\*(.+)\*\*\s*$/) || lines[0].match(/^#{1,6}\s+(.+)$/)
    if (m) { titulo = m[1].trim(); bullets = lines.slice(1) }
    else { titulo = lines[0]; bullets = lines.slice(1) }
    bullets = bullets.map(l => l.replace(/^[-*•·]\s+/, '').replace(/^\d+\.\s+/, '').trim()).filter(Boolean)
    onChange({ v: 1, titulo, bullets })
    setLegacyMode(false)
  }

  // Si el usuario empieza con un value legacy, mostramos prompt para migrar.
  if (inicialEsLegacy && !legacyMode && datos.titulo === '' && datos.bullets.length === 0) {
    return (
      <div className="space-y-3 rounded-xl border border-amber-700/40 bg-amber-900/10 p-4">
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-bold text-amber-300 mb-1">Descripción legacy detectada</p>
            <p className="text-[11px] text-amber-200/70 leading-relaxed">
              Esta descripción usa Markdown manual (`**negrita**`, `- bullets`). Conviértela al editor estructurado para que el PDF la renderice perfecto sin que tengas que escribir sintaxis nunca más.
            </p>
          </div>
        </div>
        <pre className="text-[11px] font-mono text-slate-400 bg-slate-900 border border-slate-800 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">{legacyText}</pre>
        <div className="flex gap-2">
          <button type="button" onClick={migrarDesdeLegacy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold">
            <Sparkles size={12} />Migrar a estructurado
          </button>
          <button type="button" onClick={() => setLegacyMode(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs hover:bg-slate-800">
            <FileText size={12} />Editar texto crudo
          </button>
        </div>
      </div>
    )
  }

  if (legacyMode) {
    return (
      <div className="space-y-2">
        <textarea
          className={INPUT + ' min-h-[120px] font-mono text-xs'}
          value={legacyText}
          onChange={e => { setLegacyText(e.target.value); onChange(e.target.value) }}
          rows={5}
          maxLength={2000}
          placeholder={'**Cámara IP 4MP**\n- Visión nocturna IR 30m\n- WDR 120dB'}
        />
        <button type="button" onClick={() => { setLegacyMode(false); migrarDesdeLegacy() }}
          className="text-[11px] text-blue-400 hover:text-blue-300 underline">
          Volver al editor estructurado
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
          Título Comercial
        </label>
        <input
          className={INPUT}
          value={datos.titulo}
          onChange={e => setTitulo(e.target.value)}
          placeholder="Ej. Router WiFi 6 ACR-X200"
          maxLength={200}
        />
      </div>

      <div>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
          Características / Viñetas
        </label>
        <div className="space-y-1.5">
          {datos.bullets.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-blue-400 text-sm leading-none">•</span>
              <input
                className={SMALL}
                value={b}
                onChange={e => setBullet(i, e.target.value)}
                placeholder={`Característica ${i + 1}`}
                maxLength={200}
              />
              <button type="button" onClick={() => delBullet(i)}
                className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                title="Eliminar viñeta">
                <X size={13} />
              </button>
            </div>
          ))}
          {datos.bullets.length < 30 && (
            <button type="button" onClick={addBullet}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-600 text-slate-400 text-xs hover:border-blue-500 hover:text-blue-400 transition-colors">
              <Plus size={12} />Añadir característica
            </button>
          )}
        </div>
      </div>

      {mostrarImagen && (
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <ImageIcon size={11} />Imagen (URL opcional)
          </label>
          <input
            className={INPUT}
            value={datos.imagenUrl ?? ''}
            onChange={e => setImagen(e.target.value)}
            placeholder="https://supabase.../imagen.png"
            maxLength={500}
          />
        </div>
      )}

      <p className="text-[10px] text-slate-600 leading-relaxed">
        Renderiza automático en POS, cotizaciones y facturas. Cero sintaxis Markdown — el sistema arma el formato.
      </p>
    </div>
  )
}
