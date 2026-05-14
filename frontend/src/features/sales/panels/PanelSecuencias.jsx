/**
 * PanelSecuencias — gestor visual de prefijos + contadores actuales por entidad.
 * Owner edita prefijo (ej. "FAC" -> "INV"), número de inicio (jump-forward para
 * migraciones) y padding (ceros a la izquierda). Backend auto-aplica defaults
 * a entidades faltantes en /api/configuracion/secuencias.
 *
 * Atomicidad: el guardado solo persiste preferencias. El incremento real ocurre
 * cuando se POSTea una factura/producto vía generarSiguienteCodigo() — un UPDATE
 * RETURNING atómico en EmpresaPerfil que serializa concurrentes sin colisión.
 */
import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, Save, Hash, AlertCircle, CheckCircle, RefreshCw, Wand2, AlertTriangle } from 'lucide-react'
import { apiFetch } from '@shared/utils/api'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500'
const LABEL = 'block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1'

const ENTIDADES = [
  { key: 'factura',    label: 'Facturas',     desc: 'Documentos fiscales emitidos a clientes.' },
  { key: 'cotizacion', label: 'Cotizaciones', desc: 'Propuestas comerciales pre-venta.' },
  { key: 'cliente',    label: 'Clientes',     desc: 'Número de cliente único (no fiscal).' },
  { key: 'producto',   label: 'Artículos',    desc: 'SKUs auto-generados (inventario).' },
  { key: 'servicio',   label: 'Servicios',    desc: 'Contratos/suscripciones de servicio.' },
  { key: 'plan',       label: 'Planes ISP',   desc: 'SKU del plan (WISP/CCTV/Mixto).' },
  { key: 'rma',        label: 'Tickets RMA',  desc: 'Reparación y servicio técnico en taller.' },
]

