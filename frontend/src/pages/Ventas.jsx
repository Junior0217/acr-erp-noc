import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Package, ClipboardList, FileText, Settings2, Plus, Search, Pencil,
  Loader2, Save, X, CheckCircle, XCircle, RefreshCw, AlertCircle,
  User, Wrench, Wifi, Camera, Zap, ShoppingCart, Trash2, DollarSign,
} from 'lucide-react'
import { apiFetch } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'

// ── Constants ─────────────────────────────────────────────────────────────────

const TIPOS      = ['Recurrente', 'VentaUnica', 'Servicio']
const CATEGORIAS = ['WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV', 'Mixto']
const TIPOS_OT   = ['ISP', 'CCTV', 'Reparacion', 'CercoElectrico', 'VentaDirecta', 'General']
const ESTADOS_OT = ['Pendiente', 'EnProceso', 'Completada', 'Cancelada']

const META_DEFAULTS = {
  ISP:            { ip: '', macAddress: '', router: '', diaCorte: '' },
  CCTV:           { cantidadCamaras: '', tipoGrabacion: 'NVR', ipNVR: '' },
  Reparacion:     { equipoTipo: '', falla: '', diagnostico: '' },
  CercoElectrico: { voltaje: '', zonas: '', marca: '' },
  VentaDirecta:   { metodoPago: 'Efectivo', entrega: '' },
  General:        {},
}

