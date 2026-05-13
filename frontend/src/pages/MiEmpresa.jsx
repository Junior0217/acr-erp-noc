import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import {
  Building2, FileText, Phone, MapPin, User, Save, Loader2, ShieldCheck,
  Image as ImageIcon, AlertTriangle, ShieldOff, Stamp, PenTool, Lock, Upload, X, Trash2,
  ScrollText,
} from 'lucide-react'
import { apiFetch } from '../utils/api'
import { useEmpresa } from '../contexts/EmpresaContext'
import { useAuth } from '../contexts/AuthContext'

const API = import.meta.env.VITE_API_URL || ''

const INPUT    = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500'
const LABEL    = 'block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1'
const READONLY = 'w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-400 cursor-not-allowed select-none'

const TEXT_SECTIONS = [
  { id: 'legal',     title: 'Datos Legales',  Icon: FileText, fields: ['rnc','razonSocial','nombreComercial','registroMercantil','tipoEmpresa','fechaInicio','eslogan'] },
  { id: 'represent', title: 'Representante',  Icon: User,     fields: ['representanteNombre','representanteApellido','representanteCedula','representanteCargo'] },
  { id: 'contacto',  title: 'Contacto',       Icon: Phone,    fields: ['telefono','fax','email','website'] },
  { id: 'direccion', title: 'Dirección',      Icon: MapPin,   fields: ['direccion','sector','provincia','pais'] },
]

const LABELS = {
  rnc: 'RNC', razonSocial: 'Razón Social', nombreComercial: 'Nombre Comercial', registroMercantil: 'Registro Mercantil',
  tipoEmpresa: 'Tipo de Empresa', fechaInicio: 'Fecha de Inicio', eslogan: 'Eslogan corporativo',
  representanteNombre: 'Nombre', representanteApellido: 'Apellido', representanteCedula: 'Cédula', representanteCargo: 'Cargo',
  telefono: 'Teléfono(s)', fax: 'Fax', email: 'Email', website: 'Sitio Web',
  direccion: 'Dirección', sector: 'Sector', provincia: 'Provincia', pais: 'País',
}

const PLACEHOLDERS = {
  rnc: '133692678', razonSocial: 'ACR Networks & Solutions, S.R.L.',
  registroMercantil: '220982SD', telefono: '849-458-9955 / 809-670-9956',
  email: 'contacto@empresa.do', website: 'https://acrnetworks.do',
}

const ASSETS = [
  { key: 'logoClaro',    label: 'Logo Claro',    desc: 'PNG/SVG sobre fondo blanco — facturas y PDFs',           Icon: ImageIcon },
  { key: 'logoOscuro',   label: 'Logo Oscuro',   desc: 'Variante para fondos oscuros — sidebar y portal noche', Icon: ImageIcon },
  { key: 'selloFisico',  label: 'Sello Físico',  desc: 'Sello escaneado (PNG transparente) — pie de PDF',         Icon: Stamp     },
  { key: 'firmaGerente', label: 'Firma Gerente', desc: 'Firma escaneada (PNG transparente) — sobre línea de firma', Icon: PenTool   },
]

