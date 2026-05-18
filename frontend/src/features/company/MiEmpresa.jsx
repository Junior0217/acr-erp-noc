import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Building2, FileText, Phone, MapPin, User, Save, Loader2, ShieldCheck,
  Image as ImageIcon, ShieldOff, Stamp, PenTool, Lock, Upload, Trash2,
  ScrollText, ShieldAlert, Hash, TrendingUp, ShoppingCart, Package,
  Landmark, Users, BookUser, AlertTriangle, AlertCircle, CheckCircle,
  RefreshCw, Wand2, Plus, Construction,
} from 'lucide-react'
import { apiFetch } from '@shared/utils/api'
import { useEmpresa } from '@shared/contexts/EmpresaContext'
import { useAuth } from '@shared/contexts/AuthContext'

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

const TABS = [
  { id: 'legales',     label: 'Datos Legales y Contacto', short: 'Legales',    Icon: FileText,     color: 'blue'    },
  { id: 'multimedia',  label: 'Multimedia',                short: 'Multimedia', Icon: ImageIcon,    color: 'violet'  },
  { id: 'seguridad',   label: 'Seguridad y Permisos',      short: 'Seguridad',  Icon: ShieldAlert,  color: 'amber'   },
  { id: 'comerciales', label: 'Condiciones Comerciales',   short: 'Condiciones',Icon: ScrollText,   color: 'blue'    },
  { id: 'ncf',         label: 'Secuencias y NCF',          short: 'NCF',        Icon: Hash,         color: 'emerald' },
  { id: 'ventas',      label: 'Ventas',                    short: 'Ventas',     Icon: TrendingUp,   color: 'blue'    },
  { id: 'compras',     label: 'Compras',                   short: 'Compras',    Icon: ShoppingCart, color: 'amber'   },
  { id: 'inventario',  label: 'Inventario',                short: 'Inventario', Icon: Package,      color: 'violet'  },
  { id: 'bancos',      label: 'Bancos',                    short: 'Bancos',     Icon: Landmark,     color: 'emerald' },
  { id: 'nomina',      label: 'Nómina',                    short: 'Nómina',     Icon: Users,        color: 'blue'    },
  { id: 'contactos',   label: 'Contactos',                 short: 'Contactos',  Icon: BookUser,     color: 'amber'   },
]

const TAB_COLORS = {
  blue:    { active: 'bg-blue-600/15 border-blue-500/40 text-blue-300',       idle: 'border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600' },
  violet:  { active: 'bg-violet-600/15 border-violet-500/40 text-violet-300', idle: 'border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600' },
  amber:   { active: 'bg-amber-600/15 border-amber-500/40 text-amber-300',    idle: 'border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600' },
  emerald: { active: 'bg-emerald-600/15 border-emerald-500/40 text-emerald-300', idle: 'border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600' },
}

const TABS_GLOBAL_SAVE = new Set(['legales', 'multimedia', 'seguridad', 'comerciales'])

