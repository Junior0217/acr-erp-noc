import { useState, useEffect } from 'react'
import { X, Loader2, Info } from 'lucide-react'
import { apiFetch } from '../../utils/api'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

export default function FormularioProducto({ producto, onClose, onSaved }) {
  const [form, setForm] = useState({
    sku:         producto?.sku ?? '',
    nombre:      producto?.nombre ?? '',
    precio:      producto?.precio ?? '',
    categoriaId: producto?.categoriaId ?? '',
    imagenUrl:   producto?.imagenUrl ?? '',
    descripcion: producto?.descripcion ?? '',
  })
  const [categorias, setCategorias] = useState([])
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    // apiFetch para hidratar categorías (GET no exige CSRF pero conserva cookie auth).
    apiFetch('/api/categorias')
      .then(r => r.json())
      .then(j => setCategorias(j.data ?? []))
      .catch(() => {})
  }, [])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function guardar() {
    setSaving(true); setError('')
    try {
      const body = {
        nombre:      form.nombre,
        precio:      parseFloat(form.precio) || 0,
        categoriaId: parseInt(form.categoriaId),
        imagenUrl:   form.imagenUrl || null,
        descripcion: form.descripcion || null,
      }
      if (!producto) body.sku = form.sku

      const path   = producto ? `/api/productos/${producto.id}` : '/api/productos'
      const method = producto ? 'PUT' : 'POST'
      const r    = await apiFetch(path, { method, body: JSON.stringify(body) })
      const json = await r.json()
      if (!r.ok) { setError(json.error ?? 'Error al guardar'); return }
      onSaved(json)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  const canSave = form.nombre.trim() && form.categoriaId && (!producto ? form.sku.trim() : true)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">
            {producto ? 'Editar Producto' : 'Nuevo Producto'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>SKU</label>
              {producto ? (
                <div className="px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700 text-sm text-slate-400 font-mono">
                  {producto.sku}
                </div>
              ) : (
                <input
                  className={INPUT}
                  value={form.sku}
                  onChange={e => set('sku', e.target.value)}
                  placeholder="Ej. CAM-4MP-HIKVISION"
                />
              )}
            </div>
            <div>
              <label className={LABEL}>Precio (RD$)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className={INPUT}
                value={form.precio}
                onChange={e => set('precio', e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div>
            <label className={LABEL}>Nombre</label>
            <input
              className={INPUT}
              value={form.nombre}
              onChange={e => set('nombre', e.target.value)}
              placeholder="Nombre descriptivo del producto"
            />
          </div>

          <div>
            <label className={LABEL}>Categoría</label>
            <select className={INPUT} value={form.categoriaId} onChange={e => set('categoriaId', e.target.value)}>
              <option value="">Seleccionar categoría...</option>
              {categorias.map(c => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL}>Imagen (URL)</label>
            <div className="flex gap-2">
              <input className={INPUT} value={form.imagenUrl} onChange={e => set('imagenUrl', e.target.value)}
                placeholder="https://… (pega aquí el link de Supabase Storage o subir luego)" />
              {form.imagenUrl && (
                <div className="w-12 h-10 rounded-lg overflow-hidden bg-slate-800 border border-slate-700 flex-shrink-0">
                  <img src={form.imagenUrl} alt="" className="w-full h-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} />
                </div>
              )}
            </div>
          </div>

          <div>
            <label className={LABEL}>Descripción (admite Markdown ligero)</label>
            <textarea className={INPUT + ' min-h-[80px] font-mono text-xs'} value={form.descripcion}
              onChange={e => set('descripcion', e.target.value)} rows={3}
              placeholder={'**Cámara IP 4MP**\n- Visión nocturna IR 30m\n- WDR 120dB\n- POE 802.3af'} maxLength={1000} />
            <p className="text-[10px] text-slate-600 mt-1">Soporta **negrita**, *cursiva*, - listas. Se ve en POS + PDF.</p>
          </div>

          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-blue-900/20 border border-blue-700/30">
            <Info size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-blue-300 leading-relaxed">
              El stock se gestiona únicamente a través de Órdenes de Instalación (Kardex). No es editable desde este formulario.
            </p>
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
            disabled={saving || !canSave}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {producto ? 'Guardar Cambios' : 'Crear Producto'}
          </button>
        </div>
      </div>
    </div>
  )
}
