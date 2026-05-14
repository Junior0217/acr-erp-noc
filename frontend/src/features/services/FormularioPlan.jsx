import { useState, useEffect, useCallback } from 'react'
import { X, Loader2, Plus, Trash2, Search, Sparkles } from 'lucide-react'
import { apiFetch } from '@shared/utils/api'

const API = import.meta.env.VITE_API_URL || ''
const TIPOS = ['WISP','CCTV','Redes','CercosElectricos','VentaEquipos','Mixto']

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

const EMPTY = { nombre: '', tipo: 'WISP', precioMensualBase: '', precioInstalBase: '', activo: true }

export default function FormularioPlan({ plan, onClose, onSaved }) {
  const [form, setForm] = useState(plan ? {
    nombre: plan.nombre,
    tipo: plan.tipo,
    precioMensualBase: plan.precioMensualBase,
    precioInstalBase: plan.precioInstalBase,
    activo: plan.activo,
  } : EMPTY)
  const [plantilla, setPlantilla] = useState(plan?.plantillaEquipos?.map(e => ({ productoId: e.productoId, cantidad: e.cantidad, nombre: e.producto?.nombre ?? '', sku: e.producto?.sku ?? '' })) ?? [])
  const [productoSearch, setProductoSearch] = useState('')
  const [productos, setProductos] = useState([])
  const [loadingProductos, setLoadingProductos] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [proximoSku, setProximoSku] = useState(null)

  useEffect(() => {
    if (!plan) {
      apiFetch('/api/configuracion/secuencias/preview/plan').then(r => r.ok ? r.json() : null)
        .then(j => j?.proximo && setProximoSku(j.proximo))
        .catch(() => {})
    }
  }, [plan])

  const buscarProductos = useCallback(async (q) => {
    if (!q.trim()) { setProductos([]); return }
    setLoadingProductos(true)
    try {
      const r = await fetch(`${API}/api/productos?search=${encodeURIComponent(q)}`)
      const json = await r.json()
      setProductos(json.data ?? [])
    } finally { setLoadingProductos(false) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => buscarProductos(productoSearch), 300)
    return () => clearTimeout(t)
  }, [productoSearch, buscarProductos])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function agregarProducto(p) {
    if (plantilla.find(e => e.productoId === p.id)) return
    setPlantilla(prev => [...prev, { productoId: p.id, cantidad: 1, nombre: p.nombre, sku: p.sku }])
    setProductoSearch('')
    setProductos([])
  }

  function quitarProducto(id) { setPlantilla(prev => prev.filter(e => e.productoId !== id)) }
  function setCantidad(id, v) { setPlantilla(prev => prev.map(e => e.productoId === id ? { ...e, cantidad: Math.max(1, parseInt(v) || 1) } : e)) }

  async function guardar() {
    setSaving(true); setError('')
    try {
      const body = {
        ...form,
        precioMensualBase: parseFloat(form.precioMensualBase) || 0,
        precioInstalBase:  parseFloat(form.precioInstalBase) || 0,
        plantillaEquipos: plantilla.map(({ productoId, cantidad }) => ({ productoId, cantidad })),
      }
      const url = plan ? `${API}/api/planes/${plan.id}` : `${API}/api/planes`
      const r = await fetch(url, { method: plan ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await r.json()
      if (!r.ok) { setError(json.error ?? 'Error al guardar'); return }
      onSaved(json)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">{plan ? 'Editar Plan' : 'Nuevo Plan'}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>SKU del Plan</label>
              <div className="px-3 py-2 rounded-lg bg-blue-900/15 border border-blue-700/30 text-sm text-blue-300 font-mono flex items-center gap-2">
                <Sparkles size={12} className="text-blue-400" />
                {plan ? (plan.sku ?? 'Sin SKU (plan legacy)') : (proximoSku ?? 'Auto-generado al guardar')}
              </div>
              <p className="text-[10px] text-slate-600 mt-1">
                {plan ? 'SKU inmutable post-creación.' : 'Configurable en Configuración → Secuencias.'}
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL}>Nombre del Plan</label>
              <input className={INPUT} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej. WISP 50Mbps Residencial" />
            </div>
            <div>
              <label className={LABEL}>Tipo de Servicio</label>
              <select className={INPUT} value={form.tipo} onChange={e => set('tipo', e.target.value)}>
                {TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3 pt-5">
              <input type="checkbox" id="activo" checked={form.activo} onChange={e => set('activo', e.target.checked)} className="w-4 h-4 accent-blue-600 rounded" />
              <label htmlFor="activo" className="text-sm text-slate-300">Plan activo</label>
            </div>
            <div>
              <label className={LABEL}>Precio Mensual Base (RD$)</label>
              <input type="number" min="0" step="0.01" className={INPUT} value={form.precioMensualBase} onChange={e => set('precioMensualBase', e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <label className={LABEL}>Precio Instalación Base (RD$)</label>
              <input type="number" min="0" step="0.01" className={INPUT} value={form.precioInstalBase} onChange={e => set('precioInstalBase', e.target.value)} placeholder="0.00" />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Plantilla de Equipos</p>
            <div className="relative mb-3">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input className={INPUT + ' pl-8'} value={productoSearch} onChange={e => setProductoSearch(e.target.value)} placeholder="Buscar producto por nombre o SKU..." />
              {loadingProductos && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 animate-spin" />}
            </div>
            {productos.length > 0 && (
              <div className="mb-3 border border-slate-700 rounded-lg overflow-hidden divide-y divide-slate-800">
                {productos.map(p => (
                  <button key={p.id} onClick={() => agregarProducto(p)} className="w-full flex items-center justify-between px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors text-left">
                    <span>{p.nombre} <span className="text-slate-600 font-mono text-xs">{p.sku}</span></span>
                    <span className="text-slate-500 text-xs">Stock: {p.stockActual}</span>
                  </button>
                ))}
              </div>
            )}
            {plantilla.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4 border border-dashed border-slate-800 rounded-lg">Sin equipos en la plantilla</p>
            ) : (
              <div className="border border-slate-800 rounded-lg overflow-hidden divide-y divide-slate-800">
                {plantilla.map(e => (
                  <div key={e.productoId} className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 truncate">{e.nombre}</p>
                      <p className="text-xs text-slate-600 font-mono">{e.sku}</p>
                    </div>
                    <input type="number" min="1" value={e.cantidad} onChange={ev => setCantidad(e.productoId, ev.target.value)}
                      className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 text-center focus:outline-none focus:border-blue-500" />
                    <button onClick={() => quitarProducto(e.productoId)} className="text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <p className="px-5 pb-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">Cancelar</button>
          <button onClick={guardar} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {plan ? 'Guardar Cambios' : 'Crear Plan'}
          </button>
        </div>
      </div>
    </div>
  )
}
