import { useState, useEffect, useCallback } from 'react'
import { X, Loader2, Search } from 'lucide-react'
import ImageDropzone from '@shared/components/ImageDropzone'

const API = import.meta.env.VITE_API_URL || ''
const ESTADOS = ['Pendiente','EnInstalacion','Activo','Suspendido','Cancelado']

const SIN_MENSUAL = new Set(['Reparacion','SoporteTecnico','VentaDirecta','ProyectoCCTV','CercoElectrico'])
const CON_NOTAS_TECNICAS = new Set(['Reparacion','SoporteTecnico'])

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'

export default function FormularioServicio({ servicio, onClose, onSaved }) {
  const [form, setForm] = useState({
    clienteId:            servicio?.clienteId ?? '',
    planId:               servicio?.planId ?? '',
    estado:               servicio?.estado ?? 'Pendiente',
    precioMensual:        servicio?.precioMensual ?? '',
    precioInstalacion:    servicio?.precioInstalacion ?? '',
    notasTecnicas:        servicio?.notasTecnicas ?? '',
    direccionInstalacion: servicio?.direccionInstalacion ?? '',
    latitud:              servicio?.latitud ?? '',
    longitud:             servicio?.longitud ?? '',
    // Multimedia centralizada — single source of truth para servicios puros
    // (sin productoId). PanelCatalogo lee este campo cuando renderiza el ítem.
    imagenUrl:            servicio?.imagenUrl ?? '',
  })
  const [clienteSearch, setClienteSearch] = useState(servicio?.cliente?.razonSocial ?? '')
  const [clienteSeleccionado, setClienteSeleccionado] = useState(servicio?.cliente ?? null)
  const [clientes, setClientes] = useState([])
  const [planSeleccionado, setPlanSeleccionado] = useState(servicio?.plan ?? null)
  const [planes, setPlanes] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const tipoActual = planSeleccionado?.tipo ?? ''
  const esSinMensual = SIN_MENSUAL.has(tipoActual)
  const conNotasTecnicas = CON_NOTAS_TECNICAS.has(tipoActual)

  const buscarClientes = useCallback(async (q) => {
    if (!q.trim()) { setClientes([]); return }
    const r = await fetch(`${API}/api/clientes?search=${encodeURIComponent(q)}&limit=10`)
    const json = await r.json()
    setClientes(json.data ?? [])
  }, [])

  useEffect(() => {
    const t = setTimeout(() => buscarClientes(clienteSearch), 300)
    return () => clearTimeout(t)
  }, [clienteSearch, buscarClientes])

  useEffect(() => {
    fetch(`${API}/api/planes?activo=true&limit=100`)
      .then(r => r.json())
      .then(j => setPlanes(j.data ?? []))
  }, [])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function seleccionarCliente(c) {
    setClienteSeleccionado(c)
    setForm(f => ({ ...f, clienteId: c.id }))
    setClienteSearch(c.razonSocial)
    setClientes([])
  }

  function seleccionarPlan(id) {
    const p = planes.find(pl => pl.id === id)
    setPlanSeleccionado(p ?? null)
    setForm(f => ({
      ...f,
      planId: id,
      precioMensual:     p ? p.precioMensualBase : f.precioMensual,
      precioInstalacion: p ? p.precioInstalBase  : f.precioInstalacion,
    }))
  }

  async function guardar() {
    setSaving(true); setError('')
    try {
      const body = {
        ...form,
        precioMensual:        parseFloat(form.precioMensual) || 0,
        precioInstalacion:    parseFloat(form.precioInstalacion) || 0,
        notasTecnicas:        form.notasTecnicas || null,
        direccionInstalacion: form.direccionInstalacion || null,
        latitud:              form.latitud || null,
        longitud:             form.longitud || null,
        imagenUrl:            form.imagenUrl || null,
      }
      const url = servicio ? `${API}/api/servicios/${servicio.id}` : `${API}/api/servicios`
      const method = servicio ? 'PUT' : 'POST'
      if (servicio) delete body.clienteId
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
          <h2 className="text-base font-semibold text-slate-100">{servicio ? 'Editar Servicio' : 'Nuevo Servicio'}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {/* Cliente */}
          <div>
            <label className={LABEL}>Cliente</label>
            {servicio ? (
              <div className="px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700 text-sm text-slate-300">{servicio.cliente?.razonSocial}</div>
            ) : (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input className={INPUT + ' pl-8'} value={clienteSearch}
                  onChange={e => { setClienteSearch(e.target.value); setClienteSeleccionado(null); set('clienteId', '') }}
                  placeholder="Buscar cliente..." />
                {clientes.length > 0 && !clienteSeleccionado && (
                  <div className="absolute z-10 top-full left-0 right-0 mt-1 border border-slate-700 rounded-lg bg-slate-900 divide-y divide-slate-800 shadow-xl">
                    {clientes.map(c => (
                      <button key={c.id} onClick={() => seleccionarCliente(c)} className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors">
                        <span className="font-medium">{c.razonSocial}</span>
                        <span className="text-slate-600 text-xs ml-2">{c.noCliente}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Plan + Estado */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Plan</label>
              <select className={INPUT} value={form.planId} onChange={e => seleccionarPlan(e.target.value)}>
                <option value="">Seleccionar plan...</option>
                {planes.map(p => <option key={p.id} value={p.id}>{p.nombre} ({p.tipo})</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Estado</label>
              <select className={INPUT} value={form.estado} onChange={e => set('estado', e.target.value)}>
                {ESTADOS.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </div>

          {/* Precios — precioMensual oculto si es pago único */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {!esSinMensual && (
              <div>
                <label className={LABEL}>Precio Mensual (RD$)</label>
                <input type="number" min="0" step="0.01" className={INPUT} value={form.precioMensual}
                  onChange={e => set('precioMensual', e.target.value)} placeholder="0.00" />
                {planSeleccionado && <p className="text-xs text-slate-600 mt-1">Base: RD$ {Number(planSeleccionado.precioMensualBase).toLocaleString('es-DO')}</p>}
              </div>
            )}
            <div>
              <label className={LABEL}>{esSinMensual ? 'Precio del Servicio (RD$)' : 'Precio Instalación (RD$)'}</label>
              <input type="number" min="0" step="0.01" className={INPUT} value={form.precioInstalacion}
                onChange={e => set('precioInstalacion', e.target.value)} placeholder="0.00" />
              {planSeleccionado && <p className="text-xs text-slate-600 mt-1">Base: RD$ {Number(planSeleccionado.precioInstalBase).toLocaleString('es-DO')}</p>}
            </div>
          </div>

          {/* Notas Técnicas — solo para Reparacion / SoporteTecnico */}
          {conNotasTecnicas && (
            <div>
              <label className={LABEL}>Notas Técnicas</label>
              <textarea rows={3} className={INPUT + ' resize-none'} value={form.notasTecnicas}
                onChange={e => set('notasTecnicas', e.target.value)}
                placeholder={tipoActual === 'Reparacion'
                  ? 'Ej. Serial: SN12345 · Marca: HP · Modelo: EliteBook 840 · Problema: No enciende'
                  : 'Ej. Red cliente: 192.168.10.0/24 · Switch: Ubiquiti ES-24 · PC: Dell i5 16GB'} />
            </div>
          )}

          {/* Dirección */}
          <div>
            <label className={LABEL}>Dirección de Instalación</label>
            <input className={INPUT} value={form.direccionInstalacion}
              onChange={e => set('direccionInstalacion', e.target.value)} placeholder="Dirección específica" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Latitud</label>
              <input className={INPUT} value={form.latitud} onChange={e => set('latitud', e.target.value)} placeholder="18.4861" />
            </div>
            <div>
              <label className={LABEL}>Longitud</label>
              <input className={INPUT} value={form.longitud} onChange={e => set('longitud', e.target.value)} placeholder="-69.9312" />
            </div>
          </div>

          {/* Multimedia — single source of truth. La imagen que se renderiza
              en el Catálogo de Ventas para servicios puros nace EXCLUSIVAMENTE
              aquí. Antes vivía en ItemCatalogo (mutable desde Catálogo) → drift.
              Pipeline: dropzone → /api/configuracion/empresa/upload con kind=
              servicio → Supabase bucket → URL whitelisted (esAssetUrlSegura). */}
          <div>
            <label className={LABEL}>Imagen del Servicio (vitrina comercial)</label>
            <ImageDropzone
              url={form.imagenUrl}
              onChange={u => set('imagenUrl', u)}
              kind="servicio"
              label="Imagen del servicio"
              desc="Arrastra una foto · se usa como vitrina del servicio en el Catálogo de Ventas."
              height={160}
            />
          </div>
        </div>

        {error && <p className="px-5 pb-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">Cancelar</button>
          <button onClick={guardar} disabled={saving || !form.clienteId || !form.planId}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {servicio ? 'Guardar Cambios' : 'Crear Servicio'}
          </button>
        </div>
      </div>
    </div>
  )
}