const TIPO_COLORS = {
  Recurrente: { text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  VentaUnica:  { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  Servicio:    { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
}

const CAT_COLORS = {
  WISP:          { text: 'text-cyan-400',    bg: 'bg-cyan-500/15',    border: 'border-cyan-500/30'    },
  CCTV:          { text: 'text-violet-400',  bg: 'bg-violet-500/15',  border: 'border-violet-500/30'  },
  Redes:         { text: 'text-sky-400',     bg: 'bg-sky-500/15',     border: 'border-sky-500/30'     },
  CercoElectrico:{ text: 'text-orange-400',  bg: 'bg-orange-500/15',  border: 'border-orange-500/30'  },
  VentaDirecta:  { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  SoporteTecnico:{ text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  Reparacion:    { text: 'text-red-400',     bg: 'bg-red-500/15',     border: 'border-red-500/30'     },
  ProyectoCCTV:  { text: 'text-purple-400',  bg: 'bg-purple-500/15',  border: 'border-purple-500/30'  },
  Mixto:         { text: 'text-slate-400',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
}

const OT_TIPO_META = {
  ISP:            { icon: Wifi,         color: 'cyan',    label: 'ISP / WISP'      },
  CCTV:           { icon: Camera,       color: 'violet',  label: 'CCTV'            },
  Reparacion:     { icon: Wrench,       color: 'amber',   label: 'Reparación'      },
  CercoElectrico: { icon: Zap,          color: 'orange',  label: 'Cerco Eléc.'     },
  VentaDirecta:   { icon: ShoppingCart, color: 'emerald', label: 'Venta Directa'   },
  General:        { icon: Package,      color: 'slate',   label: 'General'         },
}

const OT_TIPO_COLOR_MAP = {
  cyan:    { text: 'text-cyan-400',    bg: 'bg-cyan-500/15',    border: 'border-cyan-500/30'    },
  violet:  { text: 'text-violet-400',  bg: 'bg-violet-500/15',  border: 'border-violet-500/30'  },
  amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
  orange:  { text: 'text-orange-400',  bg: 'bg-orange-500/15',  border: 'border-orange-500/30'  },
  emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  slate:   { text: 'text-slate-400',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
}

const OT_ESTADO_COLORS = {
  Pendiente:  { text: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
  EnProceso:  { text: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  Completada: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  Cancelada:  { text: 'text-slate-500',   bg: 'bg-slate-500/15',   border: 'border-slate-500/30'   },
}

const TH = 'text-left px-4 py-3 text-slate-400 font-semibold text-xs uppercase tracking-wider whitespace-nowrap'

const LABEL_CLS  = 'block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5'
const INPUT_BASE = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors'
const INPUT_CLS  = `w-full ${INPUT_BASE}`
const SELECT_CLS = `w-full ${INPUT_BASE}`

function formatCurrency(v) {
  return new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP', minimumFractionDigits: 0 }).format(Number(v) || 0)
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── Catalog badges ────────────────────────────────────────────────────────────

function TipoBadge({ tipo }) {
  const c = TIPO_COLORS[tipo] || TIPO_COLORS.Servicio
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {tipo === 'VentaUnica' ? 'Venta Única' : tipo}
    </span>
  )
}

function CatBadge({ cat }) {
  const c = CAT_COLORS[cat] || { text: 'text-slate-400', bg: 'bg-slate-500/15', border: 'border-slate-500/30' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {cat}
    </span>
  )
}

// ── OT badges ─────────────────────────────────────────────────────────────────

function OtTipoBadge({ tipo }) {
  const m = OT_TIPO_META[tipo] ?? OT_TIPO_META.General
  const Icon = m.icon
  const c = OT_TIPO_COLOR_MAP[m.color] ?? OT_TIPO_COLOR_MAP.slate
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      <Icon size={10} />{m.label}
    </span>
  )
}

function OtEstadoBadge({ estado }) {
  const c = OT_ESTADO_COLORS[estado] ?? OT_ESTADO_COLORS.Pendiente
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${c.text} ${c.bg} ${c.border}`}>
      {estado}
    </span>
  )
}

function ComingSoon({ title, desc }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-slate-600">
      <AlertCircle size={36} className="text-slate-700" />
      <div className="text-center">
        <p className="text-base font-semibold text-slate-500">{title}</p>
        <p className="text-sm mt-1">{desc}</p>
        <p className="text-xs mt-3 font-mono text-slate-700">Próximamente</p>
      </div>
    </div>
  )
}

// ── Catálogo ──────────────────────────────────────────────────────────────────

function ItemModal({ item, canSeeCosts, onClose, onSaved }) {
  const empty = { nombre: '', descripcion: '', tipo: 'Recurrente', categoria: 'WISP', precio: '', costo: '0', stock: '', activo: true }
  const [form, setForm] = useState(
    item
      ? { ...item, precio: String(item.precio), costo: String(item.costo ?? 0), stock: item.stock != null ? String(item.stock) : '' }
      : empty
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function save() {
    if (!form.nombre.trim()) return setErr('Nombre requerido.')
    if (!form.precio || isNaN(parseFloat(form.precio))) return setErr('Precio inválido.')
    setSaving(true); setErr('')
    try {
      const body = {
        nombre:      form.nombre.trim(),
        descripcion: form.descripcion?.trim() || null,
        tipo:        form.tipo,
        categoria:   form.categoria,
        precio:      parseFloat(form.precio),
        ...(canSeeCosts ? { costo: parseFloat(form.costo) || 0 } : {}),
        stock:       form.tipo === 'VentaUnica' && form.stock !== '' ? parseInt(form.stock) : null,
        activo:      form.activo,
      }
      const r = await apiFetch(item ? `/api/catalogo/${item.id}` : '/api/catalogo', {
        method: item ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      })
      if (!r.ok) { const j = await r.json(); setErr(j.error ?? 'Error al guardar.'); return }
      toast.success(item ? 'Item actualizado.' : 'Item creado.')
      onSaved()
    } catch { setErr('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700/50 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 flex-shrink-0">
          <h2 className="text-sm font-bold text-slate-100">{item ? 'Editar Item del Catálogo' : 'Nuevo Item del Catálogo'}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <div>
            <label className={LABEL_CLS}>Nombre *</label>
            <input value={form.nombre} onChange={e => set('nombre', e.target.value)}
              placeholder="Ej. Plan WISP 25Mbps · Cámara Hikvision 4MP"
              className={INPUT_CLS} />
          </div>

          <div>
            <label className={LABEL_CLS}>Descripción</label>
            <textarea value={form.descripcion || ''} onChange={e => set('descripcion', e.target.value)} rows={2}
              placeholder="Detalles adicionales (opcional)"
              className={`${INPUT_CLS} resize-none`} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Tipo *</label>
              <select value={form.tipo} onChange={e => set('tipo', e.target.value)} className={SELECT_CLS}>
                {TIPOS.map(t => <option key={t} value={t}>{t === 'VentaUnica' ? 'Venta Única' : t}</option>)}
              </select>
              <p className="text-[10px] text-slate-600 mt-1 leading-tight">
                {form.tipo === 'Recurrente' ? 'Factura mensual automática' : form.tipo === 'VentaUnica' ? 'Factura única al entregar' : 'Mano de obra / visita técnica'}
              </p>
            </div>
            <div>
              <label className={LABEL_CLS}>Categoría *</label>
              <select value={form.categoria} onChange={e => set('categoria', e.target.value)} className={SELECT_CLS}>
                {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className={`grid gap-3 ${canSeeCosts ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <div>
              <label className={LABEL_CLS}>Precio (DOP) *</label>
              <input type="number" min="0" step="0.01" value={form.precio} onChange={e => set('precio', e.target.value)}
                placeholder="0.00" className={INPUT_CLS} />
            </div>
            {canSeeCosts && (
              <div>
                <label className={LABEL_CLS}>Costo (DOP)</label>
                <input type="number" min="0" step="0.01" value={form.costo} onChange={e => set('costo', e.target.value)}
                  placeholder="0.00" className={INPUT_CLS} />
              </div>
            )}
          </div>

          {form.tipo === 'VentaUnica' && (
            <div>
              <label className={LABEL_CLS}>Stock (unidades)</label>
              <input type="number" min="0" value={form.stock} onChange={e => set('stock', e.target.value)}
                placeholder="Dejar vacío si no aplica" className={INPUT_CLS} />
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-slate-400">Activo</span>
            <button type="button" onClick={() => set('activo', !form.activo)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.activo ? 'bg-blue-600' : 'bg-slate-700'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${form.activo ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {err && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />{err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-slate-400 hover:text-slate-100 text-sm font-medium transition-colors">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {item ? 'Guardar Cambios' : 'Crear Item'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── NCF Config ────────────────────────────────────────────────────────────────

function PanelNCF() {
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

// ── OT: Metadatos dinámicos ───────────────────────────────────────────────────

function MetadatosFields({ tipoOT, meta, onChange }) {
  const f = (k, v) => onChange({ ...meta, [k]: v })

  function Inp({ label, k, placeholder, type = 'text' }) {
    return (
      <div>
        <label className={LABEL_CLS}>{label}</label>
        <input type={type} value={meta[k] ?? ''} onChange={e => f(k, e.target.value)}
          placeholder={placeholder} className={INPUT_CLS} />
      </div>
    )
  }

  if (tipoOT === 'ISP') return (
    <div className="grid grid-cols-2 gap-3">
      <Inp label="IP Asignada"     k="ip"         placeholder="192.168.1.x" />
      <Inp label="MAC Address"     k="macAddress" placeholder="AA:BB:CC:DD:EE:FF" />
      <Inp label="Router / Equipo" k="router"     placeholder="MikroTik hAP ac2" />
      <Inp label="Día de Corte"    k="diaCorte"   placeholder="15" type="number" />
    </div>
  )

  if (tipoOT === 'CCTV') return (
    <div className="grid grid-cols-2 gap-3">
      <Inp label="Cantidad Cámaras" k="cantidadCamaras" placeholder="4" type="number" />
      <div>
        <label className={LABEL_CLS}>Tipo Grabación</label>
        <select value={meta.tipoGrabacion ?? 'NVR'} onChange={e => f('tipoGrabacion', e.target.value)} className={SELECT_CLS}>
          <option>NVR</option>
          <option>DVR</option>
        </select>
      </div>
      <Inp label="IP NVR / DVR" k="ipNVR" placeholder="192.168.1.100" />
    </div>
  )

  if (tipoOT === 'Reparacion') return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Inp label="Tipo de Equipo"   k="equipoTipo" placeholder="Laptop, PC, Router…" />
        <Inp label="Falla Reportada"  k="falla"      placeholder="No enciende, pantalla…" />
      </div>
      <div>
        <label className={LABEL_CLS}>Diagnóstico Técnico</label>
        <textarea value={meta.diagnostico ?? ''} onChange={e => f('diagnostico', e.target.value)} rows={2}
          placeholder="Diagnóstico al recibir el equipo…"
          className={`${INPUT_CLS} resize-none`} />
      </div>
    </div>
  )

  if (tipoOT === 'CercoElectrico') return (
    <div className="grid grid-cols-3 gap-3">
      <Inp label="Voltaje" k="voltaje" placeholder="5000V" />
      <Inp label="Zonas"   k="zonas"   placeholder="4" type="number" />
      <Inp label="Marca"   k="marca"   placeholder="Electrosur" />
    </div>
  )

  if (tipoOT === 'VentaDirecta') return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className={LABEL_CLS}>Método de Pago</label>
        <select value={meta.metodoPago ?? 'Efectivo'} onChange={e => f('metodoPago', e.target.value)} className={SELECT_CLS}>
          {['Efectivo', 'Transferencia', 'Tarjeta', 'Crédito'].map(m => <option key={m}>{m}</option>)}
        </select>
      </div>
      <Inp label="Entrega / Notas" k="entrega" placeholder="En tienda, a domicilio…" />
    </div>
  )

  return null
}

// ── OT: Buscador de cliente ───────────────────────────────────────────────────

function ClienteSearch({ onChange, initNombre }) {
  const [search,   setSearch]   = useState(initNombre ?? '')
  const [results,  setResults]  = useState([])
  const [selected, setSelected] = useState(!!initNombre)
  const [show,     setShow]     = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    if (selected || search.length < 2) { setResults([]); setShow(false); return }
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      apiFetch(`/api/clientes?search=${encodeURIComponent(search)}&activo=true&limit=8`)
        .then(r => r.ok ? r.json() : { data: [] })
        .then(j => { setResults(j.data ?? []); setShow(true) })
    }, 250)
  }, [search, selected])

  function select(c) {
    setSelected(true); setSearch(c.razonSocial); setShow(false); onChange(c.id)
  }
  function clear() {
    setSelected(false); setSearch(''); setResults([]); onChange('')
  }

  return (
    <div className="relative">
      <div className="relative">
        <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        <input value={search}
          onChange={e => { setSearch(e.target.value); if (selected) { setSelected(false); onChange('') } }}
          placeholder="Buscar cliente por nombre, RNC…"
          className="w-full pl-8 pr-8 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors" />
        {selected && (
          <button onClick={clear} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors">
            <X size={13} />
          </button>
        )}
      </div>
      {show && results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-600/50 rounded-lg shadow-2xl overflow-hidden">
          {results.map(c => (
            <button key={c.id} onClick={() => select(c)}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-700/80 transition-colors text-left border-b border-slate-700/40 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-100 truncate">{c.razonSocial}</p>
                <p className="text-[10px] text-slate-500 font-mono">{c.noCliente} · {c.tipoCliente}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── OT: Selector de líneas ────────────────────────────────────────────────────

function LineasPicker({ lineas, setLineas }) {
  const [catalog, setCatalog] = useState([])
  const [search,  setSearch]  = useState('')
  const [show,    setShow]    = useState(false)
  const dropRef = useRef(null)

  useEffect(() => {
    apiFetch('/api/catalogo?activo=true&limit=200')
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => setCatalog(j.data ?? []))
  }, [])

  useEffect(() => {
    function outside(e) { if (dropRef.current && !dropRef.current.contains(e.target)) setShow(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  function addItem(item) {
    if (lineas.find(l => l.itemCatalogoId === item.id)) { toast.info('Item ya agregado.'); return }
    setLineas(prev => [...prev, {
      itemCatalogoId: item.id,
      descripcion:    item.nombre,
      cantidad:       1,
      precioUnitario: Number(item.precio),
    }])
    setSearch(''); setShow(false)
  }

  function remove(i) { setLineas(prev => prev.filter((_, idx) => idx !== i)) }
  function upd(i, k, v) { setLineas(prev => prev.map((l, idx) => idx === i ? { ...l, [k]: v } : l)) }

  const filtered = catalog
    .filter(c => !search || c.nombre.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 10)

  const total = lineas.reduce((s, l) => s + Number(l.precioUnitario) * (Number(l.cantidad) || 1), 0)

  return (
    <div className="space-y-2">
      {lineas.length > 0 && (
        <div className="bg-slate-800/50 border border-slate-700/40 rounded-lg overflow-hidden">
          <div className="divide-y divide-slate-700/40">
            {lineas.map((l, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <input value={l.descripcion} onChange={e => upd(i, 'descripcion', e.target.value)}
                    className="w-full bg-transparent text-xs text-slate-200 focus:outline-none focus:underline decoration-slate-600 truncate" />
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <input type="number" min="1" value={l.cantidad}
                    onChange={e => upd(i, 'cantidad', parseInt(e.target.value) || 1)}
                    className="w-10 text-center bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 py-1 focus:outline-none focus:border-blue-500" />
                  <span className="text-[10px] text-slate-600">×</span>
                  <input type="number" min="0" step="0.01" value={l.precioUnitario}
                    onChange={e => upd(i, 'precioUnitario', parseFloat(e.target.value) || 0)}
                    className="w-20 text-right bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 py-1 px-1.5 font-mono focus:outline-none focus:border-blue-500" />
                  <button onClick={() => remove(i)} className="text-slate-600 hover:text-red-400 transition-colors ml-0.5">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-slate-700/50 bg-slate-800/40">
            <span className="text-[10px] text-slate-600 font-mono">{lineas.length} item{lineas.length !== 1 ? 's' : ''}</span>
            <div className="flex items-center gap-1">
              <DollarSign size={11} className="text-emerald-500" />
              <span className="text-xs font-mono font-bold text-emerald-400">{formatCurrency(total)}</span>
            </div>
          </div>
        </div>
      )}
      <div className="relative" ref={dropRef}>
        <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        <input value={search}
          onChange={e => { setSearch(e.target.value); setShow(true) }}
          onFocus={() => setShow(true)}
          placeholder="Agregar item del catálogo…"
          className="w-full pl-8 py-2 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-sm text-slate-400 placeholder-slate-600 focus:outline-none focus:border-blue-500 focus:text-slate-100 transition-colors" />
        {show && filtered.length > 0 && (
          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-600/50 rounded-lg shadow-2xl overflow-hidden max-h-48 overflow-y-auto">
            {filtered.map(item => (
              <button key={item.id} onMouseDown={() => addItem(item)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-700 transition-colors border-b border-slate-700/40 last:border-0">
                <div className="flex-1 min-w-0 text-left">
                  <span className="text-sm text-slate-200 truncate block">{item.nombre}</span>
                  <span className="text-[10px] text-slate-500">{item.categoria} · {item.tipo === 'VentaUnica' ? 'Venta Única' : item.tipo}</span>
                </div>
                <span className="text-xs font-mono text-emerald-400 flex-shrink-0">{formatCurrency(item.precio)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── OT: Modal nueva OT ────────────────────────────────────────────────────────

function NuevaOTModal({ onClose, onSaved, clienteIdInit, clienteNombreInit }) {
  const makeEmpty = () => ({
    clienteId:    clienteIdInit ?? '',
    tipoOT:       'ISP',
    tecnicoId:    '',
    estado:       'Pendiente',
    notasTecnicas:'',
    metadatos:    { ...META_DEFAULTS.ISP },
    lineas:       [],
  })
  const [form,     setForm]     = useState(makeEmpty)
  const [tecnicos, setTecs]     = useState([])
  const [saving,   setSaving]   = useState(false)
  const [err,      setErr]      = useState('')

  useEffect(() => {
    apiFetch('/api/empleados')
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => setTecs(j.data ?? []))
  }, [])

  function setTipoOT(tipo) {
    setForm(f => ({ ...f, tipoOT: tipo, metadatos: { ...(META_DEFAULTS[tipo] ?? {}) } }))
  }

  async function save() {
    if (!form.clienteId) return setErr('Selecciona un cliente.')
    if (!form.lineas.length) return setErr('Agrega al menos un item al servicio.')
    setSaving(true); setErr('')
    try {
      const body = {
        clienteId:    form.clienteId,
        tipoOT:       form.tipoOT,
        tecnicoId:    form.tecnicoId ? parseInt(form.tecnicoId) : null,
        estado:       form.estado,
        notasTecnicas: form.notasTecnicas || null,
        metadatos:    form.metadatos,
        lineas:       form.lineas.map(l => ({
          itemCatalogoId: l.itemCatalogoId,
          descripcion:    l.descripcion,
          cantidad:       Number(l.cantidad) || 1,
          precioUnitario: Number(l.precioUnitario) || 0,
        })),
      }
      const r = await apiFetch('/api/ordenes', { method: 'POST', body: JSON.stringify(body) })
      if (!r.ok) { const j = await r.json(); setErr(j.error ?? 'Error al crear la orden.'); return }
      toast.success('Orden de trabajo creada.')
      onSaved()
    } catch { setErr('Error de conexión.') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700/50 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <ClipboardList size={16} className="text-blue-400" />
            <h2 className="text-sm font-bold text-slate-100">Nueva Orden de Trabajo</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Cliente + Técnico */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Cliente *</label>
              <ClienteSearch
                initNombre={clienteNombreInit}
                onChange={id => setForm(f => ({ ...f, clienteId: id }))}
              />
            </div>
            <div>
              <label className={LABEL_CLS}>Técnico Asignado</label>
              <select value={form.tecnicoId}
                onChange={e => setForm(f => ({ ...f, tecnicoId: e.target.value }))}
                className={SELECT_CLS}>
                <option value="">Sin asignar</option>
                {tecnicos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
              </select>
            </div>
          </div>

          {/* Tipo OT + Estado */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Tipo de Orden *</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {TIPOS_OT.map(t => (
                  <button key={t} type="button" onClick={() => setTipoOT(t)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                      form.tipoOT === t
                        ? 'bg-blue-600 border-blue-500 text-white shadow-sm'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-100 hover:border-slate-600'
                    }`}>
                    {t === 'CercoElectrico' ? 'Cerco Eléc.' : t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={LABEL_CLS}>Estado</label>
              <select value={form.estado}
                onChange={e => setForm(f => ({ ...f, estado: e.target.value }))}
                className={SELECT_CLS}>
                {ESTADOS_OT.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </div>

          {/* Metadatos dinámicos */}
          {form.tipoOT !== 'General' && (
            <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
                Datos Técnicos · {form.tipoOT === 'CercoElectrico' ? 'Cerco Eléctrico' : form.tipoOT}
              </p>
              <MetadatosFields
                tipoOT={form.tipoOT}
                meta={form.metadatos}
                onChange={m => setForm(f => ({ ...f, metadatos: m }))}
              />
            </div>
          )}

          {/* Líneas de servicio */}
          <div>
            <label className={LABEL_CLS}>Servicios / Items *</label>
            <div className="mt-1.5">
              <LineasPicker
                lineas={form.lineas}
                setLineas={lineas => setForm(f => ({ ...f, lineas }))}
              />
            </div>
          </div>

          {/* Notas */}
          <div>
            <label className={LABEL_CLS}>Notas Técnicas</label>
            <textarea value={form.notasTecnicas}
              onChange={e => setForm(f => ({ ...f, notasTecnicas: e.target.value }))}
              rows={2} placeholder="Observaciones adicionales…"
              className={`${INPUT_CLS} resize-none`} />
          </div>

          {err && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />{err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-slate-400 hover:text-slate-100 text-sm font-medium transition-colors">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50 shadow-lg shadow-blue-600/20">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Crear Orden
          </button>
        </div>
      </div>
    </div>
  )
}

// ── OT: Panel principal ───────────────────────────────────────────────────────

function PanelOrdenes({ canEdit, clienteIdInit, clienteNombreInit }) {
  const [ordenes,       setOrdenes]       = useState([])
  const [loading,       setLoading]       = useState(false)
  const [showModal,     setShowModal]     = useState(!!clienteIdInit)
  const [filtroEstado,  setFiltroEstado]  = useState('')
  const [filtroTipo,    setFiltroTipo]    = useState('')

  const fetchOrdenes = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroEstado) p.set('estado', filtroEstado)
      if (filtroTipo)   p.set('tipoOT',  filtroTipo)
      const r = await apiFetch(`/api/ordenes?${p}`)
      if (r.ok) { const j = await r.json(); setOrdenes(j.data ?? []) }
    } catch {}
    finally { setLoading(false) }
  }, [filtroEstado, filtroTipo])

  useEffect(() => { fetchOrdenes() }, [fetchOrdenes])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex gap-2 flex-wrap">
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos los estados</option>
            {ESTADOS_OT.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
            <option value="">Todos los tipos</option>
            {TIPOS_OT.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={fetchOrdenes}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {canEdit && (
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap">
            <Plus size={16} />Nueva OT
          </button>
        )}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className={TH}>Cliente</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Técnico</th>
                <th className={TH}>Estado</th>
                <th className={TH}>Items</th>
                <th className={TH}>Total</th>
                <th className={TH}>Fecha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={7} className="text-center py-12">
                  <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                </td></tr>
              ) : ordenes.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-slate-500 text-xs font-mono">
                  No hay órdenes de trabajo.
                </td></tr>
              ) : ordenes.map(ot => {
                const total = ot.lineas?.reduce((s, l) => s + Number(l.precioUnitario) * (l.cantidad ?? 1), 0) ?? 0
                return (
                  <tr key={ot.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-100 truncate max-w-[180px]">
                        {ot.cliente?.razonSocial ?? '—'}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">{ot.cliente?.noCliente}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><OtTipoBadge tipo={ot.tipoOT} /></td>
                    <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                      {ot.tecnico?.nombre ?? <span className="text-slate-700 font-mono">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><OtEstadoBadge estado={ot.estado} /></td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-400 whitespace-nowrap">
                      {ot.lineas?.length ?? 0}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-emerald-400 whitespace-nowrap">
                      {formatCurrency(total)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {formatDate(ot.createdAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-700/50">
          <p className="text-xs text-slate-600 font-mono">
            {ordenes.length} orden{ordenes.length !== 1 ? 'es' : ''}
          </p>
        </div>
      </div>

      {showModal && (
        <NuevaOTModal
          clienteIdInit={clienteIdInit}
          clienteNombreInit={clienteNombreInit}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); fetchOrdenes() }}
        />
      )}
    </div>
  )
}

// ── Main Ventas Page ──────────────────────────────────────────────────────────

export default function Ventas() {
  const [searchParams] = useSearchParams()
  const { tienePermiso } = useAuth()
  const canEdit     = tienePermiso('catalogo:editar')
  const canSeeCosts = tienePermiso('catalogo:ver_costos')

  const clienteIdInit     = searchParams.get('cliente') ?? ''
  const clienteNombreInit = searchParams.get('nombre')  ?? ''

  const [tab,             setTab]             = useState(clienteIdInit ? 'ordenes' : 'catalogo')
  const [items,           setItems]           = useState([])
  const [loading,         setLoading]         = useState(false)
  const [search,          setSearch]          = useState('')
  const [filtroTipo,      setFiltroTipo]      = useState('')
  const [filtroCategoria, setFiltroCategoria] = useState('')
  const [filtroActivo,    setFiltroActivo]    = useState('true')
  const [modalItem,       setModalItem]       = useState(null)

  const fetchCatalogo = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroTipo)      p.set('tipo',      filtroTipo)
      if (filtroCategoria) p.set('categoria', filtroCategoria)
      if (filtroActivo)    p.set('activo',    filtroActivo)
      if (search)          p.set('search',    search)
      const r = await apiFetch(`/api/catalogo?${p}`)
      if (r.ok) { const j = await r.json(); setItems(j.data ?? []) }
    } catch {}
    finally { setLoading(false) }
  }, [filtroTipo, filtroCategoria, filtroActivo, search])

  useEffect(() => {
    if (tab === 'catalogo') fetchCatalogo()
  }, [tab, fetchCatalogo])

  async function toggleActivo(item) {
    try {
      const r = await apiFetch(`/api/catalogo/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...item, precio: Number(item.precio), costo: Number(item.costo) || 0, activo: !item.activo }),
      })
      if (r.ok) { toast.success(`Item ${!item.activo ? 'activado' : 'desactivado'}.`); fetchCatalogo() }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
  }

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight">Ventas & Servicios</h1>
          <p className="text-sm text-slate-500 mt-0.5">Catálogo Universal · Órdenes de Trabajo · Facturación NCF</p>
        </div>
        {tab === 'catalogo' && (
          <button onClick={fetchCatalogo} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-800/50 rounded-xl p-1 w-fit border border-slate-700/50 flex-wrap">
        {[
          { key: 'catalogo', label: 'Catálogo',   Icon: Package       },
          { key: 'ordenes',  label: 'Órdenes',    Icon: ClipboardList  },
          { key: 'facturas', label: 'Facturas',   Icon: FileText       },
          { key: 'ncf',      label: 'Config NCF', Icon: Settings2      },
        ].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === key ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {/* ── Catálogo ───────────────────────────────────────────────────────────── */}
      {tab === 'catalogo' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..."
                  className="pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-40 transition-colors" />
              </div>
              <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
                <option value="">Todos los tipos</option>
                {TIPOS.map(t => <option key={t} value={t}>{t === 'VentaUnica' ? 'Venta Única' : t}</option>)}
              </select>
              <select value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
                <option value="">Todas las categorías</option>
                {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filtroActivo} onChange={e => setFiltroActivo(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors">
                <option value="">Todos</option>
                <option value="true">Activos</option>
                <option value="false">Inactivos</option>
              </select>
            </div>
            {canEdit && (
              <button onClick={() => setModalItem(false)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap">
                <Plus size={16} />Nuevo Item
              </button>
            )}
          </div>

          <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/70 bg-slate-800/60">
                    <th className={TH}>Nombre</th>
                    <th className={TH}>Tipo</th>
                    <th className={TH}>Categoría</th>
                    <th className={TH}>Precio</th>
                    {canSeeCosts && <th className={TH}>Costo</th>}
                    {canSeeCosts && <th className={TH}>Margen</th>}
                    <th className={TH}>Stock</th>
                    <th className={TH}>Estado</th>
                    {canEdit && <th className="px-4 py-3" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {loading ? (
                    <tr><td colSpan={6 + (canSeeCosts ? 2 : 0) + (canEdit ? 1 : 0)} className="text-center py-12">
                      <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                    </td></tr>
                  ) : items.length === 0 ? (
                    <tr><td colSpan={6 + (canSeeCosts ? 2 : 0) + (canEdit ? 1 : 0)} className="text-center py-12 text-slate-500 text-xs font-mono">
                      No hay items en el catálogo.
                    </td></tr>
                  ) : items.map(item => {
                    const precio = Number(item.precio)
                    const costo  = Number(item.costo)
                    const margen = precio > 0 ? Math.round(((precio - costo) / precio) * 100) : 0
                    return (
                      <tr key={item.id} className="hover:bg-slate-800/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-100 whitespace-nowrap">{item.nombre}</div>
                          {item.descripcion && (
                            <div className="text-xs text-slate-500 truncate max-w-[220px] mt-0.5">{item.descripcion}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap"><TipoBadge tipo={item.tipo} /></td>
                        <td className="px-4 py-3 whitespace-nowrap"><CatBadge cat={item.categoria} /></td>
                        <td className="px-4 py-3 font-mono text-sm text-emerald-400 whitespace-nowrap">{formatCurrency(precio)}</td>
                        {canSeeCosts && <td className="px-4 py-3 font-mono text-sm text-slate-500 whitespace-nowrap">{formatCurrency(costo)}</td>}
                        {canSeeCosts && (
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className={`text-xs font-mono font-bold ${margen >= 30 ? 'text-emerald-400' : margen >= 10 ? 'text-amber-400' : 'text-red-400'}`}>
                              {margen}%
                            </span>
                          </td>
                        )}
                        <td className="px-4 py-3 text-xs font-mono whitespace-nowrap">
                          {item.stock != null
                            ? <span className={item.stock <= 0 ? 'text-red-400 font-semibold' : 'text-slate-300'}>{item.stock}</span>
                            : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {item.activo
                            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"><CheckCircle size={11} />Activo</span>
                            : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-500 border border-slate-500/30"><XCircle size={11} />Inactivo</span>
                          }
                        </td>
                        {canEdit && (
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <div className="flex items-center gap-1.5 justify-end">
                              <button onClick={() => setModalItem(item)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700/60 hover:bg-slate-600/60 border border-slate-600/50 text-slate-300 hover:text-white text-xs font-medium transition-all">
                                <Pencil size={12} />Editar
                              </button>
                              <button onClick={() => toggleActivo(item)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                                  item.activo
                                    ? 'bg-slate-700/40 hover:bg-red-900/20 border-slate-600/40 hover:border-red-700/30 text-slate-500 hover:text-red-400'
                                    : 'bg-emerald-600/10 hover:bg-emerald-600/20 border-emerald-600/20 hover:border-emerald-600/40 text-emerald-600 hover:text-emerald-400'
                                }`}>
                                {item.activo ? <XCircle size={12} /> : <CheckCircle size={12} />}
                                {item.activo ? 'Desactivar' : 'Activar'}
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 border-t border-slate-700/50 flex items-center justify-between">
              <p className="text-xs text-slate-600 font-mono">{items.length} item{items.length !== 1 ? 's' : ''}</p>
              {canSeeCosts && <p className="text-[10px] text-slate-700 font-mono">Margen: verde ≥30% · ámbar ≥10% · rojo &lt;10%</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── Órdenes de Trabajo ─────────────────────────────────────────────────── */}
      {tab === 'ordenes' && (
        <PanelOrdenes
          canEdit={canEdit}
          clienteIdInit={clienteIdInit}
          clienteNombreInit={clienteNombreInit}
        />
      )}

      {/* ── Facturas (stub) ────────────────────────────────────────────────────── */}
      {tab === 'facturas' && (
        <ComingSoon title="Facturación" desc="NCF · ITBIS 18% · DGII · Recurrente vs Única" />
      )}

      {/* ── Config NCF ─────────────────────────────────────────────────────────── */}
      {tab === 'ncf' && <PanelNCF />}

      {/* Modal catálogo */}
      {modalItem !== null && (
        <ItemModal
          item={modalItem === false ? null : modalItem}
          canSeeCosts={canSeeCosts}
          onClose={() => setModalItem(null)}
          onSaved={() => { setModalItem(null); fetchCatalogo() }}
        />
      )}
    </div>
  )
}