export default function MiEmpresa() {
  const { tienePermiso } = useAuth()
  const { empresa, hasFull, refresh } = useEmpresa()
  const [form, setForm]   = useState(empresa)
  const [busy, setBusy]   = useState(false)
  const [dirty, setDirty] = useState(false)

  const canView = tienePermiso('empresa:ver') || tienePermiso('sistema:admin')
  const canEdit = tienePermiso('empresa:editar')

  useEffect(() => { setForm(empresa); setDirty(false) }, [empresa])

  if (!canView) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
      <ShieldOff size={32} />
      <p className="text-sm font-medium">Sin acceso al módulo Mi Empresa</p>
      <p className="text-xs text-slate-600">Requiere permiso <code>empresa:ver</code></p>
    </div>
  )

  function setField(k) {
    return e => { setForm(f => ({ ...f, [k]: e.target.value })); setDirty(true) }
  }
  function setAsset(k) {
    return e => { setForm(f => ({ ...f, assets: { ...(f.assets ?? {}), [k]: e.target.value } })); setDirty(true) }
  }

  async function guardar(e) {
    e.preventDefault()
    if (!canEdit) { toast.error('No tienes permiso empresa:editar.'); return }
    setBusy(true)
    try {
      const payload = { ...form }
      if (payload.fechaInicio === '' || payload.fechaInicio == null) delete payload.fechaInicio
      // Sólo envía las URLs que el user editó (preservar nulls del DB)
      if (payload.assets) {
        const filteredAssets = {}
        for (const k of ['logoClaro','logoOscuro','selloFisico','firmaGerente']) {
          if (payload.assets[k] !== undefined) filteredAssets[k] = payload.assets[k] || null
        }
        payload.assets = filteredAssets
      }
      const r = await apiFetch('/api/configuracion/empresa', { method: 'PATCH', body: JSON.stringify(payload) })
      const j = await r.json()
      if (r.ok) {
        toast.success('Perfil de empresa actualizado')
        await refresh(true)
        setDirty(false)
      } else {
        toast.error(j.error ?? 'Error al guardar.')
      }
    } catch { toast.error('Error de red.') }
    finally { setBusy(false) }
  }

  function renderField(field) {
    const isDate = field === 'fechaInicio'
    const val = form[field] ?? ''
    const inputType = isDate ? 'date' : field === 'email' ? 'email' : field === 'website' ? 'url' : 'text'
    const value = isDate && val ? new Date(val).toISOString().slice(0, 10) : val
    return (
      <div key={field}>
        <label className={LABEL}>{LABELS[field]}</label>
        {canEdit ? (
          <input type={inputType} value={value} onChange={setField(field)}
            placeholder={PLACEHOLDERS[field] ?? ''} className={INPUT} />
        ) : (
          <div className={READONLY}>{val || <span className="text-slate-700 italic">—</span>}</div>
        )}
      </div>
    )
  }

  function renderAsset(asset) {
    return (
      <AssetUploader
        key={asset.key}
        kind={asset.key}
        label={asset.label}
        desc={asset.desc}
        Icon={asset.Icon}
        url={form.assets?.[asset.key] ?? ''}
        canEdit={canEdit}
        // El upload sólo sube a Storage y devuelve URL. La URL se persiste
        // a BD recién cuando se envía el form completo (botón "Guardar cambios").
        onUpdated={(url) => {
          setForm(f => ({ ...f, assets: { ...(f.assets ?? {}), [asset.key]: url } }))
          setDirty(true)
        }}
      />
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6">
      <form onSubmit={guardar} className="space-y-5 max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-violet-500/10 border border-violet-500/30 rounded-lg">
              <Building2 size={22} className="text-violet-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Mi Empresa</h1>
              <p className="text-xs text-slate-500 mt-0.5">Identidad legal · contacto · multimedia (logos, sello, firma)</p>
            </div>
          </div>
          {canEdit ? (
            <button type="submit" disabled={!dirty || busy}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40 shadow-lg shadow-blue-600/20">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Guardar cambios
            </button>
          ) : (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
              <Lock size={13} />Solo lectura · pide <code className="font-mono">empresa:editar</code>
            </div>
          )}
        </div>

        {!hasFull && (
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 text-xs text-slate-400 flex items-start gap-2">
            <ShieldCheck size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
            <div>Cargando perfil completo. Si el endpoint público falla, se muestra el último snapshot conocido.</div>
          </div>
        )}

        {TEXT_SECTIONS.map(s => {
          const Icon = s.Icon
          return (
            <section key={s.id} className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
                <Icon size={15} className="text-blue-400" />
                <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest">{s.title}</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{s.fields.map(renderField)}</div>
            </section>
          )
        })}

        <section className="bg-slate-800/40 border border-violet-500/30 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
            <ImageIcon size={15} className="text-violet-400" />
            <h3 className="text-xs font-bold text-violet-400 uppercase tracking-widest">Multimedia (Assets JSON)</h3>
            <span className="ml-auto text-[10px] text-slate-500">Sube directo · PNG/JPG/SVG · max 2MB</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{ASSETS.map(renderAsset)}</div>
        </section>

        <section className="bg-slate-800/40 border border-amber-700/30 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
            <Lock size={15} className="text-amber-400" />
            <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest">PIN de Supervisor (POS)</h3>
            <span className="ml-auto text-[10px] text-slate-500">Requerido para descuentos &gt; 15%</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>PIN (4–8 dígitos)</label>
              {canEdit ? (
                <input type="password" inputMode="numeric" autoComplete="off" maxLength={8}
                  value={form.pinSupervisor ?? ''}
                  onChange={e => { setForm(f => ({ ...f, pinSupervisor: e.target.value.replace(/\D/g, '') })); setDirty(true) }}
                  placeholder="••••"
                  className={INPUT + ' font-mono tracking-[0.4em] text-center'} />
              ) : (
                <div className={READONLY + ' font-mono tracking-[0.4em] text-center'}>{'•'.repeat((form.pinSupervisor ?? '').length || 4)}</div>
              )}
              <p className="text-[10px] text-slate-600 mt-1">El cajero deberá ingresarlo si aplica un descuento global mayor al 15% en el POS.</p>
            </div>
          </div>
        </section>

        <section className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
            <ScrollText size={15} className="text-blue-400" />
            <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest">Condiciones Comerciales por Defecto</h3>
            <span className="ml-auto text-[10px] text-slate-500">Aparecen en PDFs · pueden sobrescribirse por documento</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {['validez','pago','entrega','garantia'].map(k => (
              <div key={k}>
                <label className={LABEL}>{k}</label>
                {canEdit ? (
                  <input type="text" maxLength={280}
                    value={form.condicionesDefault?.[k] ?? ''}
                    onChange={e => { setForm(f => ({ ...f, condicionesDefault: { ...(f.condicionesDefault ?? {}), [k]: e.target.value } })); setDirty(true) }}
                    placeholder={k === 'validez' ? '15 días calendario desde la emisión.' :
                                 k === 'pago'    ? '50% al iniciar · 50% contra entrega.' :
                                 k === 'entrega' ? '5 a 10 días laborables tras anticipo.' :
                                                   '1 año sobre instalación.'}
                    className={INPUT} />
                ) : (
                  <div className={READONLY}>{form.condicionesDefault?.[k] || <span className="text-slate-700 italic">—</span>}</div>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="text-xs text-slate-600 text-center pt-4 border-t border-slate-800">
          Singleton ID=1 · cualquier cambio afecta facturas, cotizaciones y portal B2C en tiempo real
        </div>
      </form>
    </div>
  )
}

function AssetUploader({ kind, label, desc, Icon, url, canEdit, onUpdated }) {
  const inputRef = useRef(null)
  const [busy, setBusy]       = useState(false)
  const [preview, setPreview] = useState(null)
  const [error, setError]     = useState(null)

  async function handleFile(file) {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Archivo excede 2MB.')
      return
    }
    const validMimes = ['image/png','image/jpeg','image/svg+xml','image/gif','image/webp']
    if (!validMimes.includes(file.type) && file.type !== '') {
      toast.error(`Tipo no soportado: ${file.type}. Usa PNG, JPG o SVG.`)
      return
    }
    // Preview local inmediato (data URL)
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target.result)
    reader.readAsDataURL(file)

    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      // apiFetch detecta FormData → omite Content-Type pero conserva X-CSRF-Token + cookie credentials
      const r = await apiFetch('/api/configuracion/empresa/upload', { method: 'POST', body: fd })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.url) {
        toast.success(`${label} listo · pulsa Guardar para aplicar`)
        onUpdated?.(j.url)
        setPreview(null)
      } else {
        const msg = j.error ?? 'Error al subir.'
        setError(msg)
        toast.error(msg)
        setPreview(null)
      }
    } catch (e) {
      setError('Error de red.')
      toast.error('Error de red.')
      setPreview(null)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  // Quitar no toca BD: sólo marca el asset como null en el form padre.
  // El borrado real ocurre al pulsar "Guardar cambios" (PATCH /api/configuracion/empresa),
  // y el orphan-cleanup en Storage corre fire-and-forget en el backend.
  function quitar() {
    if (!canEdit) return
    onUpdated?.(null)
    setPreview(null)
    toast.message(`${label} marcado para quitar · pulsa Guardar para aplicar`)
  }

  const displayUrl = preview ?? url

  return (
    <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4">
      <div className="flex items-start gap-3 mb-3">
        <Icon size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-slate-200">{label}</p>
          <p className="text-[10px] text-slate-500 leading-snug mt-0.5">{desc}</p>
        </div>
        {displayUrl && (
          <img
            src={displayUrl}
            alt=""
            className="h-14 w-auto max-w-[80px] object-contain bg-white rounded border border-slate-700 p-1"
            onError={e => { e.currentTarget.style.display = 'none' }}
          />
        )}
      </div>

      {!canEdit ? (
        <div className="text-[10px] text-slate-600 italic px-2 py-1.5 bg-slate-900/50 rounded border border-slate-800">
          {url ? 'Asset configurado' : 'Sin asignar'} · Solo lectura
        </div>
      ) : (
        <div className="space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp"
            onChange={e => handleFile(e.target.files?.[0])}
            disabled={busy}
            className="hidden"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 border border-blue-600/30 text-blue-300 text-xs font-semibold disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {busy ? 'Subiendo...' : (url ? 'Reemplazar' : 'Subir archivo')}
            </button>
            {url && !busy && (
              <button
                type="button"
                onClick={quitar}
                className="px-3 py-2 rounded-lg bg-red-600/15 hover:bg-red-600/25 border border-red-600/30 text-red-300 text-xs"
                title="Quitar este asset"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
          {error && <p className="text-[10px] text-red-400">{error}</p>}
          {url && (
            <p className="text-[9.5px] text-slate-600 font-mono truncate" title={url}>{url}</p>
          )}
        </div>
      )}
    </div>
  )
}
