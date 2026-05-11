import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Plus, Pencil, Trash2, X, Loader2, RefreshCw,
  Users, LogIn, LogOut, Clock, Calendar, Search, ShieldOff, Eye, EyeOff,
} from 'lucide-react'
import { useDebounce } from '../hooks/useDebounce'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../utils/api'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1'
const TH    = 'px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap'
const TD    = 'px-4 py-3 text-sm text-slate-300'

const fmtDate = d => new Date(d).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtTime = d => new Date(d).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })

// ─── Modal Formulario Empleado ────────────────────────────────────────────────

function FormularioEmpleado({ empleado, onClose, onSaved }) {
  const [nombre,   setNombre]   = useState(empleado?.nombre ?? '')
  const [email,    setEmail]    = useState(empleado?.email  ?? '')
  const [password, setPassword] = useState('')
  const [showPwd,  setShowPwd]  = useState(false)
  const [roles,    setRoles]    = useState([])
  const [selectedRoleIds, setSelectedRoleIds] = useState(
    empleado?.roles?.map(r => r.id) ?? []
  )
  const [loadingRoles, setLoadingRoles] = useState(false)
  const [saving, setSaving]     = useState(false)

  useEffect(() => {
    setLoadingRoles(true)
    apiFetch('/api/roles')
      .then(r => r.json())
      .then(j => setRoles((j.data ?? []).filter(r => r.activo)))
      .catch(() => toast.error('Error al cargar roles'))
      .finally(() => setLoadingRoles(false))
  }, [])

  function toggleRol(id) {
    setSelectedRoleIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function guardar() {
    if (!selectedRoleIds.length) { toast.error('Asigna al menos un rol.'); return }
    if (!empleado && !password) { toast.error('La contraseña inicial es requerida.'); return }
    setSaving(true)
    try {
      const cargo  = roles.filter(r => selectedRoleIds.includes(r.id)).map(r => r.nombre).join(' / ') || 'Técnico'
      const path   = empleado ? `/api/empleados/${empleado.id}` : '/api/empleados'
      const method = empleado ? 'PUT' : 'POST'
      const body   = { nombre, email, cargo, roleIds: selectedRoleIds, ...(password ? { password } : {}) }
      const r    = await apiFetch(path, { method, body: JSON.stringify(body) })
      const json = await r.json()
      if (!r.ok) { toast.error(json.detail?.[0]?.message ?? json.error ?? 'Error al guardar'); return }
      toast.success(empleado ? 'Técnico actualizado.' : 'Técnico creado.')
      onSaved(json)
    } catch { toast.error('Error de conexión') }
    finally { setSaving(false) }
  }

  const pwdValid = !password || (password.length >= 8 && /[^a-zA-Z0-9\s]/.test(password))
  const canSave  = nombre.trim() && email.trim() && pwdValid && (!!empleado || password.length >= 8)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">{empleado ? 'Editar Técnico' : 'Nuevo Técnico'}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className={LABEL}>Nombre Completo</label>
            <input className={INPUT} value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej. Carmelo J. Rosario" autoFocus />
          </div>
          <div>
            <label className={LABEL}>Email</label>
            <input type="email" className={INPUT} value={email} onChange={e => setEmail(e.target.value)} placeholder="tecnico@empresa.do" />
          </div>
          <div>
            <label className={LABEL}>{empleado ? 'Nueva Contraseña (opcional)' : 'Contraseña Inicial *'}</label>
            <div className="relative">
              <input type={showPwd ? 'text' : 'password'} className={INPUT + ' pr-9'} value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={empleado ? 'Dejar vacío para no cambiar' : 'Mín 8 chars + 1 símbolo (! @ # $ %...)'}
              />
              <button type="button" onClick={() => setShowPwd(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {!empleado && <p className="text-[10px] text-slate-600 mt-1 font-mono">Requiere símbolo especial: ! @ # $ % ^ &amp; * - _ etc.</p>}
            {empleado && password && !pwdValid && (
              <p className="text-[10px] text-red-400 mt-1 font-mono">Mín. 8 caracteres + 1 símbolo especial</p>
            )}
          </div>
          <div>
            <label className={LABEL}>Rol(es) Asignado(s)</label>
            {loadingRoles
              ? <div className="flex items-center gap-2 text-xs text-slate-500 py-2"><Loader2 size={12} className="animate-spin" />Cargando roles...</div>
              : roles.length === 0
              ? <p className="text-xs text-slate-600 py-2">Sin roles disponibles. Crea uno en Configuración.</p>
              : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                  {roles.map(r => {
                    const on = selectedRoleIds.includes(r.id)
                    return (
                      <label key={r.id} className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all ${
                        on ? 'bg-blue-600/10 border-blue-600/30' : 'bg-slate-800/40 border-slate-700/30 hover:bg-slate-800/60'
                      }`}>
                        <input type="checkbox" checked={on} onChange={() => toggleRol(r.id)} className="accent-blue-500 w-4 h-4 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className={`text-sm font-medium leading-tight ${on ? 'text-blue-300' : 'text-slate-300'}`}>{r.nombre}</p>
                          {r.descripcion && <p className="text-[10px] text-slate-600 truncate">{r.descripcion}</p>}
                        </div>
                      </label>
                    )
                  })}
                </div>
              )
            }
          </div>
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">Cancelar</button>
          <button onClick={guardar} disabled={saving || !canSave}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {empleado ? 'Guardar Cambios' : 'Crear Técnico'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Empleados ───────────────────────────────────────────────────────────

function TabEmpleados() {
  const { tienePermiso }          = useAuth()
  const [rows, setRows]           = useState([])
  const [loading, setLoading]     = useState(false)
  const [search, setSearch]       = useState('')
  const [modal, setModal]         = useState(null)
  const debouncedSearch           = useDebounce(search, 400)

  const fetchEmpleados = useCallback(async (s) => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (s) params.set('search', s)
      const r = await apiFetch(`/api/empleados?${params}`)
      const j = await r.json()
      setRows(j.data ?? [])
    } catch { toast.error('Error al cargar técnicos') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchEmpleados(debouncedSearch) }, [debouncedSearch, fetchEmpleados])

  async function eliminar(e) {
    if (!window.confirm(`¿Eliminar a "${e.nombre}"?`)) return
    const r = await apiFetch(`/api/empleados/${e.id}`, { method: 'DELETE' })
    if (r.status === 204) { toast.success('Técnico eliminado.'); fetchEmpleados(debouncedSearch); return }
    const j = await r.json()
    toast.error(j.error ?? 'Error al eliminar.')
  }

  const canEdit = tienePermiso('rrhh:editar')

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 p-4 border-b border-slate-800">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Buscar técnico..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {canEdit && (
          <button
            onClick={() => setModal('nuevo')}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus size={14} /> Nuevo Técnico
          </button>
        )}
        <button onClick={() => fetchEmpleados(debouncedSearch)} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[500px]">
          <thead className="sticky top-0 z-10 bg-slate-800/90 backdrop-blur-sm">
            <tr>
              <th className={TH}>Nombre</th>
              <th className={TH}>Roles / Cargo</th>
              <th className={TH}>Email</th>
              <th className={TH}>Desde</th>
              {canEdit && <th className={TH}></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && rows.length === 0 && (
              <tr><td colSpan={canEdit ? 5 : 4} className="px-4 py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="animate-spin inline mr-2" />Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={canEdit ? 5 : 4} className="px-4 py-8 text-center text-sm text-slate-600">Sin técnicos registrados.</td></tr>
            )}
            {rows.map(e => {
              const roleLabel = e.roles?.length
                ? e.roles.map(r => r.nombre).join(', ')
                : e.cargo
              return (
                <tr key={e.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className={TD + ' font-medium text-slate-200'}>{e.nombre}</td>
                  <td className={TD}>
                    {e.roles?.length
                      ? <div className="flex flex-wrap gap-1">
                          {e.roles.map(r => (
                            <span key={r.id} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-blue-600/10 text-blue-400 border border-blue-600/30">{r.nombre}</span>
                          ))}
                        </div>
                      : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-slate-700/40 text-slate-500 border border-slate-700/30">{roleLabel}</span>
                    }
                  </td>
                  <td className={TD + ' text-slate-400 text-xs font-mono'}>{e.email}</td>
                  <td className={TD + ' text-xs text-slate-500'}>{new Date(e.creadoEn).toLocaleDateString('es-DO')}</td>
                  {canEdit && (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setModal(e)} className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition-colors" title="Editar">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => eliminar(e)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors" title="Eliminar">
                          <Trash2 size={14} />
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

      {modal && (
        <FormularioEmpleado
          empleado={modal === 'nuevo' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); fetchEmpleados(debouncedSearch) }}
        />
      )}
    </div>
  )
}

// ─── Tab: Asistencia ──────────────────────────────────────────────────────────

function TabAsistencia() {
  const now = new Date()
  const [empleados, setEmpleados]     = useState([])
  const [empleadoId, setEmpleadoId]   = useState('')
  const [mes, setMes]                 = useState(now.getMonth() + 1)
  const [anio, setAnio]               = useState(now.getFullYear())
  const [registros, setRegistros]     = useState([])
  const [loading, setLoading]         = useState(false)
  const [registrando, setRegistrando] = useState(false)

  useEffect(() => {
    apiFetch('/api/empleados').then(r => r.json()).then(j => {
      const data = j.data ?? []
      setEmpleados(data)
      if (data.length > 0 && !empleadoId) setEmpleadoId(String(data[0].id))
    })
  }, [])

  const fetchRegistros = useCallback(async () => {
    if (!empleadoId) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ empleadoId, mes, anio })
      const r = await apiFetch(`/api/asistencia?${params}`)
      const j = await r.json()
      setRegistros(j.data ?? [])
    } catch { toast.error('Error al cargar registros') }
    finally { setLoading(false) }
  }, [empleadoId, mes, anio])

  useEffect(() => { fetchRegistros() }, [fetchRegistros])

  const ultimoRegistro = registros[0]
  const estaAdentro    = ultimoRegistro?.tipo === 'Entrada'

  async function registrar() {
    if (!empleadoId) return
    setRegistrando(true)
    try {
      const tipo = estaAdentro ? 'Salida' : 'Entrada'
      const r = await apiFetch('/api/asistencia', {
        method: 'POST', body: JSON.stringify({ empleadoId: parseInt(empleadoId), tipo }),
      })
      if (r.ok) {
        toast.success(`${tipo} registrada.`)
        fetchRegistros()
      } else {
        const j = await r.json()
        toast.error(j.error ?? 'Error al registrar asistencia')
      }
    } catch { toast.error('Error de conexión') }
    finally { setRegistrando(false) }
  }

  const hoyStr = now.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors flex-1"
          value={empleadoId}
          onChange={e => setEmpleadoId(e.target.value)}
        >
          {empleados.map(e => {
            const label = e.roles?.length ? e.roles.map(r => r.nombre).join(', ') : e.cargo
            return <option key={e.id} value={e.id}>{e.nombre} — {label}</option>
          })}
        </select>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors"
          value={mes}
          onChange={e => setMes(parseInt(e.target.value))}
        >
          {MESES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
        </select>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-blue-500 transition-colors"
          value={anio}
          onChange={e => setAnio(parseInt(e.target.value))}
        >
          {[anio - 1, anio, anio + 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <div className={`rounded-xl border p-5 flex flex-col sm:flex-row items-center gap-4 ${
        estaAdentro ? 'bg-emerald-900/15 border-emerald-700/30' : 'bg-slate-800/40 border-slate-700/50'
      }`}>
        <div className="flex items-center gap-3 flex-1">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
            estaAdentro ? 'bg-emerald-600/20 border border-emerald-600/40' : 'bg-slate-700/40 border border-slate-600/40'
          }`}>
            {estaAdentro ? <LogIn size={22} className="text-emerald-400" /> : <LogOut size={22} className="text-slate-400" />}
          </div>
          <div>
            <p className="font-semibold text-slate-100">
              {estaAdentro ? 'Técnico en instalación' : 'Técnico disponible'}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {ultimoRegistro
                ? `Último registro: ${ultimoRegistro.tipo} a las ${fmtTime(ultimoRegistro.fechaHora)}`
                : 'Sin registros este mes'}
            </p>
            <p className="text-xs text-slate-600 mt-0.5 capitalize">{hoyStr}</p>
          </div>
        </div>
        <button
          onClick={registrar}
          disabled={registrando || !empleadoId}
          className={`w-full sm:w-auto px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${
            estaAdentro
              ? 'bg-orange-600 hover:bg-orange-500 text-white'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
          }`}
        >
          {registrando ? <Loader2 size={14} className="animate-spin" /> : (estaAdentro ? <LogOut size={14} /> : <LogIn size={14} />)}
          {estaAdentro ? 'Registrar Salida' : 'Registrar Entrada'}
        </button>
      </div>

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <p className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Calendar size={14} className="text-slate-500" />
            Historial — {MESES[mes - 1]} {anio}
          </p>
          <span className="text-xs text-slate-500">{registros.length} registros</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[400px]">
            <thead className="sticky top-0 z-10 bg-slate-800/90 backdrop-blur-sm">
              <tr>
                <th className={TH}>Tipo</th>
                <th className={TH}>Fecha y Hora</th>
                <th className={TH}>Técnico</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading && (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-slate-500"><Loader2 size={16} className="animate-spin inline mr-2" />Cargando...</td></tr>
              )}
              {!loading && registros.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-slate-600">Sin registros para este período.</td></tr>
              )}
              {registros.map(r => (
                <tr key={r.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="px-4 py-3">
                    {r.tipo === 'Entrada' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-600/10 text-emerald-400 border border-emerald-600/30">
                        <LogIn size={10} /> Entrada
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-600/10 text-orange-400 border border-orange-600/30">
                        <LogOut size={10} /> Salida
                      </span>
                    )}
                  </td>
                  <td className={TD + ' tabular-nums text-xs'}>{fmtDate(r.fechaHora)}</td>
                  <td className={TD + ' text-slate-400'}>{r.empleado?.nombre ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'empleados',  label: 'Técnicos',   Icon: Users },
  { key: 'asistencia', label: 'Asistencia', Icon: Clock },
]

export default function RRHH() {
  const { tienePermiso } = useAuth()
  const [tab, setTab] = useState('empleados')

  if (!tienePermiso('rrhh:ver')) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <ShieldOff size={40} className="text-slate-700 mb-3" />
        <p className="text-slate-500 font-medium">Sin acceso a RRHH</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight">RRHH</h1>
        <p className="text-sm text-slate-500 mt-0.5">Técnicos · Asistencia · Nómina</p>
      </div>

      <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="flex border-b border-slate-800 overflow-x-auto">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                tab === key
                  ? 'text-blue-400 border-blue-500 bg-blue-900/10'
                  : 'text-slate-400 border-transparent hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === 'empleados'  && <TabEmpleados />}
        {tab === 'asistencia' && <TabAsistencia />}
      </div>
    </div>
  )
}
