/**
 * frontend/src/features/sales/panels/CotizadorManualPro.jsx
 *
 * Cotizador Manual Libre para proyectos de infraestructura/CCTV. Texto
 * editable plano, sin sincronización con stock físico. Genera PDF servido
 * por POST /api/ventas/cotizador-libre/pdf.
 *
 * Estilo Cyber-Industrial: bg-slate-900, text-slate-100, blue-600 acentos.
 * Iconos: lucide-react. Responsive: w-full / max-w-7xl centrado.
 *
 * Estado:
 *   - cliente: razonSocial / direccion / telefono / contacto / rnc — editable.
 *   - items: array fluido con código/desc/cant/PU/aplicaItbis.
 *   - aplicaItbisGlobal: switch general.
 *   - descuento global: porcentaje O monto fijo (ambos opcionales).
 *   - condiciones (validez/pago/entrega/garantía/notas) via useCondicionesDoc.
 */

import { useMemo, useState } from 'react'
import { Plus, Trash2, FileDown, Loader2, Building2, ShieldCheck, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@shared/utils/api'
import EditorCondiciones  from '@features/sales/panels/_shared/EditorCondiciones'
import useCondicionesDoc  from '@features/sales/panels/_shared/useCondicionesDoc'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5'

// ─── Estado inicial ──────────────────────────────────────────────────────────
// Cliente precargado solicitado por el socio: levantamiento de 36 cámaras
// para la Escuela Benito Juárez. Editable en pantalla; no se persiste BD.
const CLIENTE_DEFAULT = {
  razonSocial: 'Escuela Benito Juárez',
  contacto:    '',
  rnc:         '',
  telefono:    '',
  direccion:   '',
}

const FORMA_PAGO_OPCIONES = [
  'Contado', 'Transferencia bancaria', 'Tarjeta crédito/débito',
  'Cheque', 'Crédito 15 días', 'Crédito 30 días', '50% anticipo + 50% contra entrega',
]

function nuevaLinea() {
  return { id: crypto.randomUUID(), codigo: '', descripcion: '', cantidad: 1, precioUnit: 0, aplicaItbis: true }
}

const ITEMS_INICIAL = [nuevaLinea()]

function fmtRD(n) {
  return Number(n ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function CotizadorManualPro() {
  // ─── Cliente / encabezado del documento ──────────────────────────────────
  const [cliente, setCliente] = useState(CLIENTE_DEFAULT)
  const [numeroDocumento, setNumeroDocumento] = useState(`COT-${Date.now().toString().slice(-6)}`)

  // ─── Items editables ─────────────────────────────────────────────────────
  const [items, setItems] = useState(ITEMS_INICIAL)
  const addLinea = () => setItems((arr) => [...arr, nuevaLinea()])
  const delLinea = (id) => setItems((arr) => arr.length > 1 ? arr.filter((l) => l.id !== id) : arr)
  const updLinea = (id, patch) => setItems((arr) => arr.map((l) => l.id === id ? { ...l, ...patch } : l))

  // ─── Switches y descuentos globales ──────────────────────────────────────
  const [aplicaItbisGlobal, setAplicaItbisGlobal] = useState(true)
  const [porcentajeItbis,   setPorcentajeItbis]   = useState(18)
  const [descuentoPct,      setDescuentoPct]      = useState(0)
  const [descuentoMonto,    setDescuentoMonto]    = useState(0)

  // ─── Condiciones (hook DRY compartido con PanelFacturas/Cotizaciones) ───
  const {
    cond, reset: resetCond,
    values: condValues, mostrar: condMostrar,
    onChange: condOnChange, onMostrar: condOnMostrar,
  } = useCondicionesDoc({
    validez:  { incluir: true,  texto: 'Esta cotización es válida por 15 días calendarios.' },
    pago:     { incluir: true,  texto: '50% anticipo + 50% contra entrega.' },
    entrega:  { incluir: true,  texto: 'Entrega e instalación en 5-7 días laborables tras confirmación.' },
    garantia: { incluir: true,  texto: '12 meses contra defectos de fábrica para equipos. Mano de obra: 90 días.' },
    notas:    { incluir: false, texto: '' },
  })

  // ─── Cálculo en tiempo real (espejo del backend service._calcularTotales) ──
  // useMemo porque el array de items puede crecer a 30-50 líneas y el cómputo
  // corre en cada keystroke del precio/cantidad. Sin memo, todo el JSX se
  // reconcilia 60+ veces por segundo en un input rápido del cajero.
  const totales = useMemo(() => {
    const pct = Number(porcentajeItbis) / 100
    const lineas = items.map((it) => {
      const qty = Math.max(0, Math.floor(Number(it.cantidad ?? 0)))
      const pu  = Math.max(0, Number(it.precioUnit ?? 0))
      const sub = Math.round(qty * pu * 100) / 100
      const itl = aplicaItbisGlobal && it.aplicaItbis ? Math.round(sub * pct * 100) / 100 : 0
      return { ...it, qty, pu, subtotal: sub, itbisLinea: itl }
    })
    const subtotal      = lineas.reduce((s, l) => s + l.subtotal, 0)
    const dscPct        = Math.max(0, Math.min(100, Number(descuentoPct ?? 0))) / 100
    const dscFijo       = Math.max(0, Number(descuentoMonto ?? 0))
    const descuentoCalc = Math.round((subtotal * dscPct + dscFijo) * 100) / 100
    const descuento     = Math.min(descuentoCalc, subtotal)
    const baseImponible = Math.max(0, subtotal - descuento)
    const itbis         = aplicaItbisGlobal ? Math.round(baseImponible * pct * 100) / 100 : 0
    const total         = Math.round((baseImponible + itbis) * 100) / 100
    return { lineas, subtotal, descuento, baseImponible, itbis, total }
  }, [items, aplicaItbisGlobal, porcentajeItbis, descuentoPct, descuentoMonto])

  // ─── Generar PDF ─────────────────────────────────────────────────────────
  const [generando, setGenerando] = useState(false)
  async function generarPdf() {
    if (!cliente.razonSocial?.trim()) { toast.error('Falta el nombre del cliente.'); return }
    if (items.some((l) => !l.descripcion?.trim())) { toast.error('Todas las líneas requieren descripción.'); return }
    setGenerando(true)
    try {
      const payload = {
        numeroDocumento,
        titulo: 'COTIZACIÓN',
        cliente,
        aplicaItbisGlobal,
        porcentajeItbis:  Number(porcentajeItbis),
        descuentoGlobalPct:   Number(descuentoPct),
        descuentoGlobalMonto: Number(descuentoMonto),
        condiciones: cond,
        items: items.map((l) => ({
          codigo:      l.codigo?.trim() || null,
          descripcion: l.descripcion.trim(),
          cantidad:    Number(l.cantidad ?? 0),
          precioUnit:  Number(l.precioUnit ?? 0),
          aplicaItbis: !!l.aplicaItbis,
        })),
      }
      const res = await apiFetch('/api/ventas/cotizador-libre/pdf', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      // Descarga blob → abre en pestaña nueva. window.open con URL.createObjectURL.
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      // Liberar después de 60s para no fugar memoria (la pestaña ya cargó).
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast.success('PDF generado.')
    } catch (e) {
      toast.error(`Error generando PDF: ${e.message}`)
    } finally { setGenerando(false) }
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 py-6 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        {/* ─── Header ─────────────────────────────────────────────────────── */}
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
              <FileText size={24} className="text-blue-500" />
              Cotizador Manual Pro
            </h1>
            <p className="text-xs text-slate-500 mt-1 tracking-wide">
              Editor libre · Sin stock rígido · PDF on-demand · Cyber-Industrial
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">N° doc:</label>
            <input
              value={numeroDocumento}
              onChange={(e) => setNumeroDocumento(e.target.value)}
              className={INPUT + ' w-44'}
              placeholder="COT-XXXXXX"
            />
          </div>
        </header>

        {/* ─── Cliente ─────────────────────────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
            <Building2 size={16} className="text-blue-500" />
            Cliente
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <label className={LABEL}>Razón social *</label>
              <input
                value={cliente.razonSocial}
                onChange={(e) => setCliente({ ...cliente, razonSocial: e.target.value })}
                className={INPUT}
                placeholder="Escuela Benito Juárez"
              />
            </div>
            <div>
              <label className={LABEL}>RNC / Cédula</label>
              <input
                value={cliente.rnc ?? ''}
                onChange={(e) => setCliente({ ...cliente, rnc: e.target.value })}
                className={INPUT}
                placeholder="Opcional"
              />
            </div>
            <div>
              <label className={LABEL}>Persona de contacto</label>
              <input
                value={cliente.contacto ?? ''}
                onChange={(e) => setCliente({ ...cliente, contacto: e.target.value })}
                className={INPUT}
                placeholder="Nombre del contacto"
              />
            </div>
            <div>
              <label className={LABEL}>Teléfono (opcional)</label>
              <input
                value={cliente.telefono ?? ''}
                onChange={(e) => setCliente({ ...cliente, telefono: e.target.value })}
                className={INPUT}
                placeholder="809-000-0000"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className={LABEL}>Dirección de la instalación</label>
              <input
                value={cliente.direccion ?? ''}
                onChange={(e) => setCliente({ ...cliente, direccion: e.target.value })}
                className={INPUT}
                placeholder="C/ Ejemplo #123, Sector, Provincia"
              />
            </div>
          </div>
        </section>

        {/* ─── Tabla de ítems ─────────────────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider">
              Ítems del proyecto
              <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal">
                · {items.length} línea{items.length !== 1 ? 's' : ''}
              </span>
            </h2>
            <button
              onClick={addLinea}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors">
              <Plus size={13} /> Añadir Fila
            </button>
          </div>
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800">
                  <th className="text-left py-2 pr-2 w-10">#</th>
                  <th className="text-left py-2 pr-2 w-32">Código / Modelo</th>
                  <th className="text-left py-2 pr-2">Descripción *</th>
                  <th className="text-center py-2 pr-2 w-20">Cant.</th>
                  <th className="text-right py-2 pr-2 w-32">Precio Unit. (RD$)</th>
                  <th className="text-center py-2 pr-2 w-16">ITBIS</th>
                  <th className="text-right py-2 pr-2 w-32">Importe</th>
                  <th className="text-center py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {totales.lineas.map((l, idx) => (
                  <tr key={l.id} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                    <td className="py-2 pr-2 text-slate-500 text-xs">{idx + 1}</td>
                    <td className="py-2 pr-2">
                      <input
                        value={l.codigo}
                        onChange={(e) => updLinea(l.id, { codigo: e.target.value })}
                        placeholder="Ej: IPC-HDW2849H"
                        className={INPUT + ' py-1.5 text-xs'}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        value={l.descripcion}
                        onChange={(e) => updLinea(l.id, { descripcion: e.target.value })}
                        placeholder="Ej: Cámara IP 4MP Dahua tipo bullet con visión nocturna 30m"
                        className={INPUT + ' py-1.5 text-xs'}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        type="number" min="0" step="1"
                        value={l.cantidad}
                        onChange={(e) => updLinea(l.id, { cantidad: e.target.value })}
                        className={INPUT + ' py-1.5 text-xs text-center'}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        type="number" min="0" step="0.01"
                        value={l.precioUnit}
                        onChange={(e) => updLinea(l.id, { precioUnit: e.target.value })}
                        className={INPUT + ' py-1.5 text-xs text-right'}
                      />
                    </td>
                    <td className="py-2 pr-2 text-center">
                      <input
                        type="checkbox"
                        checked={!!l.aplicaItbis}
                        onChange={(e) => updLinea(l.id, { aplicaItbis: e.target.checked })}
                        disabled={!aplicaItbisGlobal}
                        title={aplicaItbisGlobal ? 'Aplicar ITBIS a esta línea' : 'ITBIS global desactivado'}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30 disabled:opacity-40"
                      />
                    </td>
                    <td className="py-2 pr-2 text-right text-slate-200 font-medium tabular-nums">
                      {fmtRD(l.subtotal)}
                    </td>
                    <td className="py-2 text-center">
                      <button
                        onClick={() => delLinea(l.id)}
                        disabled={items.length === 1}
                        title="Eliminar línea"
                        className="text-slate-500 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ─── Switches + totales en dos columnas ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
              <ShieldCheck size={16} className="text-blue-500" />
              Impuestos y Descuentos
            </h2>
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-800/50 border border-slate-700 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-slate-100">Aplicar ITBIS global</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Switch general — desactivar omite ITBIS en todas las líneas</div>
                </div>
                <input
                  type="checkbox"
                  checked={aplicaItbisGlobal}
                  onChange={(e) => setAplicaItbisGlobal(e.target.checked)}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30"
                />
              </label>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={LABEL}>% ITBIS</label>
                  <input
                    type="number" min="0" max="40" step="0.01"
                    value={porcentajeItbis}
                    onChange={(e) => setPorcentajeItbis(e.target.value)}
                    disabled={!aplicaItbisGlobal}
                    className={INPUT + ' text-right disabled:opacity-50'}
                  />
                </div>
                <div>
                  <label className={LABEL}>Descuento %</label>
                  <input
                    type="number" min="0" max="100" step="0.01"
                    value={descuentoPct}
                    onChange={(e) => setDescuentoPct(e.target.value)}
                    className={INPUT + ' text-right'}
                  />
                </div>
                <div>
                  <label className={LABEL}>Descuento RD$</label>
                  <input
                    type="number" min="0" step="0.01"
                    value={descuentoMonto}
                    onChange={(e) => setDescuentoMonto(e.target.value)}
                    className={INPUT + ' text-right'}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">Totales</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-slate-300">
                <span>Subtotal</span>
                <span className="tabular-nums">RD$ {fmtRD(totales.subtotal)}</span>
              </div>
              {totales.descuento > 0 && (
                <div className="flex justify-between text-amber-400">
                  <span>Descuento</span>
                  <span className="tabular-nums">− RD$ {fmtRD(totales.descuento)}</span>
                </div>
              )}
              {aplicaItbisGlobal && (
                <div className="flex justify-between text-slate-300 border-t border-slate-800 pt-2">
                  <span>ITBIS {Number(porcentajeItbis).toFixed(0)}%</span>
                  <span className="tabular-nums">RD$ {fmtRD(totales.itbis)}</span>
                </div>
              )}
              <div className="flex justify-between bg-blue-600/20 border border-blue-600/40 rounded-lg px-3 py-3 mt-2">
                <span className="text-blue-300 font-bold text-base">Total Neto RD$</span>
                <span className="text-blue-300 font-bold text-base tabular-nums">RD$ {fmtRD(totales.total)}</span>
              </div>
            </div>
          </section>
        </div>

        {/* ─── Editor de condiciones (DRY con PanelFacturas/Cotizaciones) ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
            Condiciones del documento
            <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal ml-2">
              · Switches para incluir/omitir cada bloque en el PDF
            </span>
          </h2>
          <EditorCondiciones
            keys={['validez','pago','entrega','garantia','notas']}
            values={condValues}
            mostrar={condMostrar}
            onChange={condOnChange}
            onMostrar={condOnMostrar}
            formaPagoChildren={
              <select
                value={condValues.pago ?? ''}
                onChange={(e) => condOnChange('pago', e.target.value)}
                disabled={!condMostrar.pago}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-50"
              >
                <option value="">(Personalizado)</option>
                {FORMA_PAGO_OPCIONES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            }
          />
          {/* Reset button — restaura los defaults iniciales (útil tras tocar mucho). */}
          <div className="flex justify-end mt-3">
            <button
              onClick={() => resetCond({
                validez:  { incluir: true,  texto: 'Esta cotización es válida por 15 días calendarios.' },
                pago:     { incluir: true,  texto: '50% anticipo + 50% contra entrega.' },
                entrega:  { incluir: true,  texto: 'Entrega e instalación en 5-7 días laborables tras confirmación.' },
                garantia: { incluir: true,  texto: '12 meses contra defectos de fábrica para equipos. Mano de obra: 90 días.' },
                notas:    { incluir: false, texto: '' },
              })}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-wider">
              Restaurar defaults
            </button>
          </div>
        </section>

        {/* ─── Acción principal: generar PDF ──────────────────────────────── */}
        <div className="sticky bottom-4 z-10 flex justify-end">
          <button
            onClick={generarPdf}
            disabled={generando}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white font-bold text-sm shadow-2xl shadow-blue-900/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {generando ? <Loader2 size={16} className="animate-spin" /> : <FileDown size={16} />}
            {generando ? 'Generando PDF…' : 'Generar Cotización PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
