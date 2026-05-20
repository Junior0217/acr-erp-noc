/**
 * frontend/src/features/services/OrdenesServicio.jsx
 *
 * Panel "Órdenes de Servicio Técnico" (CCTV, impresoras, servidores, PC,
 * redes corporativas, cercos eléctricos, reparaciones físicas).
 *
 * Flujo:
 *   Recibido en Taller → En Diagnóstico → Presupuestado → En Reparación
 *   → Listo para Entrega → Entregado/Facturado
 *
 * Conduce PDF: GET /api/servicios/ordenes/:id/conduce.pdf
 * Facturación: POST /api/servicios/ordenes/:id/facturar (NCF B01/B02 vía POS)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Wrench, Plus, Search, X, FileText, ChevronRight, RefreshCw, Filter,
  PackageCheck, Stethoscope, ClipboardList, Hammer, CheckCircle2, Receipt,
  AlertCircle, ArrowRight,
} from 'lucide-react'
import { apiFetch } from '@shared/utils/api'

const ESTADOS = [
  'Recibido en Taller',
  'En Diagnóstico',
  'Presupuestado',
  'En Reparación',
  'Listo para Entrega',
  'Entregado/Facturado',
]

const TRANSICIONES = {
  'Recibido en Taller':  ['En Diagnóstico'],
  'En Diagnóstico':      ['Presupuestado'],
  'Presupuestado':       ['En Reparación', 'Recibido en Taller'],
  'En Reparación':       ['Listo para Entrega'],
  'Listo para Entrega':  [], // se cierra con /facturar, no con /estado
  'Entregado/Facturado': [],
}

const TIPOS_EQUIPO = [
  'Cámara', 'NVR', 'DVR', 'Impresora', 'Servidor', 'PC', 'Laptop',
  'Switch', 'Router', 'Access Point', 'UPS', 'Cerco Eléctrico', 'Otro',
]

const ICONO_ESTADO = {
  'Recibido en Taller':  PackageCheck,
  'En Diagnóstico':      Stethoscope,
  'Presupuestado':       ClipboardList,
  'En Reparación':       Hammer,
  'Listo para Entrega':  CheckCircle2,
  'Entregado/Facturado': Receipt,
}

const COLOR_ESTADO = {
  'Recibido en Taller':  'bg-blue-600/20 text-blue-300 border-blue-600/40',
  'En Diagnóstico':      'bg-violet-600/20 text-violet-300 border-violet-600/40',
  'Presupuestado':       'bg-amber-600/20 text-amber-300 border-amber-600/40',
  'En Reparación':       'bg-orange-600/20 text-orange-300 border-orange-600/40',
  'Listo para Entrega':  'bg-emerald-600/20 text-emerald-300 border-emerald-600/40',
  'Entregado/Facturado': 'bg-slate-600/30 text-slate-300 border-slate-600/50',
}

function fmtFecha(d) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('es-DO', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return '—' }
}

function fmtMoneda(n) {
  const x = Number(n || 0)
  return `RD$ ${x.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente raíz
// ─────────────────────────────────────────────────────────────────────────────
export default function OrdenesServicio() {
  const [ordenes, setOrdenes]   = useState([])
  const [total, setTotal]       = useState(0)
  const [cargando, setCargando] = useState(false)
  const [filtros, setFiltros]   = useState({ estado: '', tipoEquipo: '', search: '' })
  const [pagina, setPagina]     = useState(0)
  const LIMIT = 25

  const [modalNueva, setModalNueva]   = useState(false)
  const [detalleId, setDetalleId]     = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const params = new URLSearchParams()
      params.set('limit',  String(LIMIT))
      params.set('offset', String(pagina * LIMIT))
      if (filtros.estado)     params.set('estado',     filtros.estado)
      if (filtros.tipoEquipo) params.set('tipoEquipo', filtros.tipoEquipo)
      if (filtros.search)     params.set('search',     filtros.search)
      const res = await apiFetch(`/api/servicios/ordenes?${params.toString()}`)
      if (!res.ok) throw new Error('Error cargando órdenes')
      const data = await res.json()
      setOrdenes(data.items || [])
      setTotal(data.total || 0)
    } catch (err) {
      toast.error(err.message || 'Error cargando órdenes de servicio.')
    } finally {
      setCargando(false)
    }
  }, [filtros, pagina])

  useEffect(() => { cargar() }, [cargar])

  const paginas = Math.max(1, Math.ceil(total / LIMIT))

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 sm:p-6">
      {/* ─── Header ───────────────────────────────────────────────────── */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-600/40 flex items-center justify-center">
            <Wrench className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Órdenes de Servicio Técnico</h1>
            <p className="text-xs text-slate-400 font-mono">CCTV · Impresoras · Servidores · PC · Redes · Cercos</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => cargar()}
            className="p-2 rounded-lg border border-slate-700 hover:bg-slate-800 transition"
            title="Refrescar"
          >
            <RefreshCw className={`w-4 h-4 ${cargando ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setModalNueva(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition shadow shadow-blue-900/30"
          >
            <Plus className="w-4 h-4" />
            Nueva Orden
          </button>
        </div>
      </header>

      {/* ─── Filtros ────────────────────────────────────────────────────── */}
      <section className="bg-slate-800/40 border border-slate-700 rounded-xl p-3 sm:p-4 mb-4">
        <div className="flex items-center gap-2 mb-3 text-slate-400 text-xs uppercase tracking-wider">
          <Filter className="w-3.5 h-3.5" /> Filtros
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Buscar OST / cliente / notas..."
              value={filtros.search}
              onChange={(e) => { setPagina(0); setFiltros((f) => ({ ...f, search: e.target.value })) }}
              className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <select
            value={filtros.estado}
            onChange={(e) => { setPagina(0); setFiltros((f) => ({ ...f, estado: e.target.value })) }}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="">Todos los estados</option>
            {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={filtros.tipoEquipo}
            onChange={(e) => { setPagina(0); setFiltros((f) => ({ ...f, tipoEquipo: e.target.value })) }}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="">Todo tipo de equipo</option>
            {TIPOS_EQUIPO.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button
            onClick={() => { setFiltros({ estado: '', tipoEquipo: '', search: '' }); setPagina(0) }}
            className="px-3 py-2 border border-slate-700 hover:bg-slate-800 rounded-md text-sm transition"
          >
            Limpiar
          </button>
        </div>
      </section>

      {/* ─── Tabla ───────────────────────────────────────────────────────── */}
      <section className="bg-slate-800/40 border border-slate-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2.5">OST</th>
                <th className="text-left px-3 py-2.5">Cliente</th>
                <th className="text-left px-3 py-2.5">Equipo</th>
                <th className="text-left px-3 py-2.5">Estado</th>
                <th className="text-left px-3 py-2.5 hidden md:table-cell">Recibido</th>
                <th className="text-right px-3 py-2.5">Presup.</th>
                <th className="text-right px-3 py-2.5 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {cargando && ordenes.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Cargando…</td></tr>
              )}
              {!cargando && ordenes.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Sin órdenes con esos filtros.</td></tr>
              )}
              {ordenes.map((o) => {
                const IconEstado = ICONO_ESTADO[o.estado] || AlertCircle
                return (
                  <tr key={o.id} className="border-t border-slate-700/70 hover:bg-slate-700/20 cursor-pointer" onClick={() => setDetalleId(o.id)}>
                    <td className="px-3 py-2.5 font-mono text-xs text-blue-300">{o.noOT || o.id.slice(0, 8)}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{o.cliente?.razonSocial || '—'}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{o.cliente?.noCliente || ''}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-slate-200">{o.tipoEquipo || '—'}</div>
                      <div className="text-[10px] text-slate-500">{[o.marca, o.modelo].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${COLOR_ESTADO[o.estado] || ''}`}>
                        <IconEstado className="w-3 h-3" />
                        {o.estado}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell text-slate-400 text-xs">{fmtFecha(o.createdAt)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">{o.presupuestoMonto != null ? fmtMoneda(o.presupuestoMonto) : '—'}</td>
                    <td className="px-3 py-2.5 text-right text-slate-500"><ChevronRight className="w-4 h-4 inline" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-700 text-xs text-slate-400">
          <div>Mostrando {ordenes.length} de {total} órdenes</div>
          <div className="flex items-center gap-1.5">
            <button
              disabled={pagina === 0}
              onClick={() => setPagina((p) => Math.max(0, p - 1))}
              className="px-2 py-1 border border-slate-700 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed rounded"
            >Anterior</button>
            <span className="font-mono">{pagina + 1} / {paginas}</span>
            <button
              disabled={pagina + 1 >= paginas}
              onClick={() => setPagina((p) => p + 1)}
              className="px-2 py-1 border border-slate-700 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed rounded"
            >Siguiente</button>
          </div>
        </div>
      </section>

      {modalNueva && (
        <ModalNuevaOrden
          onCerrar={() => setModalNueva(false)}
          onCreada={() => { setModalNueva(false); setPagina(0); cargar() }}
        />
      )}

      {detalleId && (
        <DrawerDetalle
          ordenId={detalleId}
          onCerrar={() => setDetalleId(null)}
          onCambio={() => cargar()}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal: Nueva Orden
// ─────────────────────────────────────────────────────────────────────────────
function ModalNuevaOrden({ onCerrar, onCreada }) {
  const [form, setForm] = useState({
    clienteId: '', tipoEquipo: 'PC', marca: '', modelo: '', serial: '',
    diagnosticoInicial: '', notas: '',
  })
  const [clientes, setClientes]     = useState([])
  const [buscaCli, setBuscaCli]     = useState('')
  const [guardando, setGuardando]   = useState(false)

  useEffect(() => {
    let cancel = false
    const t = setTimeout(async () => {
      if (!buscaCli || buscaCli.length < 2) { setClientes([]); return }
      try {
        const res = await apiFetch(`/api/clientes?search=${encodeURIComponent(buscaCli)}&limit=10`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancel) setClientes(data.items || data.clientes || data || [])
      } catch { /* silencio */ }
    }, 250)
    return () => { cancel = true; clearTimeout(t) }
  }, [buscaCli])

  async function guardar(e) {
    e.preventDefault()
    if (!form.clienteId)          return toast.error('Selecciona un cliente.')
    if (!form.diagnosticoInicial) return toast.error('Captura el diagnóstico inicial del cliente.')
    setGuardando(true)
    try {
      const res = await apiFetch('/api/servicios/ordenes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          clienteId:          form.clienteId,
          tipoEquipo:         form.tipoEquipo,
          marca:              form.marca || null,
          modelo:             form.modelo || null,
          serial:             form.serial || null,
          diagnosticoInicial: form.diagnosticoInicial,
          notas:              form.notas || null,
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.mensaje || 'Error creando orden.')
      }
      const creada = await res.json()
      toast.success(`Orden ${creada.noOT} creada.`)
      onCreada()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <form onSubmit={guardar} className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto shadow-2xl">
        <header className="sticky top-0 bg-slate-900 border-b border-slate-700 px-5 py-3 flex items-center justify-between z-10">
          <h2 className="font-semibold flex items-center gap-2"><Plus className="w-4 h-4 text-blue-400" /> Nueva orden de servicio técnico</h2>
          <button type="button" onClick={onCerrar} className="p-1 hover:bg-slate-800 rounded"><X className="w-4 h-4" /></button>
        </header>

        <div className="p-5 space-y-4">
          {/* Cliente */}
          <div>
            <label className="text-xs uppercase text-slate-400 tracking-wider">Cliente *</label>
            <div className="relative">
              <input
                type="text"
                placeholder="Busca por nombre, código o RNC..."
                value={buscaCli}
                onChange={(e) => setBuscaCli(e.target.value)}
                className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
              />
              {clientes.length > 0 && (
                <ul className="absolute z-20 mt-1 w-full bg-slate-800 border border-slate-700 rounded shadow-xl max-h-48 overflow-y-auto">
                  {clientes.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => { setForm((f) => ({ ...f, clienteId: c.id })); setBuscaCli(`${c.razonSocial} (${c.noCliente})`); setClientes([]) }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-700 text-sm"
                      >
                        <div>{c.razonSocial}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{c.noCliente}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {form.clienteId && <p className="text-[11px] text-emerald-400 mt-1">✓ Cliente seleccionado</p>}
          </div>

          {/* Tipo de equipo */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase text-slate-400 tracking-wider">Tipo de equipo *</label>
              <select
                value={form.tipoEquipo}
                onChange={(e) => setForm((f) => ({ ...f, tipoEquipo: e.target.value }))}
                className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
              >
                {TIPOS_EQUIPO.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase text-slate-400 tracking-wider">Marca</label>
              <input
                type="text"
                value={form.marca}
                onChange={(e) => setForm((f) => ({ ...f, marca: e.target.value }))}
                className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-400 tracking-wider">Modelo</label>
              <input
                type="text"
                value={form.modelo}
                onChange={(e) => setForm((f) => ({ ...f, modelo: e.target.value }))}
                className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-400 tracking-wider">Serial / S/N</label>
              <input
                type="text"
                value={form.serial}
                onChange={(e) => setForm((f) => ({ ...f, serial: e.target.value }))}
                className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Diagnóstico del cliente */}
          <div>
            <label className="text-xs uppercase text-slate-400 tracking-wider">Diagnóstico inicial del cliente *</label>
            <textarea
              rows={3}
              value={form.diagnosticoInicial}
              onChange={(e) => setForm((f) => ({ ...f, diagnosticoInicial: e.target.value }))}
              placeholder="¿Qué dice el cliente que pasa con el equipo?"
              className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Notas */}
          <div>
            <label className="text-xs uppercase text-slate-400 tracking-wider">Notas internas</label>
            <textarea
              rows={2}
              value={form.notas}
              onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))}
              className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <footer className="sticky bottom-0 bg-slate-900 border-t border-slate-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onCerrar} className="px-4 py-2 text-sm border border-slate-700 hover:bg-slate-800 rounded">Cancelar</button>
          <button type="submit" disabled={guardando} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium">
            {guardando ? 'Guardando...' : 'Crear orden'}
          </button>
        </footer>
      </form>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawer: Detalle de orden + transiciones + facturar + PDF
// ─────────────────────────────────────────────────────────────────────────────
function DrawerDetalle({ ordenId, onCerrar, onCambio }) {
  const [orden, setOrden]       = useState(null)
  const [cargando, setCargando] = useState(true)
  const [trabajando, setTrabajando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const res = await apiFetch(`/api/servicios/ordenes/${ordenId}`)
      if (!res.ok) throw new Error('No se pudo cargar la orden.')
      setOrden(await res.json())
    } catch (err) { toast.error(err.message) }
    finally { setCargando(false) }
  }, [ordenId])

  useEffect(() => { cargar() }, [cargar])

  const transicionesPosibles = useMemo(() => orden ? TRANSICIONES[orden.estado] || [] : [], [orden])

  async function transicionar(nuevoEstado, extras = {}) {
    setTrabajando(true)
    try {
      const res = await apiFetch(`/api/servicios/ordenes/${ordenId}/estado`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ estado: nuevoEstado, ...extras }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.mensaje || 'Error en transición.')
      }
      toast.success(`Estado: ${nuevoEstado}`)
      await cargar()
      onCambio()
    } catch (err) { toast.error(err.message) }
    finally { setTrabajando(false) }
  }

  async function guardarCampos(extras) {
    setTrabajando(true)
    try {
      const res = await apiFetch(`/api/servicios/ordenes/${ordenId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(extras),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.mensaje || 'Error guardando cambios.')
      }
      toast.success('Cambios guardados.')
      await cargar()
      onCambio()
    } catch (err) { toast.error(err.message) }
    finally { setTrabajando(false) }
  }

  async function facturar() {
    if (!confirm('¿Confirmas facturación y entrega? Esto emite NCF (B01/B02 según cliente) y cierra la orden.')) return
    setTrabajando(true)
    try {
      const res = await apiFetch(`/api/servicios/ordenes/${ordenId}/facturar`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ metodoPago: 'Efectivo', diasVence: 0 }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.mensaje || 'Error facturando orden.')
      }
      const data = await res.json()
      toast.success(`Facturada ${data.factura?.noFactura || ''} (NCF ${data.factura?.ncf || '—'}).`)
      await cargar()
      onCambio()
    } catch (err) { toast.error(err.message) }
    finally { setTrabajando(false) }
  }

  function descargarConduce() {
    const url = `/api/servicios/ordenes/${ordenId}/conduce.pdf`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  if (cargando) return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onCerrar}>
      <div className="text-slate-300">Cargando orden...</div>
    </div>
  )
  if (!orden) return null

  const Icono = ICONO_ESTADO[orden.estado] || AlertCircle

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onCerrar} />
      <aside className="w-full max-w-2xl bg-slate-900 border-l border-slate-700 overflow-y-auto shadow-2xl">
        <header className="sticky top-0 bg-slate-900 border-b border-slate-700 px-5 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <Wrench className="w-5 h-5 text-blue-400" />
            <div>
              <div className="font-mono text-sm text-blue-300">{orden.noOT}</div>
              <div className="text-[11px] text-slate-500">{orden.cliente?.razonSocial}</div>
            </div>
          </div>
          <button onClick={onCerrar} className="p-1.5 hover:bg-slate-800 rounded"><X className="w-4 h-4" /></button>
        </header>

        <div className="p-5 space-y-5">
          {/* Estado */}
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium ${COLOR_ESTADO[orden.estado]}`}>
              <Icono className="w-3.5 h-3.5" />
              {orden.estado}
            </span>
            <span className="text-xs text-slate-500">Creada {fmtFecha(orden.createdAt)}</span>
          </div>

          {/* Equipo */}
          <section className="bg-slate-800/40 border border-slate-700 rounded-lg p-3 text-sm">
            <h3 className="text-xs uppercase text-slate-400 tracking-wider mb-2">Equipo</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div><span className="text-slate-500">Tipo:</span> <span className="text-slate-200">{orden.tipoEquipo}</span></div>
              <div><span className="text-slate-500">Marca:</span> <span className="text-slate-200">{orden.marca || '—'}</span></div>
              <div><span className="text-slate-500">Modelo:</span> <span className="text-slate-200">{orden.modelo || '—'}</span></div>
              <div><span className="text-slate-500">Serial:</span> <span className="text-slate-200 font-mono">{orden.serial || '—'}</span></div>
            </div>
          </section>

          {/* Diagnóstico cliente */}
          <section>
            <h3 className="text-xs uppercase text-slate-400 tracking-wider mb-2">Diagnóstico inicial del cliente</h3>
            <p className="text-sm bg-slate-800/40 border border-slate-700 rounded p-3 whitespace-pre-wrap">{orden.diagnosticoInicial || '—'}</p>
          </section>

          {/* Editor de campos técnicos */}
          <EditorCamposTecnicos orden={orden} onGuardar={guardarCampos} disabled={trabajando || orden.estado === 'Entregado/Facturado'} />

          {/* Acciones */}
          <section className="space-y-2 border-t border-slate-700 pt-4">
            <h3 className="text-xs uppercase text-slate-400 tracking-wider mb-2">Acciones</h3>
            <div className="flex flex-wrap gap-2">
              <button onClick={descargarConduce} className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-sm">
                <FileText className="w-4 h-4" /> Conduce / Recibo PDF
              </button>
              {transicionesPosibles.map((e) => (
                <button
                  key={e}
                  onClick={() => transicionar(e)}
                  disabled={trabajando}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
                >
                  <ArrowRight className="w-4 h-4" /> {e}
                </button>
              ))}
              {orden.estado === 'Listo para Entrega' && !orden.estaFacturada && (
                <button
                  onClick={facturar}
                  disabled={trabajando}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-sm font-medium"
                >
                  <Receipt className="w-4 h-4" /> Facturar y Entregar (NCF B01/B02)
                </button>
              )}
            </div>
            {orden.estado === 'Entregado/Facturado' && (
              <p className="text-[11px] text-emerald-400 mt-2">✓ Orden cerrada y facturada. Inmutable.</p>
            )}
          </section>

          {/* Facturas linkadas */}
          {orden.facturas && orden.facturas.length > 0 && (
            <section className="border-t border-slate-700 pt-4">
              <h3 className="text-xs uppercase text-slate-400 tracking-wider mb-2">Facturas emitidas</h3>
              <ul className="space-y-1.5 text-sm">
                {orden.facturas.map((f) => (
                  <li key={f.id} className="flex items-center justify-between bg-slate-800/40 border border-slate-700 rounded px-3 py-2">
                    <div>
                      <span className="font-mono text-blue-300">{f.noFactura}</span>
                      <span className="text-slate-500 text-xs ml-2">NCF {f.ncf || '—'}</span>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-xs">{fmtMoneda(f.total)}</div>
                      <div className="text-[10px] text-slate-500">{f.estado}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componente: editor de reporte técnico, presupuesto y piezas
// ─────────────────────────────────────────────────────────────────────────────
function EditorCamposTecnicos({ orden, onGuardar, disabled }) {
  const [reporte, setReporte]       = useState(orden.reporteTecnicoFinal || '')
  const [presupuesto, setPresup]    = useState(orden.presupuestoMonto != null ? String(orden.presupuestoMonto) : '')
  const [piezas, setPiezas]         = useState(orden.piezasUtilizadas || [])

  function addPieza() {
    setPiezas((p) => [...p, { descripcion: '', cantidad: 1, precioUnitario: 0 }])
  }
  function delPieza(i) {
    setPiezas((p) => p.filter((_, ix) => ix !== i))
  }
  function setPieza(i, campo, val) {
    setPiezas((p) => p.map((it, ix) => ix === i ? { ...it, [campo]: val } : it))
  }

  function guardar() {
    onGuardar({
      reporteTecnicoFinal: reporte || null,
      presupuestoMonto:    presupuesto === '' ? null : Number(presupuesto),
      piezasUtilizadas:    piezas
        .filter((p) => p.descripcion && p.descripcion.trim().length > 0)
        .map((p) => ({
          descripcion:    p.descripcion.trim(),
          cantidad:       Math.max(1, Number(p.cantidad || 1)),
          precioUnitario: Math.max(0, Number(p.precioUnitario || 0)),
          productoId:     p.productoId ?? null,
        })),
    })
  }

  const total = piezas.reduce((acc, p) => acc + (Number(p.cantidad || 0) * Number(p.precioUnitario || 0)), 0)
  const grandTotal = Number(presupuesto || 0) + total

  return (
    <section className="space-y-3 border-t border-slate-700 pt-4">
      <h3 className="text-xs uppercase text-slate-400 tracking-wider">Reporte técnico, presupuesto y piezas</h3>

      <div>
        <label className="text-[11px] text-slate-500">Reporte técnico final</label>
        <textarea
          rows={3}
          value={reporte}
          disabled={disabled}
          onChange={(e) => setReporte(e.target.value)}
          placeholder="Qué se encontró, qué se reparó/configuró, garantía aplicada..."
          className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500 disabled:opacity-60"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
        <div className="sm:col-span-1">
          <label className="text-[11px] text-slate-500">Presupuesto servicio (RD$)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={presupuesto}
            disabled={disabled}
            onChange={(e) => setPresup(e.target.value)}
            className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm focus:outline-none focus:border-blue-500 disabled:opacity-60"
          />
        </div>
        <div className="sm:col-span-2 text-right">
          <div className="text-[11px] text-slate-500">Total estimado (servicio + piezas, sin ITBIS)</div>
          <div className="text-lg font-bold text-blue-300 font-mono">{fmtMoneda(grandTotal)}</div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-slate-500">Piezas / repuestos utilizados</span>
          <button type="button" onClick={addPieza} disabled={disabled} className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50">+ Agregar</button>
        </div>
        <div className="space-y-1.5">
          {piezas.length === 0 && <p className="text-[11px] text-slate-600 italic">— Sin piezas registradas —</p>}
          {piezas.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder="Descripción"
                value={p.descripcion}
                disabled={disabled}
                onChange={(e) => setPieza(i, 'descripcion', e.target.value)}
                className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs disabled:opacity-60"
              />
              <input
                type="number" min={1} step={1} placeholder="Cant"
                value={p.cantidad}
                disabled={disabled}
                onChange={(e) => setPieza(i, 'cantidad', e.target.value)}
                className="w-16 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs text-right disabled:opacity-60"
              />
              <input
                type="number" min={0} step="0.01" placeholder="Precio"
                value={p.precioUnitario}
                disabled={disabled}
                onChange={(e) => setPieza(i, 'precioUnitario', e.target.value)}
                className="w-24 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs text-right disabled:opacity-60"
              />
              <button type="button" onClick={() => delPieza(i)} disabled={disabled} className="p-1.5 text-slate-500 hover:text-red-400 disabled:opacity-50">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={guardar}
          disabled={disabled}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          Guardar cambios técnicos
        </button>
      </div>
    </section>
  )
}
