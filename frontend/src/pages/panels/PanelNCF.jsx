import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Settings2, Loader2, Save } from 'lucide-react'
import { apiFetch } from '../../utils/api'

export default function PanelNCF() {
  const NCF_TIPOS = [
    { tipoNcf: 'B01', tipoDescripcion: 'Crédito Fiscal',  prefijo: 'B01' },
    { tipoNcf: 'B02', tipoDescripcion: 'Consumidor Final', prefijo: 'B02' },
    { tipoNcf: 'B14', tipoDescripcion: 'Régimen Especial', prefijo: 'B14' },
    { tipoNcf: 'B15', tipoDescripcion: 'Gubernamental',    prefijo: 'B15' },
  ]
  const [configs,  setConfigs]  = useState([])
  const [loading,  setLoading]  = useState(false)
  const [saving,   setSaving]   = useState(null)
  const [forms,    setForms]    = useState({})

  useEffect(() => {
    setLoading(true)
    apiFetch('/api/ncf-config')
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => {
        const data = j.data ?? []
        setConfigs(data)
        const init = {}
        NCF_TIPOS.forEach(n => {
          const existing = data.find(c => c.tipoNcf === n.tipoNcf)
          init[n.tipoNcf] = existing
            ? { ...existing, vencimiento: existing.vencimiento ? existing.vencimiento.slice(0, 10) : '' }
            : { prefijo: n.prefijo, tipoNcf: n.tipoNcf, tipoDescripcion: n.tipoDescripcion, secuenciaActual: 0, limite: 9999999, vencimiento: '', activo: true }
        })
        setForms(init)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

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
        limite:          parseInt(f.limite) || 9999999,
        vencimiento:     f.vencimiento ? new Date(f.vencimiento).toISOString() : null,
        activo:          f.activo,
      }
      const r = await apiFetch('/api/ncf-config', { method: 'POST', body: JSON.stringify(body) })
      if (r.ok) toast.success(`NCF ${tipoNcf} guardado.`)
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSaving(null) }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-500" /></div>

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2 mb-2">
        <Settings2 size={16} className="text-slate-400" />
        <h2 className="text-sm font-bold text-slate-300">Rangos de Comprobantes Fiscales (NCF)</h2>
      </div>
      <p className="text-xs text-slate-500 -mt-2">Configura los prefijos y secuencias para cada tipo de NCF según tus rangos autorizados por la DGII.</p>

      {NCF_TIPOS.map(n => {
        const f = forms[n.tipoNcf]
        if (!f) return null
        return (
          <div key={n.tipoNcf} className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{n.tipoNcf}</span>
                <span className="text-xs text-slate-400">{n.tipoDescripcion}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-600 font-mono">Activo</span>
                <button type="button" onClick={() => setField(n.tipoNcf, 'activo', !f.activo)}
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${f.activo ? 'bg-blue-600' : 'bg-slate-700'}`}>
                  <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition-transform ${f.activo ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Prefijo</label>
                <input value={f.prefijo} onChange={e => setField(n.tipoNcf, 'prefijo', e.target.value)} maxLength={3}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Secuencia actual</label>
                <input type="number" min="0" value={f.secuenciaActual} onChange={e => setField(n.tipoNcf, 'secuenciaActual', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Límite</label>
                <input type="number" min="1" value={f.limite} onChange={e => setField(n.tipoNcf, 'limite', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Vencimiento</label>
                <input type="date" value={f.vencimiento || ''} onChange={e => setField(n.tipoNcf, 'vencimiento', e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={() => guardar(n.tipoNcf)} disabled={saving === n.tipoNcf}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-600/30 text-xs font-semibold transition-colors disabled:opacity-40">
                {saving === n.tipoNcf ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                Guardar
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
