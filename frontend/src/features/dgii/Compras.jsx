/**
 * frontend/src/features/dgii/Compras.jsx
 *
 * CRUD de Compras a Suplidores — feed del reporte DGII 606.
 *
 * Cyber Neo:
 *   - Vista bloqueada sin permiso dgii:reportar.
 *   - Inputs numéricos type=number con min=0 — DOM rechaza texto/símbolos.
 *   - NCF input fuerza regex /^[BE]\d{10}$/ con uppercase auto.
 *   - DELETE solo lo permite el backend con TOTP + Owner; el botón en UI
 *     muestra confirm + manda DELETE — backend rechaza 403 si no cumple.
 *   - Suplidor autocomplete: debounced + cap 50 resultados.
 *
 * Flujo:
 *   1) Tabla lista compras del periodo (filtrable por suplidor y fecha).
 *   2) Botón "Registrar Compra" abre drawer derecho con formulario.
 *   3) Form valida en cliente y manda POST/PUT a /api/dgii/compras.
 *   4) Backend re-valida con Zod + chequea dígito verificador RNC del suplidor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShoppingCart, Plus, Search, Edit2, Trash2, X, Loader2, Calendar,
  ShieldOff, FileText, ChevronLeft, ChevronRight, AlertTriangle,
  CheckCircle2, Building2, RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@shared/contexts/AuthContext'
import { apiFetch } from '@shared/utils/api'

// ─── Catálogos DGII ──────────────────────────────────────────────────────────
const TIPO_BIEN_SERVICIO = [
  { v: '01', label: '01 — Gastos de Personal' },
  { v: '02', label: '02 — Gastos por Trabajos, Suministros y Servicios' },
  { v: '03', label: '03 — Arrendamientos' },
  { v: '04', label: '04 — Gastos de Activos Fijos' },
  { v: '05', label: '05 — Gastos de Representación' },
  { v: '06', label: '06 — Gastos Financieros' },
  { v: '07', label: '07 — Gastos de Seguros' },
  { v: '08', label: '08 — Gastos por Combustibles' },
  { v: '09', label: '09 — Gastos de Reparación y Mantenimiento' },
  { v: '10', label: '10 — Adquisiciones de Activos' },
  { v: '11', label: '11 — Gastos de Mercadeo, Publicidad e Investigación' },
]

const FORMA_PAGO = [
  { v: '01', label: '01 — Efectivo' },
  { v: '02', label: '02 — Cheque / Transferencia / Depósito' },
  { v: '03', label: '03 — Tarjeta Crédito / Débito' },
  { v: '04', label: '04 — Compra a Crédito' },
  { v: '05', label: '05 — Permuta' },
  { v: '06', label: '06 — Nota de Crédito (uso interno)' },
  { v: '07', label: '07 — Mixto' },
]

const TIPO_RETENCION_ISR = [
  { v: '',   label: '— Sin retención ISR —' },
  { v: '01', label: '01 — Alquileres' },
  { v: '02', label: '02 — Honorarios por Servicios' },
  { v: '03', label: '03 — Otras Rentas' },
  { v: '04', label: '04 — Otras Rentas (Régimen Especial)' },
  { v: '05', label: '05 — Dividendos' },
  { v: '06', label: '06 — Intereses Pagados a Personas Jurídicas' },
  { v: '07', label: '07 — Intereses Pagados a Personas Físicas' },
]

const EMPTY_FORM = {
  esGastoInformal: false,
  suplidorId: '',
  ncfProveedor: '',
  ncfModificado: '',
  tipoBienServicio: '02',
  fechaComprobante: '',
  fechaPago: '',
  formaPago: '02',
  montoServicios: 0,
  montoBienes: 0,
  itbisFacturado: 0,
  itbisRetenido: 0,
  itbisProporcionalidad: 0,
  itbisLlevadoCosto: 0,
  itbisPorAdelantar: 0,
  itbisPercibido: 0,
  tipoRetencionIsr: '',
  montoRetencionRenta: 0,
  isrPercibido: 0,
  impuestoSelectivoConsumo: 0,
  otrosImpuestos: 0,
  propinaLegal: 0,
  notas: '',
}

const LIMIT = 25

function formatMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '0.00'
  return new Intl.NumberFormat('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n))
}

function formatFechaCorta(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-DO', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function toDateInput(iso) {
  if (!iso) return ''
  return new Date(iso).toISOString().slice(0, 10)
}

// ─── Suplidor autocomplete ──────────────────────────────────────────────────
function SuplidorPicker({ value, onChange, error }) {
  const [search, setSearch]   = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen]       = useState(false)
  const [selected, setSelected] = useState(null)

  // Si value cambia desde fuera (edición), trae el suplidor.
  useEffect(() => {
    if (!value) { setSelected(null); return }
    if (selected?.id === value) return
    apiFetch(`/api/crm/suplidores?limit=50`)
      .then(r => r.json())
      .then(j => {
        const found = (j.data ?? []).find(s => s.id === value)
        if (found) setSelected(found)
      })
      .catch(() => {})
  }, [value]) // eslint-disable-line

  // Debounced search
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ limit: 30, page: 1 })
        if (search) params.set('search', search)
        const r = await apiFetch(`/api/crm/suplidores?${params}`)
        const j = await r.json().catch(() => ({}))
        setResults(Array.isArray(j.data) ? j.data : [])
      } catch { setResults([]) }
      finally  { setLoading(false) }
    }, 250)
    return () => clearTimeout(t)
  }, [search, open])

  function pick(s) {
    setSelected(s)
    onChange(s.id)
    setOpen(false)
    setSearch('')
  }

  return (
    <div className="relative">
      {selected ? (
        <div className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2">
          <Building2 size={14} className="text-emerald-400" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-100 truncate">{selected.razonSocial}</p>
            <p className="text-[10px] text-slate-500 font-mono">
              {selected.rnc || selected.cedula || 'sin identificación fiscal'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setSelected(null); onChange(''); setOpen(true) }}
            className="text-slate-400 hover:text-slate-200"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Buscar suplidor por nombre o RNC…"
              value={search}
              onFocus={() => setOpen(true)}
              onChange={e => { setSearch(e.target.value); setOpen(true) }}
              className={`w-full bg-slate-800 border ${error ? 'border-red-700' : 'border-slate-700'} rounded-lg pl-9 pr-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none`}
            />
          </div>
          {open && (
            <div className="absolute z-10 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl">
              {loading && (
                <div className="p-3 text-center text-slate-500 text-xs">
                  <Loader2 size={14} className="animate-spin inline mr-2" />Buscando…
                </div>
              )}
              {!loading && results.length === 0 && (
                <div className="p-3 text-center text-slate-500 text-xs italic">
                  Sin suplidores. Créalos en CRM → Suplidores.
                </div>
              )}
              {!loading && results.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pick(s)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-800 border-b border-slate-800/40 last:border-0"
                >
                  <p className="text-sm text-slate-200 truncate">{s.razonSocial}</p>
                  <p className="text-[10px] text-slate-500 font-mono">
                    {s.rnc || s.cedula || 'sin id'}
                    {s.activo === false && <span className="ml-2 text-amber-400">[inactivo]</span>}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

// ─── Drawer Formulario ──────────────────────────────────────────────────────
function FormularioCompra({ open, onClose, onSaved, initial }) {
  const isEdit = !!initial?.id
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState({})

  useEffect(() => {
    if (!open) return
    if (initial) {
      setForm({
        ...EMPTY_FORM,
        ...initial,
        fechaComprobante: toDateInput(initial.fechaComprobante),
        fechaPago:        toDateInput(initial.fechaPago),
        tipoRetencionIsr: initial.tipoRetencionIsr ?? '',
        ncfModificado:    initial.ncfModificado ?? '',
        notas:            initial.notas ?? '',
        suplidorId:       initial.suplidorId ?? initial.suplidor?.id ?? '',
      })
    } else {
      setForm({ ...EMPTY_FORM, fechaComprobante: new Date().toISOString().slice(0, 10) })
    }
    setErrors({})
  }, [open, initial])

  // Totales derivados (read-only).
  const totalMonto = useMemo(() => {
    return Number(form.montoServicios || 0) + Number(form.montoBienes || 0)
  }, [form.montoServicios, form.montoBienes])

  function setField(k, v) {
    setForm(f => ({ ...f, [k]: v }))
    setErrors(e => ({ ...e, [k]: undefined }))
  }

  function setNumField(k, v) {
    // DOM type=number ya filtra basura; validamos no-negativos.
    const n = v === '' ? 0 : Number(v)
    if (Number.isNaN(n) || n < 0) return
    setField(k, n)
  }

  function validar() {
    const e = {}
    // Modo fiscal exige suplidor + NCF. Modo informal los hace opcionales
    // (mismo mirror de la regla del backend: esGastoInformal=true ⇒ libres).
    if (!form.esGastoInformal) {
      if (!form.suplidorId) e.suplidorId = 'Selecciona un suplidor.'
      if (!/^[BE]\d{10}$/.test(String(form.ncfProveedor ?? '').toUpperCase())) {
        e.ncfProveedor = 'NCF debe ser B/E + 10 dígitos.'
      }
    }
    if (form.ncfModificado && !/^[BE]\d{10}$/.test(String(form.ncfModificado).toUpperCase())) {
      e.ncfModificado = 'NCF Modificado inválido.'
    }
    if (!form.fechaComprobante) e.fechaComprobante = 'Fecha del comprobante es obligatoria.'
    if (!form.tipoBienServicio) e.tipoBienServicio = 'Selecciona tipo de bien/servicio.'
    if (!form.formaPago)        e.formaPago = 'Selecciona forma de pago.'
    if (totalMonto <= 0)        e.montoServicios = 'Ingresa al menos un monto en servicios o bienes.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function guardar() {
    if (!validar()) return
    setBusy(true)
    try {
      const url = isEdit
        ? `/api/dgii/compras/${initial.id}`
        : `/api/dgii/compras`
      const payload = {
        ...form,
        // Si es informal, el backend ignora suplidorId/NCF — lo enviamos null
        // explícitamente para evitar persistir basura cuando el toggle se
        // activó después de tipear algo en esos campos.
        suplidorId:       form.esGastoInformal ? null : form.suplidorId,
        ncfProveedor:     form.esGastoInformal ? null : (form.ncfProveedor || '').toUpperCase(),
        ncfModificado:    form.esGastoInformal ? null : (form.ncfModificado ? form.ncfModificado.toUpperCase() : null),
        fechaPago:        form.fechaPago || null,
        tipoRetencionIsr: form.tipoRetencionIsr || null,
      }
      const r = await apiFetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        toast.error(j.error || 'Error al guardar la compra.')
        return
      }
      toast.success(isEdit ? 'Compra actualizada.' : `Compra registrada: ${j.noCompra}`)
      onSaved()
    } catch {
      toast.error('Error de red.')
    } finally { setBusy(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-950 border-l border-slate-800 w-full max-w-2xl overflow-y-auto shadow-2xl">
        <div className="sticky top-0 z-10 bg-slate-950 px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <ShoppingCart size={18} className="text-emerald-400" />
          <h2 className="text-base font-bold text-slate-100">
            {isEdit ? `Editar Compra ${initial.noCompra}` : 'Registrar Compra a Suplidor'}
          </h2>
          <button onClick={onClose} disabled={busy} className="ml-auto text-slate-400 hover:text-slate-200 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Toggle Gasto Informal */}
          <div className={`border rounded-lg p-3 flex items-start gap-3 ${form.esGastoInformal ? 'border-amber-700/50 bg-amber-900/15' : 'border-slate-700 bg-slate-900/40'}`}>
            <input
              id="gasto-informal"
              type="checkbox"
              checked={!!form.esGastoInformal}
              onChange={e => setField('esGastoInformal', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-amber-500 cursor-pointer"
            />
            <label htmlFor="gasto-informal" className="cursor-pointer flex-1">
              <p className="text-sm font-semibold text-slate-100">
                {form.esGastoInformal ? '🛑 Gasto Informal (NO se reporta a DGII)' : 'Gasto Informal (sin NCF)'}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                Marca esto para gastos sin comprobante fiscal (caja chica, propinas,
                viáticos, gastos cash). El reporte <strong>606 excluye</strong> estos
                registros — solo entran al flujo de caja interno.
              </p>
            </label>
          </div>

          {/* Sección 1: Identificación fiscal */}
          <section className={`space-y-3 ${form.esGastoInformal ? 'opacity-50 pointer-events-none' : ''}`}>
            <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              Identificación del Comprobante {form.esGastoInformal && <span className="text-amber-400">(deshabilitado · gasto informal)</span>}
            </h3>
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Suplidor {form.esGastoInformal ? '(opcional)' : '*'}</label>
              <SuplidorPicker
                value={form.suplidorId}
                onChange={v => setField('suplidorId', v)}
                error={errors.suplidorId}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FieldText
                label={`NCF del Proveedor ${form.esGastoInformal ? '(opcional)' : '*'}`}
                value={form.ncfProveedor}
                onChange={v => setField('ncfProveedor', v.toUpperCase().replace(/[^BE0-9]/g, '').slice(0, 11))}
                placeholder="B0100000001"
                error={errors.ncfProveedor}
                mono uppercase
              />
              <FieldText
                label="NCF Modificado (solo ND/NC del proveedor)"
                value={form.ncfModificado}
                onChange={v => setField('ncfModificado', v.toUpperCase().replace(/[^BE0-9]/g, '').slice(0, 11))}
                placeholder="(opcional)"
                error={errors.ncfModificado}
                mono uppercase
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <FieldDate
                label="Fecha del Comprobante *"
                value={form.fechaComprobante}
                onChange={v => setField('fechaComprobante', v)}
                error={errors.fechaComprobante}
              />
              <FieldDate
                label="Fecha de Pago"
                value={form.fechaPago}
                onChange={v => setField('fechaPago', v)}
              />
              <FieldSelect
                label="Forma de Pago *"
                value={form.formaPago}
                onChange={v => setField('formaPago', v)}
                options={FORMA_PAGO}
                error={errors.formaPago}
              />
            </div>
            <FieldSelect
              label="Tipo de Bien/Servicio *"
              value={form.tipoBienServicio}
              onChange={v => setField('tipoBienServicio', v)}
              options={TIPO_BIEN_SERVICIO}
              error={errors.tipoBienServicio}
            />
          </section>

          {/* Sección 2: Montos */}
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Montos Facturados</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FieldMoney
                label="Monto Servicios"
                value={form.montoServicios}
                onChange={v => setNumField('montoServicios', v)}
                error={errors.montoServicios}
              />
              <FieldMoney
                label="Monto Bienes"
                value={form.montoBienes}
                onChange={v => setNumField('montoBienes', v)}
              />
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-slate-500">Total Facturado</span>
              <span className="text-base font-bold font-mono text-slate-100">RD$ {formatMoney(totalMonto)}</span>
            </div>
          </section>

          {/* Sección 3: ITBIS */}
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">ITBIS (18%)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FieldMoney label="ITBIS Facturado"            value={form.itbisFacturado}        onChange={v => setNumField('itbisFacturado', v)} />
              <FieldMoney label="ITBIS Retenido"             value={form.itbisRetenido}         onChange={v => setNumField('itbisRetenido', v)} />
              <FieldMoney label="ITBIS sujeto Proporcionalidad" value={form.itbisProporcionalidad} onChange={v => setNumField('itbisProporcionalidad', v)} />
              <FieldMoney label="ITBIS Llevado al Costo"     value={form.itbisLlevadoCosto}     onChange={v => setNumField('itbisLlevadoCosto', v)} />
              <FieldMoney label="ITBIS por Adelantar"        value={form.itbisPorAdelantar}     onChange={v => setNumField('itbisPorAdelantar', v)} />
              <FieldMoney label="ITBIS Percibido en Compras" value={form.itbisPercibido}        onChange={v => setNumField('itbisPercibido', v)} />
            </div>
          </section>

          {/* Sección 4: ISR */}
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Retención ISR (Renta)</h3>
            <FieldSelect
              label="Tipo Retención ISR"
              value={form.tipoRetencionIsr}
              onChange={v => setField('tipoRetencionIsr', v)}
              options={TIPO_RETENCION_ISR}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FieldMoney label="Monto Retención Renta" value={form.montoRetencionRenta} onChange={v => setNumField('montoRetencionRenta', v)} />
              <FieldMoney label="ISR Percibido en Compras" value={form.isrPercibido} onChange={v => setNumField('isrPercibido', v)} />
            </div>
          </section>

          {/* Sección 5: Otros impuestos */}
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Otros Impuestos</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <FieldMoney label="Selectivo al Consumo" value={form.impuestoSelectivoConsumo} onChange={v => setNumField('impuestoSelectivoConsumo', v)} />
              <FieldMoney label="Otros Impuestos/Tasas" value={form.otrosImpuestos}         onChange={v => setNumField('otrosImpuestos', v)} />
              <FieldMoney label="Propina Legal"         value={form.propinaLegal}            onChange={v => setNumField('propinaLegal', v)} />
            </div>
          </section>

          {/* Notas */}
          <section className="space-y-1.5">
            <label className="text-xs text-slate-400 block">Notas internas (no van al 606)</label>
            <textarea
              rows={2}
              value={form.notas}
              onChange={e => setField('notas', e.target.value.slice(0, 1000))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              placeholder="Referencia interna, número de factura local, etc."
            />
            <p className="text-[10px] text-slate-500">{(form.notas?.length ?? 0)}/1000</p>
          </section>
        </div>

        <div className="sticky bottom-0 bg-slate-950 border-t border-slate-800 px-5 py-3.5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-300 hover:text-slate-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {isEdit ? 'Actualizar' : 'Registrar Compra'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Field primitives ───────────────────────────────────────────────────────
function FieldText({ label, value, onChange, placeholder, error, mono, uppercase }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1.5">{label}</label>
      <input
        type="text"
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-slate-800 border ${error ? 'border-red-700' : 'border-slate-700'} rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none ${mono ? 'font-mono' : ''} ${uppercase ? 'uppercase' : ''}`}
      />
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

function FieldDate({ label, value, onChange, error }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1.5">{label}</label>
      <input
        type="date"
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className={`w-full bg-slate-800 border ${error ? 'border-red-700' : 'border-slate-700'} rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none`}
      />
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

function FieldSelect({ label, value, onChange, options, error }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1.5">{label}</label>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className={`w-full bg-slate-800 border ${error ? 'border-red-700' : 'border-slate-700'} rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none`}
      >
        {options.map(o => (
          <option key={o.v} value={o.v}>{o.label}</option>
        ))}
      </select>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

function FieldMoney({ label, value, onChange, error }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1.5">{label}</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">RD$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={value ?? 0}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            // Bloquea letras y símbolos peligrosos. type=number ya rechaza pero
            // algunos navegadores aceptan 'e', '+', '-' — los bloqueamos.
            if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault()
          }}
          className={`w-full bg-slate-800 border ${error ? 'border-red-700' : 'border-slate-700'} rounded-lg pl-12 pr-3 py-2 text-sm font-mono text-slate-100 focus:border-blue-500 focus:outline-none`}
        />
      </div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

// ─── Página principal ────────────────────────────────────────────────────────
export default function Compras() {
  const { tienePermiso } = useAuth()
  const navigate = useNavigate()

  const [items, setItems]         = useState([])
  const [meta,  setMeta]          = useState({ total: 0, page: 1, totalPages: 1 })
  const [page,  setPage]          = useState(1)
  const [search, setSearch]       = useState('')
  const [desde, setDesde]         = useState('')
  const [hasta, setHasta]         = useState('')
  const [loading, setLoading]     = useState(false)

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing]       = useState(null)

  const fetchCompras = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) })
      if (search) params.set('search', search)
      if (desde)  params.set('desde',  desde)
      if (hasta)  params.set('hasta',  hasta)
      const r = await apiFetch(`/api/dgii/compras?${params}`)
      const j = await r.json().catch(() => ({}))
      if (r.ok) {
        setItems(Array.isArray(j.data) ? j.data : [])
        setMeta(j.meta || { total: 0, page: 1, totalPages: 1 })
      } else {
        toast.error(j.error || 'Error al cargar compras.')
      }
    } catch {
      toast.error('Error de red.')
    } finally { setLoading(false) }
  }, [page, search, desde, hasta])

  useEffect(() => {
    const t = setTimeout(fetchCompras, 250)
    return () => clearTimeout(t)
  }, [fetchCompras])

  function abrirNueva() { setEditing(null); setDrawerOpen(true) }
  function abrirEdicion(c) { setEditing(c); setDrawerOpen(true) }

  async function eliminar(c) {
    if (!confirm(`¿Eliminar compra ${c.noCompra}? Esta acción requiere TOTP del propietario.`)) return
    try {
      const r = await apiFetch(`/api/dgii/compras/${c.id}`, { method: 'DELETE' })
      if (r.status === 204) {
        toast.success('Compra eliminada.')
        fetchCompras()
      } else {
        const j = await r.json().catch(() => ({}))
        toast.error(j.error || 'No se pudo eliminar (requiere Owner + TOTP).')
      }
    } catch { toast.error('Error de red.') }
  }

  if (!tienePermiso('dgii:reportar')) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
        <ShieldOff size={32} />
        <p className="text-sm font-medium">Sin permiso <code className="bg-slate-800 px-1.5 py-0.5 rounded">dgii:reportar</code>.</p>
        <p className="text-xs">Solo el propietario absoluto puede asignarlo.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight flex items-center gap-2">
            <ShoppingCart size={26} className="text-emerald-400" />
            Compras a Suplidores
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Feed del reporte DGII 606. Cada compra con NCF válido se reporta mensualmente.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => navigate('/dgii')}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg"
          >
            <FileText size={14} />
            Ir a Reportes DGII
          </button>
          <button
            onClick={abrirNueva}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg"
          >
            <Plus size={14} />
            Registrar Compra
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="md:col-span-2">
          <label className="text-xs text-slate-400 block mb-1">Búsqueda</label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="No.Compra, NCF, Suplidor…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Desde</label>
          <input
            type="date" value={desde} onChange={e => { setDesde(e.target.value); setPage(1) }}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Hasta</label>
          <input
            type="date" value={hasta} onChange={e => { setHasta(e.target.value); setPage(1) }}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-950">
              <tr>
                <th className="text-left  px-3 py-2.5 text-slate-400 font-medium text-xs">No.Compra</th>
                <th className="text-left  px-3 py-2.5 text-slate-400 font-medium text-xs">Fecha</th>
                <th className="text-left  px-3 py-2.5 text-slate-400 font-medium text-xs">NCF</th>
                <th className="text-left  px-3 py-2.5 text-slate-400 font-medium text-xs">Suplidor</th>
                <th className="text-left  px-3 py-2.5 text-slate-400 font-medium text-xs">Bien/Serv</th>
                <th className="text-right px-3 py-2.5 text-slate-400 font-medium text-xs">Monto</th>
                <th className="text-right px-3 py-2.5 text-slate-400 font-medium text-xs">ITBIS</th>
                <th className="text-right px-3 py-2.5 text-slate-400 font-medium text-xs">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                  <Loader2 size={16} className="animate-spin inline mr-2" />Cargando compras…
                </td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500 italic">
                  Sin compras registradas. Haz click en "Registrar Compra".
                </td></tr>
              )}
              {items.map(c => {
                const totalMonto = Number(c.montoServicios || 0) + Number(c.montoBienes || 0)
                return (
                  <tr key={c.id} className="border-t border-slate-800 hover:bg-slate-800/40">
                    <td className="px-3 py-2 text-slate-300 font-mono text-xs">{c.noCompra}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{formatFechaCorta(c.fechaComprobante)}</td>
                    <td className="px-3 py-2 text-slate-200 font-mono text-xs">{c.ncfProveedor || <span className="text-slate-600 italic">— sin NCF —</span>}</td>
                    <td className="px-3 py-2 text-slate-200">
                      <p className="truncate max-w-[200px] flex items-center gap-1.5">
                        {c.suplidor?.razonSocial ?? <span className="italic text-slate-500">Sin suplidor</span>}
                        {c.esGastoInformal && (
                          <span className="text-[9px] px-1 py-0.5 bg-amber-900/40 text-amber-300 border border-amber-700/40 rounded uppercase tracking-wider">informal</span>
                        )}
                      </p>
                      <p className="text-[10px] text-slate-500 font-mono">
                        {c.suplidor?.rnc || c.suplidor?.cedula || (c.esGastoInformal ? 'no aplica' : '')}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-slate-400 font-mono text-xs">{c.tipoBienServicio}</td>
                    <td className="px-3 py-2 text-right text-slate-200 font-mono">{formatMoney(totalMonto)}</td>
                    <td className="px-3 py-2 text-right text-slate-200 font-mono">{formatMoney(c.itbisFacturado)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => abrirEdicion(c)}
                          className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-800 rounded"
                          title="Editar"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => eliminar(c)}
                          className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded"
                          title="Eliminar (requiere TOTP)"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {/* Pagination */}
        {meta.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>{meta.total} resultados</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(p - 1, 1))}
                disabled={page <= 1 || loading}
                className="p-1.5 hover:bg-slate-800 rounded disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="font-mono">{meta.page} / {meta.totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(p + 1, meta.totalPages))}
                disabled={page >= meta.totalPages || loading}
                className="p-1.5 hover:bg-slate-800 rounded disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <FormularioCompra
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => { setDrawerOpen(false); fetchCompras() }}
        initial={editing}
      />
    </div>
  )
}