export default function MiEmpresa() {
  const { tienePermiso } = useAuth()
  const { empresa, hasFull, refresh } = useEmpresa()
  const [form, setForm]   = useState(empresa)
  const [busy, setBusy]   = useState(false)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab]     = useState('legales')

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

  async function guardar(e) {
    if (e?.preventDefault) e.preventDefault()
    if (!canEdit) { toast.error('No tienes permiso empresa:editar.'); return }
    if (!TABS_GLOBAL_SAVE.has(tab)) return
    setBusy(true)
    try {
      const payload = { ...form }
      if (payload.fechaInicio === '' || payload.fechaInicio == null) delete payload.fechaInicio
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
        onUpdated={(url) => {
          setForm(f => ({ ...f, assets: { ...(f.assets ?? {}), [asset.key]: url } }))
          setDirty(true)
        }}
      />
    )
  }

  const showGlobalSave = TABS_GLOBAL_SAVE.has(tab)

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-6">
      <form onSubmit={guardar} className="space-y-5 max-w-6xl mx-auto">

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-violet-500/10 border border-violet-500/30 rounded-lg">
              <Building2 size={22} className="text-violet-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Mi Empresa</h1>
              <p className="text-xs text-slate-500 mt-0.5">Hub central · identidad · multimedia · seguridad · NCF · ventas · compras · inventario · bancos · nómina · contactos</p>
            </div>
          </div>
          {canEdit && showGlobalSave ? (
            <button type="submit" disabled={!dirty || busy}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40 shadow-lg shadow-blue-600/20">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Guardar cambios
            </button>
          ) : !canEdit ? (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
              <Lock size={13} />Solo lectura · pide <code className="font-mono">empresa:editar</code>
            </div>
          ) : null}
        </div>

        {!hasFull && (
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 text-xs text-slate-400 flex items-start gap-2">
            <ShieldCheck size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
            <div>Cargando perfil completo. Si el endpoint público falla, se muestra el último snapshot conocido.</div>
          </div>
        )}

        <nav className="sticky top-0 z-10 -mx-4 md:mx-0 px-4 md:px-0 py-2 bg-slate-900/95 backdrop-blur border-b border-slate-800 md:border-0 md:bg-transparent md:backdrop-blur-0 md:py-0">
          <div className="flex flex-wrap gap-2">
            {TABS.map(t => {
              const Icon = t.Icon
              const active = tab === t.id
              const colors = TAB_COLORS[t.color]
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors ${active ? colors.active : colors.idle}`}
                  title={t.label}
                >
                  <Icon size={13} />
                  <span className="hidden lg:inline">{t.label}</span>
                  <span className="lg:hidden">{t.short}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {tab === 'legales' && (
          <div className="space-y-5">
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
          </div>
        )}

        {tab === 'multimedia' && (
          <section className="bg-slate-800/40 border border-violet-500/30 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
              <ImageIcon size={15} className="text-violet-400" />
              <h3 className="text-xs font-bold text-violet-400 uppercase tracking-widest">Multimedia · Logos · Sello · Firma</h3>
              <span className="ml-auto text-[10px] text-slate-500">PNG/JPG/SVG · max 2MB</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{ASSETS.map(renderAsset)}</div>
          </section>
        )}

        {tab === 'seguridad' && (
          <section className="bg-slate-800/40 border border-amber-700/30 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
              <Lock size={15} className="text-amber-400" />
              <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest">PIN Supervisor y Límite Descuento</h3>
              <span className="ml-auto text-[10px] text-slate-500">Requerido para descuentos &gt; {Number(form.maxDescuentoCajero ?? 15)}%</span>
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
                <p className="text-[10px] text-slate-600 mt-1">
                  El cajero deberá ingresarlo si aplica un descuento global mayor al{' '}
                  <span className="font-mono text-amber-400">{Number(form.maxDescuentoCajero ?? 15)}%</span> en el POS.
                </p>
              </div>
              <div>
                <label className={LABEL}>Umbral PIN (% descuento)</label>
                {canEdit ? (
                  <input type="number" min={0} max={100} step={1}
                    value={form.maxDescuentoCajero ?? 15}
                    onChange={e => {
                      const n = parseInt(e.target.value, 10)
                      const clamped = isNaN(n) ? 15 : Math.max(0, Math.min(100, n))
                      setForm(f => ({ ...f, maxDescuentoCajero: clamped }))
                      setDirty(true)
                    }}
                    className={INPUT + ' font-mono text-center'} />
                ) : (
                  <div className={READONLY + ' font-mono text-center'}>{Number(form.maxDescuentoCajero ?? 15)}%</div>
                )}
                <p className="text-[10px] text-slate-600 mt-1">
                  Sobre este % el POS exige PIN supervisor. <span className="font-mono text-slate-500">0% = siempre, 100% = nunca.</span>
                </p>
              </div>
            </div>
          </section>
        )}

        {tab === 'comerciales' && (
          <section className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-700/50">
              <ScrollText size={15} className="text-blue-400" />
              <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest">Condiciones Comerciales por Defecto</h3>
              <span className="ml-auto text-[10px] text-slate-500">Validez · Pago · Entrega · Garantía</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {['validez','pago','entrega','garantia'].map(k => {
                const obligatorio = !!form.condicionesDefault?._obligatorio?.[k]
                return (
                  <div key={k}>
                    <div className="flex items-center justify-between mb-1">
                      <label className={LABEL + ' mb-0'}>{k}</label>
                      {canEdit ? (
                        <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Si está obligatorio, el cajero no podrá ocultar esta fila del PDF.">
                          <input
                            type="checkbox"
                            checked={obligatorio}
                            onChange={e => {
                              const next = e.target.checked
                              setForm(f => {
                                const cd = { ...(f.condicionesDefault ?? {}) }
                                const ob = { ...(cd._obligatorio ?? {}) }
                                ob[k] = next
                                cd._obligatorio = ob
                                return { ...f, condicionesDefault: cd }
                              })
                              setDirty(true)
                            }}
                            className="h-3 w-3 rounded border-slate-600 bg-slate-800 text-amber-500 focus:ring-amber-500 focus:ring-offset-0 cursor-pointer"
                          />
                          <span className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider ${obligatorio ? 'text-amber-400' : 'text-slate-500'}`}>
                            <Lock size={9} /> Obligatorio
                          </span>
                        </label>
                      ) : (
                        obligatorio && (
                          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                            <Lock size={9} /> Obligatorio
                          </span>
                        )
                      )}
                    </div>
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
                )
              })}
            </div>
            {canEdit && (
              <p className="mt-3 text-[10px] text-slate-500 leading-relaxed flex items-start gap-1.5">
                <Lock size={10} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <span>
                  Los términos marcados como <span className="text-amber-400 font-semibold">Obligatorio</span> se imprimirán
                  SIEMPRE en facturas y cotizaciones. El cajero no podrá ocultarlos desde el carrito ni siquiera con PIN supervisor.
                </span>
              </p>
            )}
          </section>
        )}

        {tab === 'ncf'        && <TabSecuenciasNCF canEdit={canEdit} />}
        {tab === 'ventas'     && <TabConstruccion label="Ventas"     descripcion="Política de precios · descuentos por canal · ITBIS por defecto · vencimientos por tipo cliente." />}
        {tab === 'compras'    && <TabConstruccion label="Compras"    descripcion="Suplidores preferidos · retenciones · términos de pago · órdenes de compra." />}
        {tab === 'inventario' && <TabConstruccion label="Inventario" descripcion="Política de stock mínimo · alertas · valoración FIFO/promedio · ubicaciones." />}
        {tab === 'bancos'     && <TabConstruccion label="Bancos"     descripcion="Cuentas bancarias · pasarelas (Azul / Cardnet) · reglas de conciliación." />}
        {tab === 'nomina'     && <TabConstruccion label="Nómina"     descripcion="Frecuencia (quincenal / mensual) · TSS · ISR · regalía · vacaciones." />}
        {tab === 'contactos'  && <TabConstruccion label="Contactos"  descripcion="Contactos institucionales (DGII, TSS, abogados, contadores) — agenda global." />}

        {showGlobalSave && (
          <div className="text-xs text-slate-600 text-center pt-4 border-t border-slate-800">
            Singleton ID=1 · cualquier cambio afecta facturas, cotizaciones y portal B2C en tiempo real
          </div>
        )}
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
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target.result)
    reader.readAsDataURL(file)

    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
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
    } catch {
      setError('Error de red.')
      toast.error('Error de red.')
      setPreview(null)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

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

/* ─── Tab: Secuencias y NCF ──────────────────────────────────────────────────
   Absorbe PanelSecuencias + PanelNCF en una sola vista. Range guard:
   secuenciaActual NUNCA debe exceder limite (ni siquiera durante edición). */

// Catálogo NCF DGII completo (Norma General 06-2018 + 05-2019). Cada entrada
// genera un row en MiEmpresa → Bloque B aunque el owner aún no haya
// configurado rangos — viene en "modo no persistido" hasta que guarda.
//
// IMPORTANTE: `tipoNcf` debe coincidir 1:1 con el catálogo del backend en
// modules/admin/empresa/ncf/schema.js → NCF_CATALOGO_DGII. Cualquier drift
// dispara NCF_TIPO_MISMATCH (400).
const NCF_CATALOGO = [
  { tipoNcf: 'Crédito Fiscal',             prefijo: 'B01', tipoDescripcion: 'Factura crédito fiscal — empresa con RNC (deducible ITBIS).' },
  { tipoNcf: 'Consumidor Final',           prefijo: 'B02', tipoDescripcion: 'Factura consumidor final — persona física (no deducible).' },
  { tipoNcf: 'Nota de Débito',             prefijo: 'B03', tipoDescripcion: 'Cargo adicional contra una factura emitida (intereses, ajustes).' },
  { tipoNcf: 'Nota de Crédito',            prefijo: 'B04', tipoDescripcion: 'Anulación o devolución parcial/total de una factura emitida.' },
  { tipoNcf: 'Comprobantes Compras',       prefijo: 'B11', tipoDescripcion: 'Compras a proveedor informal sin RNC (gasto deducible).' },
  { tipoNcf: 'Registro Único de Ingresos', prefijo: 'B12', tipoDescripcion: 'Otros ingresos no facturables (donaciones, indemnizaciones).' },
  { tipoNcf: 'Gastos Menores',             prefijo: 'B13', tipoDescripcion: 'Gastos sin comprobante del proveedor (caja chica deducible).' },
  { tipoNcf: 'Régimen Especial',           prefijo: 'B14', tipoDescripcion: 'Ventas exoneradas — Zonas Francas / diplomáticos.' },
  { tipoNcf: 'Gubernamental',              prefijo: 'B15', tipoDescripcion: 'Ventas al Estado dominicano y entidades públicas.' },
  { tipoNcf: 'Exportaciones',              prefijo: 'B16', tipoDescripcion: 'Ventas al exterior (exentas de ITBIS, tasa 0%).' },
  { tipoNcf: 'Pagos al Exterior',          prefijo: 'B17', tipoDescripcion: 'Retención ISR a no-residentes (servicios del exterior).' },
]

// Secuencias INTERNAS (no fiscales). Cualquier nuevo prefijo aquí NO debe
// confundirse con un NCF DGII (B##/E##): los NCF se gestionan exclusivamente
// en NCFSection con el catálogo cerrado NCF_CATALOGO.
const SEQ_ENTIDADES = [
  { key: 'factura',      label: 'Facturas',      desc: 'Documentos fiscales emitidos a clientes (prefijo interno FAC).' },
  { key: 'cotizacion',   label: 'Cotizaciones',  desc: 'Propuestas comerciales pre-venta.' },
  { key: 'cliente',      label: 'Clientes',      desc: 'Número de cliente único (no fiscal).' },
  { key: 'producto',     label: 'Artículos',     desc: 'SKUs auto-generados (inventario).' },
  { key: 'servicio',     label: 'Servicios',     desc: 'Contratos/suscripciones de servicio.' },
  { key: 'plan',         label: 'Planes ISP',    desc: 'SKU del plan (WISP/CCTV/Mixto).' },
  { key: 'rma',          label: 'Tickets RMA',   desc: 'Reparación y servicio técnico en taller.' },
  { key: 'ordenTrabajo', label: 'Órdenes de Trabajo', desc: 'OT — visitas técnicas / instalaciones / mantenimientos.' },
]

// Whitelist DGII estricta. NCFSection ignora cualquier registro de
// ConfiguracionNCF cuyo prefijo NO empiece con B/E o no esté en este catálogo.
// Previene que prefijos internos (COT, OT, FAC) se filtren a la lista fiscal
// si alguien guardó por error en la tabla equivocada.
const NCF_PREFIJOS_VALIDOS = new Set([
  'B01', 'B02', 'B03', 'B04',
  'B11', 'B12', 'B13', 'B14', 'B15', 'B16', 'B17',
])

function TabSecuenciasNCF({ canEdit }) {
  return (
    <div className="space-y-6">
      {/* Bloque A — secuencias INTERNAS (operativas, no fiscales) */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest bg-emerald-900/20 border border-emerald-700/40 rounded px-1.5 py-0.5">Bloque A</span>
          <h2 className="text-sm font-bold text-slate-200">Secuencias Internas</h2>
          <span className="text-[10px] text-slate-500">FAC · COT · CLI · ART · SVC · PLN · RMA · OT</span>
        </div>
        <SecuenciasSection canEdit={canEdit} />
      </div>

      {/* Divisor fuerte para separar visualmente lo operativo de lo fiscal */}
      <div className="border-t-2 border-dashed border-slate-700/40" aria-hidden="true" />

      {/* Bloque B — NCF FISCALES DGII (cerrado a B01/B02/B03/B04/B14/B15) */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-widest bg-indigo-900/20 border border-indigo-700/40 rounded px-1.5 py-0.5">Bloque B</span>
          <h2 className="text-sm font-bold text-slate-200">NCF Fiscales DGII</h2>
          <span className="text-[10px] text-slate-500">B01 · B02 · B03 · B04 · B11 · B12 · B13 · B14 · B15 · B16 · B17</span>
        </div>
        <NCFSection canEdit={canEdit} />
      </div>
    </div>
  )
}

function SecuenciasSection({ canEdit }) {
  const [secuencias, setSecuencias] = useState({})
  const [previews,   setPreviews]   = useState({})
  const [busy,       setBusy]       = useState(false)
  const [dirty,      setDirty]      = useState(false)
  const [loading,    setLoading]    = useState(true)
  const [migrando,   setMigrando]   = useState(false)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/configuracion/secuencias')
      if (r.ok) {
        const j = await r.json()
        setSecuencias(j.secuencias ?? {})
        const previewMap = {}
        await Promise.all(SEQ_ENTIDADES.map(async ({ key }) => {
          try {
            const pr = await apiFetch(`/api/configuracion/secuencias/preview/${key}`)
            if (pr.ok) { const pj = await pr.json(); previewMap[key] = pj.proximo }
          } catch {}
        }))
        setPreviews(previewMap)
      }
    } catch { toast.error('Error cargando secuencias.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  function setCampo(entidad, campo, valor) {
    setSecuencias(prev => ({
      ...prev,
      [entidad]: { ...(prev[entidad] ?? {}), [campo]: valor },
    }))
    setDirty(true)
  }

  async function guardar() {
    if (!canEdit) { toast.error('No tienes permiso para editar secuencias.'); return }
    setBusy(true)
    try {
      const payload = {}
      for (const { key } of SEQ_ENTIDADES) {
        const s = secuencias[key]
        if (!s) continue
        payload[key] = {
          prefijo: String(s.prefijo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
          actual:  Math.max(0, parseInt(s.actual ?? 0, 10)),
          padding: Math.max(3, Math.min(10, parseInt(s.padding ?? 6, 10))),
        }
      }
      const r = await apiFetch('/api/configuracion/secuencias', { method: 'PATCH', body: JSON.stringify(payload) })
      const j = await r.json()
      if (r.ok) {
        toast.success('Secuencias actualizadas.')
        setDirty(false)
        await cargar()
      } else {
        toast.error(j.error ?? 'Error al guardar.')
      }
    } catch { toast.error('Error de red.') }
    finally { setBusy(false) }
  }

  async function migrarDescripciones() {
    if (!window.confirm('Migrar todas las descripciones legacy a formato estructurado v=1. Esta acción es idempotente (re-ejecutar no daña nada). ¿Continuar?')) return
    setMigrando(true)
    try {
      const r = await apiFetch('/api/admin/migrar-descripciones', { method: 'POST' })
      const j = await r.json()
      if (r.ok) toast.success(j.resumen ?? 'Migración completada.', { duration: 10000 })
      else       toast.error(j.error ?? 'Error en la migración.')
    } catch { toast.error('Error de red durante la migración.') }
    finally { setMigrando(false) }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-500" /></div>

  return (
    <section className="bg-slate-800/40 border border-emerald-500/30 rounded-xl p-5">
      <div className="flex items-start justify-between mb-4 pb-2 border-b border-slate-700/50 gap-3">
        <div className="flex items-center gap-2">
          <Hash size={15} className="text-emerald-400" />
          <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Secuencias y Nomenclaturas</h3>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={cargar} disabled={busy}
            className="px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 text-[10px] flex items-center gap-1 disabled:opacity-40">
            <RefreshCw size={11} />Refrescar
          </button>
          {canEdit && (
            <button type="button" onClick={guardar} disabled={!dirty || busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-40">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Guardar secuencias
            </button>
          )}
        </div>
      </div>

      <div className="bg-amber-900/15 border border-amber-700/30 rounded-lg p-2.5 flex items-start gap-2 mb-4">
        <AlertCircle size={13} className="text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="text-[11px] text-amber-200/80 leading-relaxed">
          <strong className="text-amber-300">Atomicidad:</strong> dos cajeros que crean factura simultánea reciben códigos consecutivos distintos. El UPDATE en EmpresaPerfil bloquea la fila durante el incremento — Postgres serializa por write-lock. Cambiar el prefijo aquí solo afecta documentos FUTUROS.
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {SEQ_ENTIDADES.map(({ key, label, desc }) => {
          const s = secuencias[key] ?? { prefijo: '', actual: 0, padding: 6 }
          return (
            <div key={key} className="bg-slate-900/30 border border-slate-700/40 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h4 className="text-xs font-bold text-slate-200">{label}</h4>
                  <p className="text-[10px] text-slate-500 leading-snug">{desc}</p>
                </div>
                {previews[key] && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-900/20 border border-emerald-700/30">
                    <CheckCircle size={9} className="text-emerald-400" />
                    <span className="text-[9.5px] font-mono text-emerald-300">{previews[key]}</span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Prefijo</label>
                  <input className={INPUT + ' font-mono text-xs py-1.5'}
                    value={s.prefijo ?? ''} maxLength={10} disabled={!canEdit}
                    onChange={e => setCampo(key, 'prefijo', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="FAC" />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Actual</label>
                  <input className={INPUT + ' font-mono text-xs py-1.5'} type="number" min="0" disabled={!canEdit}
                    value={s.actual ?? 0}
                    onChange={e => setCampo(key, 'actual', Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Padding</label>
                  <input className={INPUT + ' font-mono text-xs py-1.5'} type="number" min="3" max="10" disabled={!canEdit}
                    value={s.padding ?? 6}
                    onChange={e => setCampo(key, 'padding', Math.max(3, Math.min(10, parseInt(e.target.value) || 6)))} />
                </div>
              </div>
              <p className="text-[10px] text-slate-600 mt-1.5 font-mono">
                Próximo: <span className="text-emerald-400">{`${(s.prefijo || '?')}-${String((s.actual ?? 0) + 1).padStart(s.padding ?? 6, '0')}`}</span>
              </p>
            </div>
          )
        })}
      </div>

      {canEdit && (
        <div className="mt-4 bg-red-900/10 border border-red-700/30 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-xs font-bold text-red-300 mb-0.5">Mantenimiento · Migración Descripciones</h4>
            <p className="text-[10px] text-red-200/70 leading-relaxed mb-2">
              Convierte descripciones legacy (Markdown manual) al formato estructurado <code>{`{v:1, titulo, bullets[]}`}</code>. Idempotente — los registros ya migrados se ignoran.
            </p>
            <button type="button" onClick={migrarDescripciones} disabled={migrando}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold disabled:opacity-40">
              {migrando ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {migrando ? 'Migrando…' : 'Migrar Descripciones'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function NCFSection({ canEdit }) {
  const [configs, setConfigs] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(null)
  const [forms,   setForms]   = useState({})

  const fetchConfigs = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/ncf-config')
      const j = r.ok ? await r.json() : { data: [] }
      // Filtro estricto: solo rows con prefijo B##/E## válidos del catálogo
      // DGII. Cualquier secuencia interna (COT, OT, FAC, etc.) que se haya
      // guardado por error en ConfiguracionNCF se ignora — esa lista vive
      // en EmpresaPerfil.secuenciasConfig, no aquí.
      const rawData = j.data ?? []
      const data = rawData.filter(c => NCF_PREFIJOS_VALIDOS.has(String(c.prefijo).toUpperCase()))
      setConfigs(data)
      const init = {}
      const vistas = new Set()
      for (const c of data) {
        init[c.tipoNcf] = { ...c, vencimiento: c.vencimiento ? c.vencimiento.slice(0, 10) : '' }
        vistas.add(c.tipoNcf)
      }
      for (const n of NCF_CATALOGO) {
        if (vistas.has(n.tipoNcf)) continue
        init[n.tipoNcf] = {
          prefijo: n.prefijo, tipoNcf: n.tipoNcf, tipoDescripcion: n.tipoDescripcion,
          secuenciaActual: 0, limite: 99999999, vencimiento: '', activo: true,
        }
      }
      setForms(init)
    } catch {} finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchConfigs() }, [fetchConfigs])

  const filas = useMemo(() => {
    return Object.values(forms).sort((a, b) => String(a.prefijo).localeCompare(String(b.prefijo)))
  }, [forms])

  function setField(tipo, k, v) {
    setForms(f => {
      const next = { ...f[tipo], [k]: v }
      // Range guard: secuenciaActual JAMÁS puede exceder limite.
      if (k === 'secuenciaActual') {
        const lim = parseInt(next.limite, 10) || 99999999
        const val = parseInt(v, 10) || 0
        if (val > lim) next.secuenciaActual = lim
        if (val < 0)   next.secuenciaActual = 0
      }
      if (k === 'limite') {
        const lim = parseInt(v, 10) || 0
        const act = parseInt(next.secuenciaActual, 10) || 0
        if (act > lim) next.secuenciaActual = lim
      }
      return { ...f, [tipo]: next }
    })
  }

  async function guardar(tipoNcf) {
    if (!canEdit) { toast.error('No tienes permiso para editar NCF.'); return }
    const f = forms[tipoNcf]
    if (!f) return
    // Validación final cliente — backend repite la validación.
    const sec = parseInt(f.secuenciaActual) || 0
    const lim = parseInt(f.limite) || 99999999
    if (sec > lim) {
      toast.error(`Secuencia (${sec}) excede el límite (${lim}). Ajusta antes de guardar.`)
      return
    }
    if (sec < 0 || lim < 1) {
      toast.error('Secuencia >= 0 y límite >= 1 obligatorio.')
      return
    }
    setSaving(tipoNcf)
    try {
      const body = {
        prefijo:         f.prefijo,
        tipoNcf:         f.tipoNcf,
        tipoDescripcion: f.tipoDescripcion,
        secuenciaActual: sec,
        limite:          lim,
        vencimiento:     f.vencimiento ? new Date(f.vencimiento).toISOString() : null,
        activo:          !!f.activo,
      }
      const r = await apiFetch('/api/ncf-config', { method: 'POST', body: JSON.stringify(body) })
      if (r.ok) { toast.success(`NCF ${tipoNcf} guardado.`); fetchConfigs() }
      else      { const j = await r.json().catch(() => ({})); toast.error(j.error ?? 'Error al guardar.') }
    } catch { toast.error('Error de conexión.') }
    finally  { setSaving(null) }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-emerald-500" /></div>

  return (
    <section className="bg-slate-800/40 border border-emerald-500/30 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700/50">
        <Hash size={15} className="text-emerald-400" />
        <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Rangos NCF (DGII)</h3>
        <span className="ml-auto text-[10px] text-slate-500">B01 · B02 · B03 · B04 · B11 · B12 · B13 · B14 · B15 · B16 · B17</span>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Configura los prefijos y secuencias para cada tipo de NCF según tus rangos autorizados por la DGII.
        <strong className="text-slate-400"> B03</strong> = Notas de Débito · <strong className="text-slate-400">B04</strong> = Notas de Crédito.
      </p>

      <div className="space-y-3">
        {filas.map(f => {
          const noPersistido = !configs.some(c => c.tipoNcf === f.tipoNcf)
          const sec  = Number(f.secuenciaActual) || 0
          const lim  = Number(f.limite) || 0
          const pct  = lim > 0 ? sec / lim : 0
          const warn = pct >= 0.9
          const excede = sec > lim
          return (
            <div key={f.tipoNcf} className="bg-slate-900/30 border border-slate-700/40 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-bold text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{f.prefijo}</span>
                  <span className="text-xs text-slate-400">{f.tipoDescripcion ?? f.tipoNcf}</span>
                  {noPersistido && (
                    <span title="No existe aún en la base de datos. Guarda para crearla."
                      className="flex items-center gap-1 text-[10px] font-bold text-amber-400 bg-amber-600/10 border border-amber-600/30 px-1.5 py-0.5 rounded">
                      <Plus size={9} /> nuevo
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-600 font-mono">Activo</span>
                  <button type="button" onClick={() => canEdit && setField(f.tipoNcf, 'activo', !f.activo)} disabled={!canEdit}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${f.activo ? 'bg-emerald-600' : 'bg-slate-700'} ${!canEdit ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition-transform ${f.activo ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Prefijo</label>
                  <input value={f.prefijo ?? ''} maxLength={3} disabled={!canEdit}
                    onChange={e => setField(f.tipoNcf, 'prefijo', e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Secuencia actual</label>
                  <input type="number" min="0" max={lim || undefined} value={f.secuenciaActual ?? 0} disabled={!canEdit}
                    onChange={e => setField(f.tipoNcf, 'secuenciaActual', e.target.value)}
                    className={`w-full bg-slate-800 border rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none ${excede ? 'border-red-500 focus:border-red-500' : 'border-slate-700 focus:border-emerald-500'}`} />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Límite</label>
                  <input type="number" min="1" value={f.limite ?? 99999999} disabled={!canEdit}
                    onChange={e => setField(f.tipoNcf, 'limite', e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Vencimiento</label>
                  <input type="date" value={f.vencimiento || ''} disabled={!canEdit}
                    onChange={e => setField(f.tipoNcf, 'vencimiento', e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-500" />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                {excede ? (
                  <span className="flex items-center gap-1 text-[10px] text-red-400 font-mono font-bold">
                    <AlertTriangle size={11} /> Secuencia excede límite · ajusta antes de guardar
                  </span>
                ) : warn && lim > 0 ? (
                  <span className="flex items-center gap-1 text-[10px] text-amber-400 font-mono">
                    <AlertTriangle size={11} /> Restantes: {lim - sec} ({Math.round(pct * 100)}% usado)
                  </span>
                ) : <span />}
                {canEdit && (
                  <button onClick={() => guardar(f.tipoNcf)} disabled={saving === f.tipoNcf || excede}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-400 border border-emerald-600/30 text-xs font-semibold disabled:opacity-40">
                    {saving === f.tipoNcf ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                    Guardar
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ─── Tab stub: módulo en construcción ─────────────────────────────────────── */
function TabConstruccion({ label, descripcion }) {
  return (
    <section className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-8">
      <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
        <div className="p-3 bg-slate-900/60 border border-slate-700 rounded-lg">
          <Construction size={28} className="text-slate-500" />
        </div>
        <h3 className="text-sm font-bold text-slate-200">{label} · En construcción</h3>
        <p className="text-xs text-slate-500 max-w-md leading-relaxed">{descripcion}</p>
        <span className="text-[10px] font-mono text-slate-600 mt-2 px-2 py-1 bg-slate-900/60 border border-slate-700/50 rounded">
          Próximamente · cubierto en el roadmap de configuración global
        </span>
      </div>
    </section>
  )
}
