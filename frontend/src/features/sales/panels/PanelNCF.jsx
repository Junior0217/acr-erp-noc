import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { Settings2, Loader2, Save, Plus, AlertTriangle } from 'lucide-react'
import { apiFetch } from '@shared/utils/api'

// Catálogo conocido de comprobantes fiscales DGII. La UI YA NO filtra por esta
// lista — la lista solo se usa para PRE-SEMBRAR filas que aún no existan en
// ConfiguracionNCF y como referencia descriptiva. Cualquier fila adicional
// presente en la BD (custom tenant) se renderiza también.
const NCF_CATALOGO = [
  { tipoNcf: 'Fiscal',           prefijo: 'B01', tipoDescripcion: 'Crédito Fiscal'             },
  { tipoNcf: 'Consumidor Final', prefijo: 'B02', tipoDescripcion: 'Consumidor Final'           },
  { tipoNcf: 'Nota de Débito',   prefijo: 'B03', tipoDescripcion: 'Notas de Débito (DGII B03)' },
  { tipoNcf: 'Nota de Crédito',  prefijo: 'B04', tipoDescripcion: 'Notas de Crédito (DGII B04)' },
  { tipoNcf: 'Régimen Especial', prefijo: 'B14', tipoDescripcion: 'Régimen Especial'           },
  { tipoNcf: 'Gubernamental',    prefijo: 'B15', tipoDescripcion: 'Gubernamental'              },
]

export default function PanelNCF() {
  const [configs, setConfigs] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(null)
  const [forms,   setForms]   = useState({})

  useEffect(() => { fetchConfigs() }, [])

  async function fetchConfigs() {
    setLoading(true)
    try {
      const r = await apiFetch('/api/ncf-config')
      const j = r.ok ? await r.json() : { data: [] }
      const data = j.data ?? []
      setConfigs(data)
      // Merge: filas reales de la BD primero, luego rellena las del catálogo
      // que aún no existen para que el owner pueda configurarlas y crearlas.
      const init = {}
      const vistas = new Set()
      for (const c of data) {
        init[c.tipoNcf] = { ...c, vencimiento: c.vencimiento ? c.vencimiento.slice(0, 10) : '' }
        vistas.add(c.tipoNcf)
      }
      for (const n of NCF_CATALOGO) {
        if (vistas.has(n.tipoNcf)) continue
        init[n.tipoNcf] = {
          prefijo: n.prefijo, tipoNcf: n.tipoNcf, tipoDescripcion: n.tipoDescripcion,
          secuenciaActual: 0, limite: 99999999, vencimiento: '', activo: true,
        }
      }
      setForms(init)
    } catch {} finally { setLoading(false) }
  }

  // Filas a renderizar: todas las del form, ordenadas por prefijo (B01, B02, B03, B04, ...).
  const filas = useMemo(() => {
    return Object.values(forms).sort((a, b) => String(a.prefijo).localeCompare(String(b.prefijo)))
  }, [forms])

  function setField(tipo, k, v) { setForms(f => ({ ...f, [tipo]: { ...f[tipo], [k]: v } })) }

  async function guardar(tipoNcf) {
    const f = forms[tipoNcf]
    if (!f) return
    setSaving(tipoNcf)
    try {
      const body = {
        prefijo:         f.prefijo,
        tipoNcf:         f.tipoNcf,
        tipoDescripcion: f.tipoDescripcion,
        secuenciaActual: parseInt(f.secuenciaActual) || 0,
        limite:          parseInt(f.limite) || 99999999,
        vencimiento:     f.vencimiento ? new Date(f.vencimiento).toISOString() : null,
        activo:          !!f.activo,
      }
      const r = await apiFetch('/api/ncf-config', { method: 'POST', body: JSON.stringify(body) })
      if (r.ok) { toast.success(`NCF ${tipoNcf} guardado.`); fetchConfigs() }
      else      { const j = await r.json().catch(() => ({})); toast.error(j.error ?? 'Error al guardar.') }
    } catch { toast.error('Error de conexión.') }
    finally  { setSaving(null) }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-500" /></div>

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2 mb-2">
        <Settings2 size={16} className="text-slate-400" />
        <h2 className="text-sm font-bold text-slate-300">Rangos de Comprobantes Fiscales (NCF)</h2>
      </div>
      <p className="text-xs text-slate-500 -mt-2">
        Configura los prefijos y secuencias para cada tipo de NCF según tus rangos autorizados por la DGII.
        <strong className="text-slate-400"> B03</strong> = Notas de Débito · <strong className="text-slate-400">B04</strong> = Notas de Crédito.
      </p>

      {filas.map(f => {
        const noPersistido = !configs.some(c => c.tipoNcf === f.tipoNcf)
        return (
          <div key={f.tipoNcf} className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{f.prefijo}</span>
                <span className="text-xs text-slate-400">{f.tipoDescripcion ?? f.tipoNcf}</span>
                {noPersistido && (
                  <span title="No existe aún en la base de datos. Guarda para crearla."
                    className="flex items-center gap-1 text-[10px] font-bold text-amber-400 bg-amber-600/10 border border-amber-600/30 px-1.5 py-0.5 rounded">
                    <Plus size={9} /> nuevo
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 font-mono">Activo</span>
                <button type="button" onClick={() => setField(f.tipoNcf, 'activo', !f.activo)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${f.activo ? 'bg-blue-600' : 'bg-slate-700'}`}>
                  <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition-transform ${f.activo ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Prefijo</label>
                <input value={f.prefijo ?? ''} onChange={e => setField(f.tipoNcf, 'prefijo', e.target.value)} maxLength={3}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Secuencia actual</label>
                <input type="number" min="0" value={f.secuenciaActual ?? 0} onChange={e => setField(f.tipoNcf, 'secuenciaActual', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Límite</label>
                <input type="number" min="1" value={f.limite ?? 99999999} onChange={e => setField(f.tipoNcf, 'limite', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Vencimiento</label>
                <input type="date" value={f.vencimiento || ''} onChange={e => setField(f.tipoNcf, 'vencimiento', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              {f.limite > 0 && Number(f.secuenciaActual) / Number(f.limite) >= 0.9 ? (
                <span className="flex items-center gap-1 text-[10px] text-red-400 font-mono">
                  <AlertTriangle size={11} /> Restantes: {Number(f.limite) - Number(f.secuenciaActual)} ({Math.round((Number(f.secuenciaActual) / Number(f.limite)) * 100)}% usado)
                </span>
              ) : <span />}
              <button onClick={() => guardar(f.tipoNcf)} disabled={saving === f.tipoNcf}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-600/30 text-xs font-semibold transition-colors disabled:opacity-40">
                {saving === f.tipoNcf ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                Guardar
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
