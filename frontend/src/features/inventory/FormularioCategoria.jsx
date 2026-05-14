import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { apiFetch } from '@shared/utils/api'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

export default function FormularioCategoria({ categoria, onClose, onSaved }) {
  const [nombre, setNombre] = useState(categoria?.nombre ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function guardar() {
    setSaving(true); setError('')
    try {
      // apiFetch inyecta X-CSRF-Token + cookie credentials. fetch crudo daba 403.
      const path = categoria ? `/api/categorias/${categoria.id}` : '/api/categorias'
      const method = categoria ? 'PUT' : 'POST'
      const r = await apiFetch(path, { method, body: JSON.stringify({ nombre }) })
      const json = await r.json()
      if (!r.ok) { setError(json.error ?? 'Error al guardar'); return }
      onSaved(json)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  function onKey(e) { if (e.key === 'Enter' && nombre.trim()) guardar() }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">
            {categoria ? 'Editar Categoría' : 'Nueva Categoría'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className={LABEL}>Nombre</label>
            <input
              className={INPUT}
              value={nombre}
              onChange={e => setNombre(e.target.value)}
              onKeyDown={onKey}
              placeholder="Ej. Cámaras IP, Switches, Cables..."
              autoFocus
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={saving || !nombre.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {categoria ? 'Guardar Cambios' : 'Crear Categoría'}
          </button>
        </div>
      </div>
    </div>
  )
}
