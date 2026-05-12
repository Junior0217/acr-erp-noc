import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Building2, FileText, Phone, MapPin, User, Save, Loader2, ShieldCheck, Globe, Image as ImageIcon, AlertTriangle,
} from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useEmpresa } from '../../contexts/EmpresaContext'
import { useAuth } from '../../contexts/AuthContext'

const INPUT  = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500'
const LABEL  = 'block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1'
const READONLY = 'w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-400 cursor-not-allowed select-none'

const SECTIONS = [
  { id: 'legal',     title: 'Datos Legales',     Icon: FileText, fields: ['rnc','razonSocial','nombreComercial','registroMercantil','tipoEmpresa','fechaInicio'] },
  { id: 'represent', title: 'Representante',     Icon: User,     fields: ['representanteNombre','representanteApellido','representanteCedula','representanteCargo'] },
  { id: 'contacto',  title: 'Contacto',          Icon: Phone,    fields: ['telefono','fax','email','website'] },
  { id: 'direccion', title: 'Dirección',         Icon: MapPin,   fields: ['direccion','sector','provincia','pais'] },
  { id: 'visual',    title: 'Identidad Visual',  Icon: ImageIcon,fields: ['logoUrl','eslogan'] },
]

const LABELS = {
  rnc:                   'RNC',
  razonSocial:           'Razón Social',
  nombreComercial:       'Nombre Comercial',
  registroMercantil:     'Registro Mercantil',
  tipoEmpresa:           'Tipo de Empresa',
  fechaInicio:           'Fecha de Inicio',
  representanteNombre:   'Nombre',
  representanteApellido: 'Apellido',
  representanteCedula:   'Cédula',
  representanteCargo:    'Cargo',
  telefono:              'Teléfono',
  fax:                   'Fax',
  email:                 'Email',
  website:               'Sitio Web',
  direccion:             'Dirección',
  sector:                'Sector',
  provincia:             'Provincia',
  pais:                  'País',
  logoUrl:               'URL Logo (PNG/SVG)',
  eslogan:               'Eslogan corporativo',
}

const PLACEHOLDERS = {
  rnc:               '133-69267-8',
  razonSocial:       'ACR Networks & Solutions, S.R.L.',
  registroMercantil: '161830SD',
  telefono:          '849-458-9955',
  email:             'contacto@empresa.do',
  website:           'https://acrnetworks.do',
}

export default function PanelMiEmpresa() {
  const { tienePermiso, user } = useAuth()
  const { empresa, hasFull, refresh } = useEmpresa()
  const [form, setForm]       = useState(empresa)
  const [busy, setBusy]       = useState(false)
  const [dirty, setDirty]     = useState(false)

  const isOwner = tienePermiso('sistema:owner')

  useEffect(() => { setForm(empresa); setDirty(false) }, [empresa])

  function set(k) {
    return e => { setForm(f => ({ ...f, [k]: e.target.value })); setDirty(true) }
  }

  async function guardar(e) {
    e.preventDefault()
    if (!isOwner) { toast.error('Solo el Propietario Absoluto puede modificar este perfil.'); return }
    setBusy(true)
    try {
      const payload = { ...form }
      if (payload.fechaInicio === '' || payload.fechaInicio == null) delete payload.fechaInicio
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
    const inputType = isDate ? 'date' : field === 'email' ? 'email' : field === 'website' || field === 'logoUrl' ? 'url' : 'text'
    const value = isDate && val ? new Date(val).toISOString().slice(0, 10) : val
    return (
      <div key={field}>
        <label className={LABEL}>{LABELS[field]}</label>
        {isOwner ? (
          <input
            type={inputType}
            value={value}
            onChange={set(field)}
            placeholder={PLACEHOLDERS[field] ?? ''}
            className={INPUT}
          />
        ) : (
          <div className={READONLY}>{val || <span className="text-slate-700 italic">—</span>}</div>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={guardar} className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Building2 size={20} className="text-blue-400" />
          <div>
            <h2 className="text-lg font-bold text-slate-100">Mi Empresa</h2>
            <p className="text-xs text-slate-500">Datos legales y de contacto · sirve de base para facturas, cotizaciones y portal</p>
          </div>
        </div>
        {isOwner ? (
          <button type="submit" disabled={!dirty || busy}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Guardar cambios
          </button>
        ) : (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
            <AlertTriangle size={13} />Lectura solamente (Propietario Absoluto edita)
          </div>
        )}
      </div>

      {!hasFull && (
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 text-xs text-slate-400 flex items-start gap-2">
          <ShieldCheck size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
          <div>
            Cargando perfil público. Si eres Propietario Absoluto, recarga para ver datos completos del representante.
          </div>
        </div>
      )}

      {SECTIONS.map(s => {
        const Icon = s.Icon
        return (
          <section key={s.id} className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
              <Icon size={15} className="text-blue-400" />
              <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest">{s.title}</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {s.fields.map(renderField)}
            </div>
          </section>
        )
      })}
    </form>
  )
}
