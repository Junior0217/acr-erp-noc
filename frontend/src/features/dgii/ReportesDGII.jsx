/**
 * frontend/src/features/dgii/ReportesDGII.jsx
 *
 * Dashboard DGII Fase 3 — Reportes 606 (Compras) y 607 (Ventas).
 *
 * Flujo:
 *   1) Usuario selecciona periodo (mes + año -> YYYYMM).
 *   2) Botón "Previsualizar" -> GET /api/dgii/{606|607}/preview, abre drawer
 *      con cantidad de registros, totales y tabla truncada (500 filas max).
 *   3) Botón "Generar TXT Oficial" -> modal TOTP. Al confirmar el código,
 *      POST /api/dgii/{606|607}/generar con header `x-totp`. Backend devuelve
 *      filename, SHA-256 y archivoUrl (Supabase Storage).
 *   4) Tabla "Historial" lee /api/dgii/historial y permite descargar TXT
 *      pasado por archivoUrl.
 *
 * Permiso requerido: dgii:reportar. Sin él, vista bloqueada.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  FileText, ShoppingCart, FileSpreadsheet, Download, Eye, ShieldCheck,
  ShieldOff, Loader2, X, KeyRound, AlertTriangle, CheckCircle2,
  Calendar, Hash, FileSignature, RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@shared/contexts/AuthContext'
import { apiFetch } from '@shared/utils/api'

const MESES = [
  '01 — Enero',   '02 — Febrero', '03 — Marzo',   '04 — Abril',
  '05 — Mayo',    '06 — Junio',   '07 — Julio',   '08 — Agosto',
  '09 — Septiembre','10 — Octubre','11 — Noviembre','12 — Diciembre',
]

function buildPeriodo(mes, anio) {
  return `${anio}${String(mes).padStart(2, '0')}`
}

function formatMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '0.00'
  return new Intl.NumberFormat('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n))
}

function formatFechaCorta(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' })
}

// ─── Modal TOTP ─────────────────────────────────────────────────────────────
function TotpModal({ open, onClose, onConfirm, tipo, periodo, busy }) {
  const [code, setCode] = useState('')
  const [err, setErr]   = useState('')
  useEffect(() => { if (open) { setCode(''); setErr('') } }, [open])
  if (!open) return null

  function submit() {
    if (!/^\d{6}$/.test(code)) {
      setErr('Código TOTP debe ser 6 dígitos.')
      return
    }
    onConfirm(code)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-red-700/40 rounded-xl w-full max-w-md overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <ShieldCheck size={18} className="text-red-400" />
          <h2 className="text-base font-bold text-slate-100">Autenticación TOTP</h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <div className="bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2.5 flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200 leading-relaxed">
              Vas a generar el reporte oficial <strong>DGII {tipo}</strong> del periodo
              <strong className="font-mono"> {periodo}</strong>. Esta acción queda
              registrada en el audit-trail con SHA-256 y no se puede revertir.
            </p>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Código de tu app TOTP (6 dígitos)</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoFocus
              value={code}
              onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setErr('') }}
              onKeyDown={e => e.key === 'Enter' && !busy && submit()}
              placeholder="000000"
              className="w-full text-center text-2xl font-mono tracking-[0.6em] bg-slate-800 border border-slate-700 focus:border-red-500 focus:outline-none rounded-lg px-3 py-3 text-slate-100"
            />
            {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
          </div>
        </div>
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-950/40 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-300 hover:text-slate-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy || code.length !== 6}
            className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {busy ? 'Generando…' : 'Confirmar y Generar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Drawer Preview ─────────────────────────────────────────────────────────
function PreviewDrawer({ open, onClose, data, tipo, loading }) {
  if (!open) return null
  const filas = data?.rows ?? []

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-950 border-l border-slate-800 w-full max-w-3xl overflow-y-auto shadow-2xl">
        <div className="sticky top-0 z-10 bg-slate-950 px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <Eye size={18} className="text-blue-400" />
          <h2 className="text-base font-bold text-slate-100">
            Previsualización {tipo} — {data?.periodo ?? '—'}
          </h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>

        {loading && (
          <div className="p-10 flex items-center justify-center text-slate-400">
            <Loader2 size={24} className="animate-spin" />
            <span className="ml-3 text-sm">Calculando preview…</span>
          </div>
        )}

        {!loading && data && (
          <div className="p-5 space-y-5">
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <p className="text-xs text-slate-500 mb-1">Cabecera oficial DGII</p>
              <code className="block bg-slate-950 px-3 py-2 rounded font-mono text-blue-300 text-sm break-all">
                {data.header}
              </code>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi label="Registros" value={data.cantidadRegistros} mono />
              <Kpi label="Total Monto" value={`RD$ ${formatMoney(data.totalMonto)}`} />
              <Kpi label="Total ITBIS" value={`RD$ ${formatMoney(data.totalItbis)}`} />
              {tipo === '607'
                ? <Kpi label="Notas Crédito" value={data.notasCreditoCount ?? 0} mono accent="red" />
                : <Kpi label="ITBIS Retenido" value={`RD$ ${formatMoney(data.totalItbisRetenido)}`} accent="amber" />}
            </div>

            {tipo === '606' && (
              <div className="grid grid-cols-2 gap-3">
                <Kpi label="ISR Retenido" value={`RD$ ${formatMoney(data.totalIsrRetenido)}`} accent="amber" />
                <Kpi label="RNC Empresa" value={data.rncEmpresa} mono />
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-slate-200">
                  Filas ({filas.length}{data.truncated ? ' de muchas — mostrando 500' : ''})
                </h3>
              </div>
              {filas.length === 0 ? (
                <p className="text-sm text-slate-500 italic">Sin registros para este periodo.</p>
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                  <div className="max-h-[60vh] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-950 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 text-slate-500 font-mono">#</th>
                          <th className="text-left px-3 py-2 text-slate-400 font-medium">NCF</th>
                          {tipo === '607'
                            ? <>
                                <th className="text-right px-3 py-2 text-slate-400 font-medium">Total</th>
                                <th className="text-right px-3 py-2 text-slate-400 font-medium">ITBIS</th>
                              </>
                            : <>
                                <th className="text-left px-3 py-2 text-slate-400 font-medium">No. Compra</th>
                                <th className="text-right px-3 py-2 text-slate-400 font-medium">Monto</th>
                                <th className="text-right px-3 py-2 text-slate-400 font-medium">ITBIS</th>
                              </>}
                        </tr>
                      </thead>
                      <tbody>
                        {filas.map((r, i) => (
                          <tr key={i} className="border-t border-slate-800 hover:bg-slate-800/40">
                            <td className="px-3 py-1.5 text-slate-500 font-mono">{i + 1}</td>
                            <td className="px-3 py-1.5 text-slate-200 font-mono">{r.ncf}</td>
                            {tipo === '607'
                              ? <>
                                  <td className={`px-3 py-1.5 text-right font-mono ${r.esNegativo ? 'text-red-400' : 'text-slate-200'}`}>
                                    {formatMoney(r.total)}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right font-mono ${r.esNegativo ? 'text-red-400' : 'text-slate-200'}`}>
                                    {formatMoney(r.itbis)}
                                  </td>
                                </>
                              : <>
                                  <td className="px-3 py-1.5 text-slate-300 font-mono">{r.noCompra}</td>
                                  <td className="px-3 py-1.5 text-right text-slate-200 font-mono">{formatMoney(r.totalMonto)}</td>
                                  <td className="px-3 py-1.5 text-right text-slate-200 font-mono">{formatMoney(r.itbisFacturado)}</td>
                                </>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, mono, accent }) {
  const colorClass =
    accent === 'red'   ? 'text-red-300'   :
    accent === 'amber' ? 'text-amber-300' :
                         'text-slate-100'
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</p>
      <p className={`text-base font-bold ${mono ? 'font-mono' : ''} ${colorClass}`}>{value}</p>
    </div>
  )
}

// ─── Card por tipo de reporte (606 / 607) ───────────────────────────────────
function ReporteCard({ tipo, periodo, icon: Icon, color, onPreview, onGenerar, busy }) {
  return (
    <div className={`bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-${color}-700/60 transition-colors`}>
      <div className={`px-5 py-4 border-b border-slate-800 bg-gradient-to-r from-${color}-900/30 to-transparent flex items-center gap-3`}>
        <div className={`w-10 h-10 rounded-lg bg-${color}-900/40 border border-${color}-700/40 flex items-center justify-center`}>
          <Icon size={20} className={`text-${color}-300`} />
        </div>
        <div>
          <h2 className="text-base font-bold text-slate-100">Formato {tipo}</h2>
          <p className="text-xs text-slate-500">
            {tipo === '606' ? 'Compras y Gastos a Suplidores' : 'Ventas, Notas de Débito y Crédito'}
          </p>
        </div>
      </div>
      <div className="p-5 space-y-3">
        <div className="text-xs text-slate-400 space-y-1">
          <p>• Norma DGII 06-2018, 23 campos pipe-delimited.</p>
          <p>• Filename: <span className="font-mono text-slate-300">DGII_F_{tipo}_&lt;RNC&gt;_{periodo}.TXT</span></p>
          <p>• Generación firma con SHA-256 + audit-trail inmutable.</p>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={onPreview}
            disabled={busy}
            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded-lg disabled:opacity-50"
          >
            <Eye size={14} />
            Previsualizar
          </button>
          <button
            onClick={onGenerar}
            disabled={busy}
            className={`flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium bg-${color}-600 hover:bg-${color}-500 text-white rounded-lg disabled:opacity-50`}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <FileSignature size={14} />}
            Generar TXT Oficial
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Tabla Historial ─────────────────────────────────────────────────────────
function HistorialTabla({ historial, loading, onRefresh }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3">
        <Hash size={18} className="text-slate-400" />
        <div>
          <h2 className="text-base font-bold text-slate-100">Historial de Generaciones</h2>
          <p className="text-xs text-slate-500">Audit-trail inmutable. SHA-256 prueba integridad ante DGII.</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700 disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refrescar
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-950">
            <tr>
              <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">Tipo</th>
              <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">Periodo</th>
              <th className="text-right px-4 py-2.5 text-slate-400 font-medium text-xs">Registros</th>
              <th className="text-right px-4 py-2.5 text-slate-400 font-medium text-xs">Total Monto</th>
              <th className="text-right px-4 py-2.5 text-slate-400 font-medium text-xs">Total ITBIS</th>
              <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">Por</th>
              <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">Generado</th>
              <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">SHA-256</th>
              <th className="text-right px-4 py-2.5 text-slate-400 font-medium text-xs">Acción</th>
            </tr>
          </thead>
          <tbody>
            {loading && historial.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-500"><Loader2 size={16} className="animate-spin inline mr-2" />Cargando historial…</td></tr>
            )}
            {!loading && historial.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-500 italic">Sin generaciones todavía.</td></tr>
            )}
            {historial.map(h => (
              <tr key={h.id} className="border-t border-slate-800 hover:bg-slate-800/40">
                <td className="px-4 py-2">
                  <span className={`inline-block px-2 py-0.5 text-xs font-bold rounded ${h.tipo === '606' ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40' : 'bg-blue-900/40 text-blue-300 border border-blue-700/40'}`}>
                    {h.tipo}
                  </span>
                </td>
                <td className="px-4 py-2 text-slate-300 font-mono text-xs">{h.periodo}</td>
                <td className="px-4 py-2 text-right text-slate-200 font-mono">{h.cantidadRegistros}</td>
                <td className="px-4 py-2 text-right text-slate-200 font-mono text-xs">{formatMoney(h.totalMonto)}</td>
                <td className="px-4 py-2 text-right text-slate-200 font-mono text-xs">{formatMoney(h.totalItbis)}</td>
                <td className="px-4 py-2 text-slate-400 text-xs">{h.empleado?.nombre ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400 text-xs">{formatFechaCorta(h.generadoEn)}</td>
                <td className="px-4 py-2 text-slate-500 font-mono text-[10px]" title={h.sha256}>
                  {String(h.sha256).slice(0, 12)}…
                </td>
                <td className="px-4 py-2 text-right">
                  {h.archivoUrl ? (
                    <a
                      href={h.archivoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
                    >
                      <Download size={12} />
                      TXT
                    </a>
                  ) : (
                    <span className="text-xs text-slate-600 italic">sin URL</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Página principal ────────────────────────────────────────────────────────
export default function ReportesDGII() {
  const { tienePermiso } = useAuth()

  const now = new Date()
  const [mes,  setMes]  = useState(now.getMonth() + 1)
  const [anio, setAnio] = useState(now.getFullYear())
  const periodo = useMemo(() => buildPeriodo(mes, anio), [mes, anio])

  // Preview state
  const [previewOpen, setPreviewOpen]   = useState(false)
  const [previewData, setPreviewData]   = useState(null)
  const [previewTipo, setPreviewTipo]   = useState('606')
  const [previewLoad, setPreviewLoad]   = useState(false)

  // TOTP modal
  const [totpOpen,   setTotpOpen]    = useState(false)
  const [totpTipo,   setTotpTipo]    = useState('606')
  const [generando,  setGenerando]   = useState(false)
  const [busy606,    setBusy606]     = useState(false)
  const [busy607,    setBusy607]     = useState(false)

  // Historial
  const [historial,    setHistorial]    = useState([])
  const [histLoading,  setHistLoading]  = useState(false)

  async function fetchHistorial() {
    setHistLoading(true)
    try {
      const r = await apiFetch('/api/dgii/historial?limit=50')
      const j = await r.json().catch(() => ({}))
      if (r.ok) setHistorial(j.data ?? [])
      else toast.error(j.error || 'No se pudo cargar el historial.')
    } catch {
      toast.error('Error de red al cargar historial.')
    } finally { setHistLoading(false) }
  }

  useEffect(() => { fetchHistorial() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePreview(tipo) {
    setPreviewTipo(tipo)
    setPreviewData(null)
    setPreviewOpen(true)
    setPreviewLoad(true)
    if (tipo === '606') setBusy606(true); else setBusy607(true)
    try {
      const r = await apiFetch(`/api/dgii/${tipo}/preview?periodo=${periodo}`)
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        toast.error(j.error || `Error generando preview ${tipo}.`)
        setPreviewOpen(false)
        return
      }
      setPreviewData(j)
    } catch {
      toast.error('Error de red.')
      setPreviewOpen(false)
    } finally {
      setPreviewLoad(false)
      if (tipo === '606') setBusy606(false); else setBusy607(false)
    }
  }

  function handleGenerarClick(tipo) {
    setTotpTipo(tipo)
    setTotpOpen(true)
  }

  async function handleGenerarConfirm(totpCode) {
    const tipo = totpTipo
    setGenerando(true)
    try {
      const r = await apiFetch(`/api/dgii/${tipo}/generar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-totp': totpCode,
        },
        body: JSON.stringify({ periodo }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        toast.error(j.error || `Error generando ${tipo}.`)
        return
      }
      toast.success(`Reporte ${tipo} generado: ${j.filename}`, {
        description: `${j.cantidadRegistros} registros · SHA-256 ${String(j.sha256).slice(0, 12)}…`,
        duration: 6000,
      })
      setTotpOpen(false)
      fetchHistorial()
    } catch {
      toast.error('Error de red al generar.')
    } finally {
      setGenerando(false)
    }
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
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight flex items-center gap-2">
            <FileText size={26} className="text-red-400" />
            Reportes DGII
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Formatos 606 (Compras) y 607 (Ventas) — Norma General 06-2018 · Archivo TXT pipe-delimited
          </p>
        </div>
        <div className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Periodo</p>
          <p className="text-base font-mono font-bold text-slate-200">{periodo}</p>
        </div>
      </div>

      {/* Selector periodo */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={16} className="text-blue-400" />
          <h2 className="text-sm font-bold text-slate-200">Selecciona Periodo a Reportar</h2>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-slate-400 block mb-1">Mes</label>
            <select
              value={mes}
              onChange={e => setMes(parseInt(e.target.value, 10))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
            >
              {MESES.map((m, i) => (
                <option key={i + 1} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-slate-400 block mb-1">Año</label>
            <input
              type="number"
              min={2020}
              max={now.getFullYear() + 1}
              value={anio}
              onChange={e => setAnio(parseInt(e.target.value, 10) || now.getFullYear())}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 font-mono focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Cards de reportes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ReporteCard
          tipo="606"
          periodo={periodo}
          icon={ShoppingCart}
          color="emerald"
          onPreview={() => handlePreview('606')}
          onGenerar={() => handleGenerarClick('606')}
          busy={busy606}
        />
        <ReporteCard
          tipo="607"
          periodo={periodo}
          icon={FileSpreadsheet}
          color="blue"
          onPreview={() => handlePreview('607')}
          onGenerar={() => handleGenerarClick('607')}
          busy={busy607}
        />
      </div>

      {/* Aviso de cumplimiento */}
      <div className="bg-amber-900/15 border border-amber-700/30 rounded-lg p-3 flex items-start gap-2">
        <CheckCircle2 size={16} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200 leading-relaxed">
          <strong>Plazo legal:</strong> entrega del 606/607 antes del día 20 del mes
          siguiente al periodo. Sube el TXT generado al portal{' '}
          <a href="https://dgii.gov.do/ofv" target="_blank" rel="noreferrer" className="underline hover:text-amber-100">
            DGII OFV
          </a>{' '}
          desde el computador del contador.
        </p>
      </div>

      {/* Historial */}
      <HistorialTabla historial={historial} loading={histLoading} onRefresh={fetchHistorial} />

      {/* Modales */}
      <PreviewDrawer
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        data={previewData}
        tipo={previewTipo}
        loading={previewLoad}
      />
      <TotpModal
        open={totpOpen}
        onClose={() => !generando && setTotpOpen(false)}
        onConfirm={handleGenerarConfirm}
        tipo={totpTipo}
        periodo={periodo}
        busy={generando}
      />
    </div>
  )
}