export default function PanelSecuencias() {
  const [secuencias, setSecuencias] = useState({})
  const [previews, setPreviews]     = useState({})
  const [busy, setBusy]   = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [migrando, setMigrando] = useState(false)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/configuracion/secuencias')
      if (r.ok) {
        const j = await r.json()
        setSecuencias(j.secuencias ?? {})
        // Preview por entidad
        const previewMap = {}
        await Promise.all(ENTIDADES.map(async ({ key }) => {
          try {
            const pr = await apiFetch(`/api/configuracion/secuencias/preview/${key}`)
            if (pr.ok) { const pj = await pr.json(); previewMap[key] = pj.proximo }
          } catch {}
        }))
        setPreviews(previewMap)
      }
    } catch { toast.error('Error cargando secuencias.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  function setCampo(entidad, campo, valor) {
    setSecuencias(prev => ({
      ...prev,
      [entidad]: { ...(prev[entidad] ?? {}), [campo]: valor },
    }))
    setDirty(true)
  }

  async function guardar() {
    setBusy(true)
    try {
      // Solo enviar lo que fue tocado por el user; backend hace merge con lo existente.
      const payload = {}
      for (const { key } of ENTIDADES) {
        const s = secuencias[key]
        if (!s) continue
        payload[key] = {
          prefijo: String(s.prefijo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
          actual:  parseInt(s.actual ?? 0, 10),
          padding: parseInt(s.padding ?? 6, 10),
        }
      }
      const r = await apiFetch('/api/configuracion/secuencias', { method: 'PATCH', body: JSON.stringify(payload) })
      const j = await r.json()
      if (r.ok) {
        toast.success('Secuencias actualizadas.')
        setDirty(false)
        await cargar()
      } else {
        toast.error(j.error ?? 'Error al guardar.')
      }
    } catch { toast.error('Error de red.') }
    finally { setBusy(false) }
  }

  async function migrarDescripciones() {
    if (!window.confirm('Migrar todas las descripciones legacy a formato estructurado v=1. Esta acción es idempotente (re-ejecutar no daña nada). ¿Continuar?')) return
    setMigrando(true)
    try {
      const r = await apiFetch('/api/admin/migrar-descripciones', { method: 'POST' })
      const j = await r.json()
      if (r.ok) {
        toast.success(j.resumen ?? 'Migración completada.', { duration: 10000 })
      } else {
        toast.error(j.error ?? 'Error en la migración.')
      }
    } catch { toast.error('Error de red durante la migración.') }
    finally { setMigrando(false) }
  }

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Hash size={20} className="text-blue-400" />
          <div>
            <h2 className="text-lg font-bold text-slate-100">Secuencias y Nomenclaturas</h2>
            <p className="text-xs text-slate-500">Prefijo + número de inicio + padding para cada módulo del ERP.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={cargar} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 text-xs flex items-center gap-1.5 disabled:opacity-40">
            <RefreshCw size={12} />Refrescar
          </button>
          <button type="button" onClick={guardar} disabled={!dirty || busy}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Guardar
          </button>
        </div>
      </div>

      <div className="bg-amber-900/15 border border-amber-700/30 rounded-lg p-3 flex items-start gap-2">
        <AlertCircle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="text-[11px] text-amber-200/80 leading-relaxed">
          <strong className="text-amber-300">Atomicidad garantizada:</strong> dos cajeros que crean factura simultánea reciben códigos consecutivos distintos (FAC-000007 y FAC-000008). El UPDATE en EmpresaPerfil bloquea la fila durante el incremento — Postgres serializa por contienda de write-lock, no por nivel de aislamiento. Cambiar el prefijo aquí solo afecta documentos FUTUROS; los existentes mantienen su código original.
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(Array.isArray(ENTIDADES) ? ENTIDADES : []).map(({ key, label, desc }) => {
          const s = secuencias[key] ?? { prefijo: '', actual: 0, padding: 6 }
          return (
            <div key={key} className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-100">{label}</h3>
                  <p className="text-[10px] text-slate-500 leading-relaxed">{desc}</p>
                </div>
                {previews[key] && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-900/20 border border-emerald-700/30">
                    <CheckCircle size={10} className="text-emerald-400" />
                    <span className="text-[10px] font-mono text-emerald-300">{previews[key]}</span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className={LABEL}>Prefijo</label>
                  <input className={INPUT}
                    value={s.prefijo ?? ''}
                    maxLength={10}
                    onChange={e => setCampo(key, 'prefijo', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="FAC" />
                </div>
                <div>
                  <label className={LABEL}>Actual</label>
                  <input className={INPUT} type="number" min="0"
                    value={s.actual ?? 0}
                    onChange={e => setCampo(key, 'actual', parseInt(e.target.value) || 0)} />
                </div>
                <div>
                  <label className={LABEL}>Padding</label>
                  <input className={INPUT} type="number" min="3" max="10"
                    value={s.padding ?? 6}
                    onChange={e => setCampo(key, 'padding', parseInt(e.target.value) || 6)} />
                </div>
              </div>
              <p className="text-[10px] text-slate-600 mt-2 font-mono">
                Próximo: <span className="text-blue-400">{`${(s.prefijo || '').padEnd(1, '?')}-${String((s.actual ?? 0) + 1).padStart(s.padding ?? 6, '0')}`}</span>
              </p>
            </div>
          )
        })}
      </div>

      {/* ─── Zona de Mantenimiento ─────────────────────────────────────── */}
      <div className="mt-6 bg-red-900/10 border border-red-700/30 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-red-300 mb-1">Mantenimiento · Migración de Datos</h3>
            <p className="text-[11px] text-red-200/70 leading-relaxed mb-3">
              Convierte todas las descripciones legacy (Markdown manual con <code>**bold**</code> y <code>- bullets</code>) al formato estructurado <code>{`{v:1, titulo, bullets[]}`}</code>. Aplica a Productos e Items de Catálogo. Idempotente — los registros ya migrados se ignoran automáticamente.
            </p>
            <button type="button" onClick={migrarDescripciones} disabled={migrando}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold disabled:opacity-40 transition-colors">
              {migrando ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {migrando ? 'Migrando…' : 'Migrar Descripciones (Legacy)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
