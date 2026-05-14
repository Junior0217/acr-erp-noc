import { useState, useEffect, useCallback } from 'react'
import { X, Loader2, Trash2, Search, AlertTriangle, CheckCircle, Shield } from 'lucide-react'
import VoiceDictationButton from '@shared/components/VoiceDictationButton'
import FotosOT from './FotosOT'

const API = import.meta.env.VITE_API_URL || ''

const CON_DIAGNOSTICO = new Set(['ServicioTecnico','Mantenimiento'])

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

export default function FormularioOrden({ orden, servicioId, onClose, onSaved }) {
  const [form, setForm] = useState({
    servicioId:  servicioId ?? orden?.servicioId ?? '',
    tipo:        orden?.tipo ?? 'Instalacion',
    tecnicoId:   orden?.tecnico?.id ?? '',
    notas:       orden?.notas ?? '',
    diagnostico: orden?.diagnostico ?? '',
    solucion:    orden?.solucion ?? '',
    garantiaDias: orden?.garantiaDias ?? '',
  })
  const [detalles, setDetalles] = useState(
    orden?.detalles?.map(d => ({ productoId: d.productoId, cantidad: d.cantidad, nombre: d.producto?.nombre ?? '', sku: d.producto?.sku ?? '', stockActual: d.producto?.stockActual ?? 0 })) ?? []
  )
  const [servicioSearch, setServicioSearch] = useState('')
  const [servicios, setServicios] = useState([])
  const [servicioSel, setServicioSel] = useState(orden?.servicio ?? null)
  const [tecnicos, setTecnicos] = useState([])
  const [productoSearch, setProductoSearch] = useState('')
  const [productos, setProductos] = useState([])
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState('')
  const [alertasStock, setAlertasStock] = useState([])

  const esSinMensual = CON_DIAGNOSTICO.has(form.tipo)
  const esNueva = !orden
  const completada = orden?.estado === 'Completada'

  useEffect(() => {
    fetch(`${API}/api/empleados`).then(r => r.json()).then(j => setTecnicos(j.data ?? []))
  }, [])

  const buscarServicios = useCallback(async (q) => {
    if (!q.trim()) { setServicios([]); return }
    const r = await fetch(`${API}/api/servicios?search=${encodeURIComponent(q)}&limit=10`)
    const j = await r.json()
    setServicios(j.data ?? [])
  }, [])

  useEffect(() => {
    const t = setTimeout(() => buscarServicios(servicioSearch), 300)
    return () => clearTimeout(t)
  }, [servicioSearch, buscarServicios])

  const buscarProductos = useCallback(async (q) => {
    if (!q.trim()) { setProductos([]); return }
    const r = await fetch(`${API}/api/productos?search=${encodeURIComponent(q)}`)
    const j = await r.json()
    setProductos(j.data ?? [])
  }, [])

  useEffect(() => {
    const t = setTimeout(() => buscarProductos(productoSearch), 300)
    return () => clearTimeout(t)
  }, [productoSearch, buscarProductos])

  async function cargarPlantilla(svc) {
    setServicioSel(svc)
    setForm(f => ({ ...f, servicioId: svc.id }))
    setServicioSearch(`${svc.cliente?.razonSocial} - ${svc.plan?.nombre}`)
    setServicios([])
    if (!orden) {
      const planId = svc.planId ?? svc.plan?.id
      if (planId) {
        const r = await fetch(`${API}/api/planes/${planId}`)
        if (r.ok) {
          const p = await r.json()
          setDetalles(p.plantillaEquipos?.map(e => ({ productoId: e.productoId, cantidad: e.cantidad, nombre: e.producto?.nombre ?? '', sku: e.producto?.sku ?? '', stockActual: e.producto?.stockActual ?? 0 })) ?? [])
        }
      }
    }
  }

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function agregarProducto(p) {
    if (detalles.find(d => d.productoId === p.id)) return
    setDetalles(prev => [...prev, { productoId: p.id, cantidad: 1, nombre: p.nombre, sku: p.sku, stockActual: p.stockActual }])
    setProductoSearch(''); setProductos([])
  }
  function setCantidad(id, v) { setDetalles(prev => prev.map(d => d.productoId === id ? { ...d, cantidad: Math.max(1, parseInt(v) || 1) } : d)) }
  function quitar(id) { setDetalles(prev => prev.filter(d => d.productoId !== id)) }

  async function guardar() {
    setSaving(true); setError('')
    try {
      const body = {
        ...form,
        tecnicoId:   parseInt(form.tecnicoId),
        garantiaDias: form.garantiaDias !== '' ? parseInt(form.garantiaDias) : null,
        notas:       form.notas || null,
        diagnostico: form.diagnostico || null,
        solucion:    form.solucion || null,
        detalles:    detalles.map(({ productoId, cantidad }) => ({ productoId, cantidad })),
      }
      const url = orden ? `${API}/api/ordenes/${orden.id}` : `${API}/api/ordenes`
      const r = await fetch(url, { method: orden ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await r.json()
      if (!r.ok) { setError(json.error ?? 'Error al guardar'); return }
      onSaved(json)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  async function completar() {
    setCompleting(true); setError(''); setAlertasStock([])
    try {
      const r = await fetch(`${API}/api/ordenes/${orden.id}/completar`, { method: 'PATCH' })
      const json = await r.json()
      if (!r.ok) { setError(json.error ?? 'Error al completar'); return }
      if (json.alertasStock?.length) setAlertasStock(json.alertasStock)
      onSaved(json.orden)
    } catch { setError('Error de conexión') }
    finally { setCompleting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">
            {esNueva ? 'Nueva Orden' : `Orden #${orden.id.slice(0,8).toUpperCase()}`}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {alertasStock.length > 0 && (
            <div className="rounded-lg border border-amber-600/30 bg-amber-600/10 p-3 space-y-1">
              <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold"><AlertTriangle size={14} />Stock insuficiente — registrado igualmente</div>
              {alertasStock.map((a, i) => <p key={i} className="text-xs text-amber-400/80 pl-5">{a.nombre}: disponible {a.stockActual}, requerido {a.requerido}</p>)}
            </div>
          )}

          {/* Servicio */}
          <div>
            <label className={LABEL}>Servicio</label>
            {orden ? (
              <div className="px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700 text-sm text-slate-300">
                {orden.servicio?.cliente?.razonSocial} — {orden.servicio?.plan?.nombre}
              </div>
            ) : (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input className={INPUT + ' pl-8'} value={servicioSearch}
                  onChange={e => { setServicioSearch(e.target.value); setServicioSel(null); set('servicioId', '') }}
                  placeholder="Buscar servicio por cliente o plan..." />
                {servicios.length > 0 && !servicioSel && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 border border-slate-700 rounded-lg bg-slate-900 divide-y divide-slate-800 shadow-xl">
                    {servicios.map(s => (
                      <button key={s.id} onClick={() => cargarPlantilla(s)} className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors">
                        <span className="font-medium">{s.cliente?.razonSocial}</span>
                        <span className="text-slate-500 ml-2 text-xs">{s.plan?.nombre} · {s.estado}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tipo + Técnico */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Tipo de Orden</label>
              <select className={INPUT} value={form.tipo} onChange={e => set('tipo', e.target.value)} disabled={!esNueva}>
                <option value="Instalacion">Instalación</option>
                <option value="Retiro">Retiro</option>
                <option value="ServicioTecnico">Servicio Técnico</option>
                <option value="Mantenimiento">Mantenimiento</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Técnico Asignado</label>
              <select className={INPUT} value={form.tecnicoId} onChange={e => set('tecnicoId', e.target.value)}>
                <option value="">Seleccionar técnico...</option>
                {tecnicos.map(t => <option key={t.id} value={t.id}>{t.nombre} — {t.cargo}</option>)}
              </select>
            </div>
          </div>

          {/* Notas generales */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className={LABEL + ' mb-0'}>Notas</label>
              {!completada && <VoiceDictationButton value={form.notas} onChange={v => set('notas', v)} />}
            </div>
            <textarea rows={2} className={INPUT + ' resize-none'} value={form.notas}
              onChange={e => set('notas', e.target.value)} placeholder="Instrucciones o notas para el técnico..." disabled={completada} />
          </div>

          {/* Diagnóstico / Solución / Garantía — solo ServicioTecnico y Mantenimiento */}
          {esSinMensual && (
            <div className="space-y-3 pt-1 border-t border-slate-800">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider pt-2">Resultado Técnico</p>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className={LABEL + ' mb-0'}>Diagnóstico</label>
                  {!completada && <VoiceDictationButton value={form.diagnostico} onChange={v => set('diagnostico', v)} />}
                </div>
                <textarea rows={2} className={INPUT + ' resize-none'} value={form.diagnostico}
                  onChange={e => set('diagnostico', e.target.value)}
                  placeholder="Descripción del problema encontrado..." disabled={completada} />
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className={LABEL + ' mb-0'}>Solución Aplicada</label>
                  {!completada && <VoiceDictationButton value={form.solucion} onChange={v => set('solucion', v)} />}
                </div>
                <textarea rows={2} className={INPUT + ' resize-none'} value={form.solucion}
                  onChange={e => set('solucion', e.target.value)}
                  placeholder="Descripción de la solución implementada..." disabled={completada} />
              </div>
              <div className="flex items-center gap-3">
                <Shield size={14} className="text-slate-500 flex-shrink-0" />
                <div className="flex-1">
                  <label className={LABEL}>Garantía (días)</label>
                  <input type="number" min="0" className={INPUT} value={form.garantiaDias}
                    onChange={e => set('garantiaDias', e.target.value)} placeholder="0 = sin garantía" disabled={completada} />
                </div>
              </div>
            </div>
          )}

          {/* Equipos */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Equipos / Repuestos</p>
            {!completada && (
              <div className="relative mb-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input className={INPUT + ' pl-8'} value={productoSearch} onChange={e => setProductoSearch(e.target.value)} placeholder="Agregar producto o repuesto..." />
                {productos.length > 0 && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 border border-slate-700 rounded-lg bg-slate-900 divide-y divide-slate-800 shadow-xl">
                    {productos.map(p => (
                      <button key={p.id} onClick={() => agregarProducto(p)} className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors flex justify-between">
                        <span>{p.nombre} <span className="text-slate-600 font-mono text-xs">{p.sku}</span></span>
                        <span className="text-slate-500 text-xs">Stock: {p.stockActual}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {detalles.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4 border border-dashed border-slate-800 rounded-lg">
                {form.tipo === 'Mantenimiento' || form.tipo === 'ServicioTecnico' ? 'Sin repuestos (solo mano de obra)' : 'Sin equipos asignados'}
              </p>
            ) : (
              <div className="border border-slate-800 rounded-lg overflow-hidden divide-y divide-slate-800">
                {detalles.map(d => (
                  <div key={d.productoId} className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 truncate">{d.nombre}</p>
                      <p className="text-xs text-slate-600 font-mono">{d.sku} · Stock: {d.stockActual}</p>
                    </div>
                    {completada ? (
                      <span className="text-sm text-slate-400 w-16 text-center">{d.cantidad}</span>
                    ) : (
                      <input type="number" min="1" value={d.cantidad} onChange={ev => setCantidad(d.productoId, ev.target.value)}
                        className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 text-center focus:outline-none focus:border-blue-500" />
                    )}
                    {!completada && (
                      <button onClick={() => quitar(d.productoId)} className="text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={14} /></button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Fotos de evidencia (solo cuando la OT ya existe — necesita ID) */}
          {orden?.id && (
            <div className="pt-3 border-t border-slate-800">
              <FotosOT ordenId={orden.id} otCode={orden.id?.slice(0, 8)?.toUpperCase()} readonly={completada} />
            </div>
          )}
        </div>

        {error && <p className="px-5 pb-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-between gap-3 px-5 py-4 border-t border-slate-800">
          <div>
            {orden?.estado === 'Pendiente' && (
              <button onClick={completar} disabled={completing}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2">
                {completing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                Completar Orden
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
              {completada ? 'Cerrar' : 'Cancelar'}
            </button>
            {!completada && (
              <button onClick={guardar} disabled={saving || !form.servicioId || !form.tecnicoId}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2">
                {saving && <Loader2 size={14} className="animate-spin" />}
                {esNueva ? 'Crear Orden' : 'Guardar Cambios'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
