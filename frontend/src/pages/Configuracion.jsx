import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  ShieldCheck, Lock, Ban, CheckCircle, LogOut, Loader2, Eye, EyeOff,
  RefreshCw, KeyRound, Crown, Users, Shield, Plus, Trash2, Save, Sparkles,
  QrCode, Smartphone, User, Monitor, Trash, Globe, MapPin, Store, Activity, AlertTriangle,
  Building2 as Building2Icon,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../utils/api'
import PanelApiEstado from './panels/PanelApiEstado'
import PanelMiEmpresa from './panels/PanelMiEmpresa'

function buildPermGroups(flat) {
  const map = new Map()
  for (const p of flat) {
    if (!map.has(p.module)) map.set(p.module, { module: p.module, color: p.color, permisos: [] })
    map.get(p.module).permisos.push({ key: p.key, label: p.label, desc: p.desc })
  }
  return Array.from(map.values())
}

const COLOR_MAP = {
  red:     { text: 'text-red-400',     border: 'border-red-600/30',     bg: 'bg-red-600/10'     },
  blue:    { text: 'text-blue-400',    border: 'border-blue-600/30',    bg: 'bg-blue-600/10'    },
  cyan:    { text: 'text-cyan-400',    border: 'border-cyan-600/30',    bg: 'bg-cyan-600/10'    },
  violet:  { text: 'text-violet-400',  border: 'border-violet-600/30',  bg: 'bg-violet-600/10'  },
  emerald: { text: 'text-emerald-400', border: 'border-emerald-600/30', bg: 'bg-emerald-600/10' },
  amber:   { text: 'text-amber-400',   border: 'border-amber-600/30',   bg: 'bg-amber-600/10'   },
  sky:     { text: 'text-sky-400',     border: 'border-sky-600/30',     bg: 'bg-sky-600/10'     },
  teal:    { text: 'text-teal-400',    border: 'border-teal-600/30',    bg: 'bg-teal-600/10'    },
}

function Toggle({ on, onChange, disabled }) {
  return (
    <button type="button" onClick={() => !disabled && onChange(!on)} disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      } ${on ? (disabled ? 'bg-slate-500' : 'bg-blue-600') : 'bg-slate-700'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  )
}

// Standard PermMatrix for role editing
function PermMatrix({ permisos, setPermisos, permGroups }) {
  function togglePermiso(key) {
    setPermisos(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }
  function toggleModulo(keys, forceOn) {
    setPermisos(prev => {
      const next = new Set(prev)
      keys.forEach(k => forceOn ? next.add(k) : next.delete(k))
      return Array.from(next)
    })
  }
  return (
    <div className="space-y-3">
      {permGroups.map(({ module, color, permisos: groupPermisos }) => {
        const c     = COLOR_MAP[color] ?? COLOR_MAP.blue
        const keys  = groupPermisos.map(p => p.key)
        const allOn = keys.every(k => permisos.includes(k))
        const anyOn = keys.some(k => permisos.includes(k))
        return (
          <div key={module} className={`rounded-xl border ${anyOn ? c.border : 'border-slate-700/40'} ${anyOn ? c.bg : 'bg-slate-800/20'} p-3`}>
            <div className="flex items-center justify-between mb-2.5">
              <p className={`text-[11px] font-bold uppercase tracking-widest ${anyOn ? c.text : 'text-slate-500'}`}>{module}</p>
              <button onClick={() => toggleModulo(keys, !allOn)}
                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                  allOn ? `${c.text} ${c.border} ${c.bg} hover:opacity-80` : 'text-slate-500 border-slate-700 hover:text-slate-300'
                }`}>
                {allOn ? 'Quitar todo' : 'Dar todo'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {groupPermisos.map(({ key, label, desc }) => {
                const on = permisos.includes(key)
                return (
                  <div key={key} onClick={() => togglePermiso(key)}
                    className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer select-none transition-all ${
                      on ? `${c.bg} ${c.border}` : 'bg-slate-800/40 border-slate-700/30 hover:bg-slate-800/70'
                    }`}>
                    <Toggle on={on} onChange={() => togglePermiso(key)} />
                    <div className="min-w-0">
                      <p className={`text-xs font-semibold leading-tight truncate ${on ? c.text : 'text-slate-400'}`}>{label}</p>
                      <p className="text-[10px] text-slate-600 truncate leading-tight">{desc}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Hybrid PermMatrix for per-user extra perms — shows inherited (locked) vs extra (editable)
function PermMatrixHybrid({ permisosExtra, setPermisosExtra, permGroups, inheritedPerms }) {
  function toggleExtra(key) {
    if (inheritedPerms.has(key)) return
    setPermisosExtra(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key])
  }
  return (
    <div className="space-y-3">
      {permGroups.map(({ module, color, permisos: groupPermisos }) => {
        const c = COLOR_MAP[color] ?? COLOR_MAP.blue
        const keys = groupPermisos.map(p => p.key)
        const anyActive = keys.some(k => inheritedPerms.has(k) || permisosExtra.includes(k))
        return (
          <div key={module} className={`rounded-xl border ${anyActive ? c.border : 'border-slate-700/40'} ${anyActive ? c.bg : 'bg-slate-800/20'} p-3`}>
            <p className={`text-[11px] font-bold uppercase tracking-widest mb-2.5 ${anyActive ? c.text : 'text-slate-500'}`}>{module}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {groupPermisos.map(({ key, label, desc }) => {
                const inherited = inheritedPerms.has(key)
                const extraOn   = permisosExtra.includes(key)
                const on = inherited || extraOn
                return (
                  <div key={key} onClick={() => toggleExtra(key)}
                    className={`flex items-center gap-2 p-2 rounded-lg border select-none transition-all ${
                      inherited
                        ? 'bg-slate-700/20 border-slate-600/20 cursor-not-allowed opacity-65'
                        : extraOn
                        ? `${c.bg} ${c.border} cursor-pointer`
                        : 'bg-slate-800/40 border-slate-700/30 hover:bg-slate-800/70 cursor-pointer'
                    }`}>
                    <Toggle on={on} onChange={() => toggleExtra(key)} disabled={inherited} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 min-w-0">
                        <p className={`text-xs font-semibold leading-tight truncate ${
                          inherited ? 'text-slate-500' : extraOn ? c.text : 'text-slate-400'
                        }`}>{label}</p>
                        {inherited && (
                          <span className="text-[9px] font-mono px-1 py-0 rounded bg-slate-700 text-slate-500 flex-shrink-0 leading-4">rol</span>
                        )}
                      </div>
                      <p className="text-[10px] text-slate-600 truncate leading-tight">{desc}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PanelRol({ rol, permGroups, onUpdated }) {
  const { user: me }  = useAuth()
  const isNew = !rol
  const [nombre,      setNombre]      = useState(rol?.nombre ?? '')
  const [descripcion, setDescripcion] = useState(rol?.descripcion ?? '')
  const [permisos,    setPermisos]    = useState(Array.isArray(rol?.permisos) ? rol.permisos : [])
  const [activo,      setActivo]      = useState(rol?.activo ?? true)
  const [nivel,       setNivel]       = useState(rol?.nivel ?? 0)
  const [require2FA,  setRequire2FA]  = useState(rol?.require2FA ?? false)
  const [saving,      setSaving]      = useState(false)
  const [deleting,    setDeleting]    = useState(false)

  useEffect(() => {
    setNombre(rol?.nombre ?? '')
    setDescripcion(rol?.descripcion ?? '')
    setPermisos(Array.isArray(rol?.permisos) ? rol.permisos : [])
    setActivo(rol?.activo ?? true)
    setNivel(rol?.nivel ?? 0)
    setRequire2FA(rol?.require2FA ?? false)
  }, [rol])

  const isOwner    = me?.permisos?.includes('sistema:owner') ?? false
  const myNivelMax = isOwner ? 100 : (me?.nivelMax ?? 0)
  // editMax: ceiling a non-owner can set; owner can set 0-100
  const editMax    = isOwner ? 100 : Math.max(0, myNivelMax - 1)
  // canEditNivel: false if editing a role whose nivel exceeds caller's authority
  const canEditNivel = isOwner || nivel <= editMax

  async function guardar() {
    if (!nombre.trim()) { toast.error('El nombre del rol es obligatorio.'); return }
    const nivelVal = Math.min(Math.max(0, parseInt(nivel) || 0), isOwner ? 100 : editMax)
    if (!isOwner && nivelVal >= myNivelMax) {
      toast.error(`Nivel máximo permitido: ${editMax}.`); return
    }
    setSaving(true)
    try {
      const method = isNew ? 'POST' : 'PUT'
      const url    = isNew ? '/api/roles' : `/api/roles/${rol.id}`
      const r = await apiFetch(url, { method, body: JSON.stringify({ nombre: nombre.trim(), descripcion: descripcion.trim() || null, permisos, activo, nivel: nivelVal, require2FA }) })
      if (r.ok) { toast.success(isNew ? 'Rol creado.' : 'Rol actualizado.'); onUpdated() }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSaving(false) }
  }

  async function eliminar() {
    if (!window.confirm(`¿Eliminar el rol "${rol.nombre}"? Esta acción no se puede deshacer.`)) return
    setDeleting(true)
    try {
      const r = await apiFetch(`/api/roles/${rol.id}`, { method: 'DELETE' })
      if (r.status === 204) { toast.success('Rol eliminado.'); onUpdated() }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setDeleting(false) }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Nombre del Rol *</label>
          <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej. Técnico Junior"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors" />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Descripción</label>
          <input value={descripcion} onChange={e => setDescripcion(e.target.value)} placeholder="Opcional"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors" />
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">
          Nivel de Privilegio (0 – {editMax})
          {!canEditNivel && <span className="ml-2 text-amber-500 normal-case font-normal">— solo lectura (nivel superior al tuyo)</span>}
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range" min={0} max={editMax} step={1}
            value={nivel}
            onChange={e => setNivel(parseInt(e.target.value))}
            disabled={!canEditNivel}
            className="flex-1 accent-blue-500 h-1.5 disabled:opacity-40"
          />
          <input
            type="number" min={0} max={editMax} step={1}
            value={nivel}
            onChange={e => setNivel(Math.max(0, Math.min(editMax, parseInt(e.target.value) || 0)))}
            disabled={!canEditNivel}
            className="w-16 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 text-center focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-40"
          />
        </div>
        <p className="text-[10px] text-slate-600 mt-1 font-mono">
          {nivel === 0 ? 'Sin privilegio especial' : nivel < 50 ? 'Operativo' : nivel < 80 ? 'Supervisor' : nivel < 100 ? 'Administrador' : 'Propietario'}
          {!isOwner && ` · tu techo: ${editMax}`}
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        {!isNew && (
          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <Toggle on={activo} onChange={setActivo} />
            <span className="text-xs text-slate-400">Rol activo</span>
          </label>
        )}
        <label className="flex items-center gap-2 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={require2FA}
            onChange={e => setRequire2FA(e.target.checked)}
            className="w-4 h-4 accent-amber-500 rounded"
          />
          <span className="text-xs text-slate-400">
            Exigir 2FA obligatorio
            {require2FA && <span className="ml-1.5 text-[9px] font-bold text-amber-400 bg-amber-600/15 border border-amber-600/30 px-1.5 py-0.5 rounded-full">ACTIVO</span>}
          </span>
        </label>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <ShieldCheck size={13} />Matrix de Permisos — {permisos.length} activos
        </p>
        <PermMatrix permisos={permisos} setPermisos={setPermisos} permGroups={permGroups} />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button onClick={guardar} disabled={saving}
          className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isNew ? 'Crear Rol' : 'Guardar Cambios'}
        </button>
        {!isNew && (
          <button onClick={eliminar} disabled={deleting}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600/15 hover:bg-red-600/25 text-red-400 border border-red-600/30 text-sm font-medium transition-colors disabled:opacity-50">
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Eliminar
          </button>
        )}
      </div>
    </div>
  )
}

function PanelUsuario({ empleado, roles, permGroups, onUpdated }) {
  const { user: me }  = useAuth()
  const isSelf        = me?.id === empleado.id
  const isPropietario = empleado.roles?.some(r => Array.isArray(r.permisos) && r.permisos.includes('sistema:owner'))

  const inheritedPerms = new Set(
    (empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : [])
  )

  const [selectedRoleIds,  setSelectedRoleIds]  = useState(empleado.roles?.map(r => r.id) ?? [])
  const [permisosExtra,    setPermisosExtra]    = useState(
    Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra.filter(p => !inheritedPerms.has(p)) : []
  )
  const [saving,       setSaving]       = useState(false)
  const [savingExtra,  setSavingExtra]  = useState(false)
  const [newPwd,       setNewPwd]       = useState('')
  const [showPwd,      setShowPwd]      = useState(false)
  const [savingPwd,    setSavingPwd]    = useState(false)
  const [savingBlock,  setSavingBlock]  = useState(false)
  const [savingLogout, setSavingLogout] = useState(false)

  useEffect(() => {
    setSelectedRoleIds(empleado.roles?.map(r => r.id) ?? [])
    const inh = new Set((empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : []))
    setPermisosExtra(Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra.filter(p => !inh.has(p)) : [])
  }, [empleado])

  function toggleRol(id) {
    setSelectedRoleIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function guardarRoles() {
    setSaving(true)
    try {
      const r = await apiFetch(`/api/admin/empleados/${empleado.id}/roles`, {
        method: 'PATCH', body: JSON.stringify({ roleIds: selectedRoleIds }),
      })
      if (r.ok) { toast.success('Roles guardados.'); onUpdated() }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSaving(false) }
  }

  async function guardarPermisosExtra() {
    setSavingExtra(true)
    try {
      const r = await apiFetch(`/api/admin/empleados/${empleado.id}/permisos-extra`, {
        method: 'PATCH', body: JSON.stringify({ permisosExtra }),
      })
      if (r.status === 204) toast.success('Permisos especiales guardados.')
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSavingExtra(false) }
  }

  async function cambiarPassword() {
    if (newPwd.length < 8) { toast.error('Mínimo 8 caracteres.'); return }
    setSavingPwd(true)
    try {
      const r = await apiFetch(`/api/admin/empleados/${empleado.id}/password`, { method: 'PATCH', body: JSON.stringify({ password: newPwd }) })
      if (r.status === 204) { toast.success('Contraseña actualizada. Sesiones cerradas.'); setNewPwd('') }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSavingPwd(false) }
  }

  async function toggleBloqueo() {
    setSavingBlock(true)
    try {
      const r = await apiFetch(`/api/admin/empleados/${empleado.id}/bloquear`, { method: 'PATCH', body: JSON.stringify({ bloqueado: !empleado.bloqueado }) })
      if (r.status === 204) { toast.success(!empleado.bloqueado ? 'Usuario bloqueado.' : 'Acceso restaurado.'); onUpdated() }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSavingBlock(false) }
  }

  async function cerrarSesiones() {
    setSavingLogout(true)
    try {
      const r = await apiFetch(`/api/admin/sessions/${empleado.id}`, { method: 'DELETE' })
      if (r.status === 204) toast.success('Todas las sesiones cerradas.')
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSavingLogout(false) }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-slate-100">{empleado.nombre}</p>
            {isPropietario && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30 uppercase tracking-widest">
                <Crown size={9} />Propietario
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">{empleado.cargo} · {empleado.email}</p>
          {empleado.roles?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {empleado.roles.map(r => (
                <span key={r.id} className="inline-flex text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400 font-mono">{r.nombre}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {empleado.bloqueado
            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-600/10 text-red-400 border border-red-600/30"><Ban size={10} />Bloqueado</span>
            : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-600/10 text-emerald-400 border border-emerald-600/30"><CheckCircle size={10} />Activo</span>
          }
          {!isPropietario && (
            <button onClick={toggleBloqueo} disabled={savingBlock || isSelf} title={isSelf ? 'No puedes bloquearte a ti mismo' : ''}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 border ${
                empleado.bloqueado
                  ? 'bg-emerald-600/15 text-emerald-400 hover:bg-emerald-600/25 border-emerald-600/30'
                  : 'bg-red-600/15 text-red-400 hover:bg-red-600/25 border-red-600/30'
              }`}>
              {savingBlock ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
              {empleado.bloqueado ? 'Desbloquear' : 'Bloquear'}
            </button>
          )}
          <button onClick={cerrarSesiones} disabled={savingLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600 transition-colors disabled:opacity-40">
            {savingLogout ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
            Cerrar sesiones
          </button>
        </div>
      </div>

      {/* Role assignment */}
      {isPropietario ? (
        <div className="py-6 text-center rounded-xl border border-amber-600/20 bg-amber-600/5">
          <Crown size={22} className="text-amber-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-amber-400">Permisos supremos — Inmutables</p>
          <p className="text-xs text-slate-600 mt-1 font-mono">sistema:owner bypasses all permission checks</p>
        </div>
      ) : (
        <>
          {/* Roles */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Shield size={13} />Roles Asignados
            </p>
            {roles.length === 0
              ? <p className="text-xs text-slate-600 py-4">No hay roles disponibles. Crea uno en la pestaña Roles.</p>
              : (
                <div className="grid grid-cols-1 gap-2 mb-4">
                  {roles.map(r => {
                    const on = selectedRoleIds.includes(r.id)
                    return (
                      <label key={r.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                        on ? 'bg-blue-600/10 border-blue-600/30' : 'bg-slate-800/30 border-slate-700/30 hover:bg-slate-800/60'
                      }`}>
                        <input type="checkbox" checked={on} onChange={() => toggleRol(r.id)} className="accent-blue-500 w-4 h-4 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className={`text-sm font-semibold ${on ? 'text-blue-300' : 'text-slate-300'}`}>{r.nombre}</p>
                            {!r.activo && <span className="text-[10px] text-slate-600 font-mono">(inactivo)</span>}
                          </div>
                          {r.descripcion && <p className="text-xs text-slate-600 truncate">{r.descripcion}</p>}
                          <p className="text-[10px] text-slate-600 font-mono mt-0.5">{Array.isArray(r.permisos) ? r.permisos.length : 0} permisos</p>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )
            }
            <button onClick={guardarRoles} disabled={saving}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />}
              <Save size={14} />Guardar Roles
            </button>
          </div>

          {/* Extra Perms */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                <Sparkles size={13} className="text-amber-400" />
                Permisos Especiales (Extra)
              </p>
              <span className="text-[10px] font-mono text-slate-600">
                {permisosExtra.length} extra · {inheritedPerms.size} via rol
              </span>
            </div>
            <div className="rounded-xl border border-amber-600/15 bg-amber-600/5 p-3 mb-3">
              <p className="text-[10px] text-amber-600/80 leading-relaxed">
                Toggles <span className="font-bold text-slate-500">grises bloqueados</span> = permiso ya heredado del rol.
                Toggles <span className="font-bold text-amber-400">activos</span> = permiso extra único para este usuario.
              </p>
            </div>
            <PermMatrixHybrid
              permisosExtra={permisosExtra}
              setPermisosExtra={setPermisosExtra}
              permGroups={permGroups}
              inheritedPerms={inheritedPerms}
            />
            <button onClick={guardarPermisosExtra} disabled={savingExtra}
              className="mt-4 flex items-center gap-2 px-5 py-2 rounded-lg bg-amber-600/80 hover:bg-amber-600 text-white text-sm font-semibold transition-colors disabled:opacity-50">
              {savingExtra ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Guardar Permisos Extra
            </button>
          </div>
        </>
      )}

      {/* Password */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <KeyRound size={13} />Cambiar Contraseña
        </p>
        <div className="flex gap-2 max-w-sm">
          <div className="relative flex-1">
            <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type={showPwd ? 'text' : 'password'} value={newPwd} onChange={e => setNewPwd(e.target.value)}
              placeholder="Nueva contraseña (mín. 8 chars)"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-8 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors" />
            <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <button onClick={cambiarPassword} disabled={savingPwd || newPwd.length < 8}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors disabled:opacity-40">
            {savingPwd ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            Cambiar
          </button>
        </div>
      </div>

    </div>
  )
}

function PanelMiPerfil() {
  const { user: me } = useAuth()

  const [twoFAEnabled, setTwoFAEnabled] = useState(false)
  const [twoFALoaded,  setTwoFALoaded]  = useState(false)

  const [currentPwd,  setCurrentPwd]  = useState('')
  const [newPwd,      setNewPwd]      = useState('')
  const [showCurPwd,  setShowCurPwd]  = useState(false)
  const [showNewPwd,  setShowNewPwd]  = useState(false)
  const [savingPwd,   setSavingPwd]   = useState(false)

  const [qrCode,     setQrCode]     = useState(null)
  const [totpPin,    setTotpPin]    = useState('')
  const [saving2FA,  setSaving2FA]  = useState(false)
  const [loading2FA, setLoading2FA] = useState(false)

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setTwoFAEnabled(d.twoFactorEnabled ?? false); setTwoFALoaded(true) } })
  }, [])

  async function cambiarPassword() {
    setSavingPwd(true)
    try {
      const r = await apiFetch('/api/auth/me/password', { method: 'PATCH', body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd }) })
      if (r.status === 204) { toast.success('Contraseña actualizada. Otras sesiones cerradas.'); setCurrentPwd(''); setNewPwd('') }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSavingPwd(false) }
  }

  async function setup2FA() {
    setLoading2FA(true)
    try {
      const r = await apiFetch('/api/auth/2fa/setup')
      if (r.ok) { const j = await r.json(); setQrCode(j.qrCode) }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setLoading2FA(false) }
  }

  async function enable2FA() {
    if (totpPin.length !== 6) { toast.error('PIN de 6 dígitos requerido.'); return }
    setSaving2FA(true)
    try {
      const r = await apiFetch('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ totp: totpPin }) })
      if (r.status === 204) { toast.success('2FA activado.'); setTwoFAEnabled(true); setQrCode(null); setTotpPin('') }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSaving2FA(false) }
  }

  async function disable2FA() {
    if (totpPin.length !== 6) { toast.error('PIN de 6 dígitos requerido.'); return }
    setSaving2FA(true)
    try {
      const r = await apiFetch('/api/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ totp: totpPin }) })
      if (r.status === 204) { toast.success('2FA desactivado.'); setTwoFAEnabled(false); setTotpPin('') }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setSaving2FA(false) }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
        <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-600/30 flex items-center justify-center flex-shrink-0">
          <User size={18} className="text-blue-400" />
        </div>
        <div>
          <p className="font-semibold text-slate-100">{me?.nombre}</p>
          <p className="text-xs text-slate-500 mt-0.5 font-mono">{me?.permisos?.length ?? 0} permisos · {twoFAEnabled ? '2FA activo' : '2FA inactivo'}</p>
        </div>
      </div>

      {/* Cambiar contraseña */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <KeyRound size={13} />Cambiar Mi Contraseña
        </p>
        <div className="flex flex-col gap-2 max-w-sm">
          <div className="relative">
            <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type={showCurPwd ? 'text' : 'password'} value={currentPwd} onChange={e => setCurrentPwd(e.target.value)}
              placeholder="Contraseña actual"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-8 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors" />
            <button type="button" onClick={() => setShowCurPwd(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              {showCurPwd ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type={showNewPwd ? 'text' : 'password'} value={newPwd} onChange={e => setNewPwd(e.target.value)}
                placeholder="Nueva (mín. 8 + símbolo)"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-8 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors" />
              <button type="button" onClick={() => setShowNewPwd(v => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showNewPwd ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <button onClick={cambiarPassword} disabled={savingPwd || !currentPwd || newPwd.length < 8}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors disabled:opacity-40">
              {savingPwd ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
              Cambiar
            </button>
          </div>
        </div>
      </div>

      {/* 2FA */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Smartphone size={13} />Autenticación en 2 Pasos (TOTP)
        </p>
        {!twoFALoaded ? (
          <div className="flex items-center gap-2 text-slate-600 text-xs py-2 font-mono">
            <Loader2 size={13} className="animate-spin" />Cargando...
          </div>
        ) : twoFAEnabled ? (
          <div className="rounded-xl border border-emerald-600/30 bg-emerald-600/5 p-4 space-y-3 max-w-sm">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
              <p className="text-sm font-semibold text-emerald-400">2FA Activo</p>
            </div>
            <p className="text-xs text-slate-500">Para desactivar, confirma con tu app autenticadora.</p>
            <div className="flex gap-2">
              <input type="text" inputMode="numeric" maxLength={6}
                value={totpPin} onChange={e => setTotpPin(e.target.value.replace(/\D/g,'').slice(0,6))}
                placeholder="000000"
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center text-lg tracking-[0.4em] text-slate-100 placeholder-slate-700 focus:outline-none focus:border-red-500/50 transition-colors font-mono" />
              <button onClick={disable2FA} disabled={saving2FA || totpPin.length !== 6}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600/15 hover:bg-red-600/25 text-red-400 border border-red-600/30 text-sm font-medium transition-colors disabled:opacity-40">
                {saving2FA ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
                Desactivar
              </button>
            </div>
          </div>
        ) : qrCode ? (
          <div className="rounded-xl border border-cyan-600/30 bg-cyan-600/5 p-4 space-y-3 max-w-sm">
            <p className="text-xs font-semibold text-cyan-400 flex items-center gap-1.5"><QrCode size={13} />Escanea con tu app autenticadora</p>
            <div className="flex justify-center">
              <img src={qrCode} alt="QR 2FA" className="w-40 h-40 rounded-xl border border-slate-700 bg-white p-1" />
            </div>
            <p className="text-xs text-slate-500 text-center">Google Authenticator · Authy · etc.</p>
            <p className="text-xs text-slate-400">Ingresa el PIN generado para confirmar:</p>
            <div className="flex gap-2">
              <input type="text" inputMode="numeric" maxLength={6}
                value={totpPin} onChange={e => setTotpPin(e.target.value.replace(/\D/g,'').slice(0,6))}
                placeholder="000000" autoFocus
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center text-lg tracking-[0.4em] text-slate-100 placeholder-slate-700 focus:outline-none focus:border-cyan-500/50 transition-colors font-mono" />
              <button onClick={enable2FA} disabled={saving2FA || totpPin.length !== 6}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600/80 hover:bg-cyan-600 text-white text-sm font-semibold transition-colors disabled:opacity-40">
                {saving2FA ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                Activar
              </button>
            </div>
            <button onClick={() => { setQrCode(null); setTotpPin('') }} className="text-xs text-slate-600 hover:text-slate-400 transition-colors w-full text-center">
              Cancelar
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-4 space-y-3 max-w-sm">
            <p className="text-xs text-slate-500 leading-relaxed">
              Protege tu cuenta con una app TOTP (Google Authenticator, Authy).
              Se requerirá un código temporal en cada inicio de sesión.
            </p>
            <button onClick={setup2FA} disabled={loading2FA}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 border border-blue-600/30 text-sm font-medium transition-colors disabled:opacity-40">
              {loading2FA ? <Loader2 size={13} className="animate-spin" /> : <QrCode size={13} />}
              Configurar 2FA
            </button>
          </div>
        )}
      </div>

      {/* Sesiones activas */}
      <div className="pt-2 border-t border-slate-800">
        <SesionesActivas />
      </div>
    </div>
  )
}

function SesionesActivas() {
  const [sessions, setSessions]     = useState([])
  const [curJti,   setCurJti]       = useState(null)
  const [loading,  setLoading]      = useState(false)
  const [revoking, setRevoking]     = useState(null)

  async function cargar() {
    setLoading(true)
    try {
      const r = await apiFetch('/api/auth/me/sessions')
      if (r.ok) { const j = await r.json(); setSessions(j.data ?? []); if (j.current) setCurJti(j.current) }
      else toast.error('Error al cargar sesiones.')
    } catch { toast.error('Error de conexión') }
    finally { setLoading(false) }
  }

  async function revocar(jti) {
    setRevoking(jti)
    try {
      const r = await apiFetch(`/api/auth/me/sessions/${jti}`, { method: 'DELETE' })
      if (r.status === 204) { toast.success('Sesión cerrada.'); setSessions(s => s.filter(x => x.jti !== jti)) }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setRevoking(null) }
  }

  useEffect(() => { cargar() }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
          <Monitor size={13} />Dispositivos Conectados
        </p>
        <button onClick={cargar} className="text-slate-600 hover:text-slate-400 transition-colors">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {loading && sessions.length === 0
        ? <div className="flex items-center gap-2 text-slate-600 text-xs py-2 font-mono"><Loader2 size={13} className="animate-spin" />Cargando...</div>
        : sessions.length === 0
        ? <p className="text-xs text-slate-600 font-mono py-2">Sin sesiones activas.</p>
        : (
          <div className="space-y-2">
            {sessions.map(s => {
              const isCurrent = s.jti === curJti
              return (
                <div key={s.jti} className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                  isCurrent ? 'bg-blue-600/10 border-blue-600/30' : 'bg-slate-800/30 border-slate-700/30'
                }`}>
                  <Monitor size={15} className={isCurrent ? 'text-blue-400' : 'text-slate-500'} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-xs font-semibold ${isCurrent ? 'text-blue-300' : 'text-slate-300'}`}>
                        {parseUA(s.userAgent)}
                      </p>
                      {isCurrent && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 border border-blue-600/30 flex-shrink-0">
                          Actual
                        </span>
                      )}
                      {formatIP(s.ip) && (
                        <span className="flex items-center gap-0.5 text-[10px] text-slate-600 font-mono flex-shrink-0">
                          <MapPin size={9} />{formatIP(s.ip)}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-600 font-mono mt-0.5 truncate" title={s.userAgent}>
                      {new Date(s.createdAt).toLocaleString('es-DO')} · exp {new Date(s.expiresAt).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  {!isCurrent && (
                    <button onClick={() => revocar(s.jti)} disabled={revoking === s.jti}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-600/15 hover:bg-red-600/25 text-red-400 border border-red-600/30 text-[11px] font-medium transition-colors disabled:opacity-40 flex-shrink-0">
                      {revoking === s.jti ? <Loader2 size={11} className="animate-spin" /> : <Trash size={11} />}
                      Cerrar
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )
      }
    </div>
  )
}

function parseUA(ua) {
  if (!ua) return 'Dispositivo desconocido'
  if (/mobile|android/i.test(ua)) return 'Móvil'
  if (/windows/i.test(ua)) return 'Windows'
  if (/mac/i.test(ua)) return 'Mac'
  if (/linux/i.test(ua)) return 'Linux'
  return 'Navegador'
}

function formatIP(ip) {
  if (!ip) return null
  if (ip === '::1' || ip === '127.0.0.1') return 'Localhost'
  return ip
}

function PanelSesionesGlobales() {
  const [sessions, setSessions] = useState([])
  const [curJti,   setCurJti]   = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [revoking, setRevoking] = useState(null)

  async function cargar() {
    setLoading(true)
    try {
      const r = await apiFetch('/api/admin/sessions')
      if (r.ok) { const j = await r.json(); setSessions(j.data ?? []); if (j.current) setCurJti(j.current) }
      else toast.error('Error al cargar sesiones globales.')
    } catch { toast.error('Error de conexión') }
    finally { setLoading(false) }
  }

  async function revocar(jti) {
    setRevoking(jti)
    try {
      const r = await apiFetch(`/api/admin/sessions/token/${jti}`, { method: 'DELETE' })
      if (r.status === 204) { toast.success('Sesión terminada.'); setSessions(s => s.filter(x => x.jti !== jti)) }
      else toast.error((await r.json()).error)
    } catch { toast.error('Error de conexión') }
    finally { setRevoking(null) }
  }

  useEffect(() => { cargar() }, [])

  const byEmployee = sessions.reduce((acc, s) => {
    const key = s.empleado?.id ?? 'unknown'
    if (!acc[key]) acc[key] = { empleado: s.empleado, sessions: [] }
    acc[key].sessions.push(s)
    return acc
  }, {})

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-bold text-amber-400 flex items-center gap-2">
            <Globe size={15} />Ojo de Dios — Sesiones Activas
          </p>
          <p className="text-xs text-slate-600 mt-0.5 font-mono">{sessions.length} sesión{sessions.length !== 1 ? 'es' : ''} activa{sessions.length !== 1 ? 's' : ''} en el sistema</p>
        </div>
        <button onClick={cargar} className="text-slate-600 hover:text-slate-400 transition-colors">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && sessions.length === 0
        ? <div className="flex items-center gap-2 text-slate-600 text-xs py-4 font-mono"><Loader2 size={13} className="animate-spin" />Cargando...</div>
        : sessions.length === 0
        ? <p className="text-xs text-slate-600 font-mono py-4">Sin sesiones activas en el sistema.</p>
        : (
          <div className="space-y-4">
            {Object.values(byEmployee).map(({ empleado, sessions: empSessions }) => (
              <div key={empleado?.id ?? 'unknown'} className="rounded-xl border border-slate-700/40 bg-slate-800/20 overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-800/40 border-b border-slate-700/40 flex items-center gap-2">
                  <User size={13} className="text-slate-400" />
                  <span className="text-xs font-semibold text-slate-300">{empleado?.nombre ?? 'Desconocido'}</span>
                  <span className="text-[10px] text-slate-600 font-mono">· {empleado?.cargo}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
                    {empSessions.length} sesión{empSessions.length !== 1 ? 'es' : ''}
                  </span>
                </div>
                <div className="divide-y divide-slate-800/60">
                  {empSessions.map(s => {
                    const isCurrent = s.jti === curJti
                    return (
                      <div key={s.jti} className={`flex items-center gap-3 px-4 py-3 ${isCurrent ? 'bg-amber-600/5' : ''}`}>
                        <Monitor size={14} className={isCurrent ? 'text-amber-400' : 'text-slate-500'} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs font-semibold ${isCurrent ? 'text-amber-300' : 'text-slate-300'}`}>
                              {parseUA(s.userAgent)}
                            </span>
                            {isCurrent && (
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400 border border-amber-600/30">
                                Tu sesión
                              </span>
                            )}
                            {formatIP(s.ip) && (
                              <span className="flex items-center gap-0.5 text-[10px] text-slate-500 font-mono">
                                <MapPin size={9} />{formatIP(s.ip)}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-600 font-mono mt-0.5">
                            Inicio: {new Date(s.createdAt).toLocaleString('es-DO')} · Exp: {new Date(s.expiresAt).toLocaleString('es-DO')}
                          </p>
                        </div>
                        {!isCurrent && (
                          <button onClick={() => revocar(s.jti)} disabled={revoking === s.jti}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-600/15 hover:bg-red-600/25 text-red-400 border border-red-600/30 text-[11px] font-medium transition-colors disabled:opacity-40 flex-shrink-0">
                            {revoking === s.jti ? <Loader2 size={11} className="animate-spin" /> : <Trash size={11} />}
                            Terminar
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      }
    </div>
  )
}

// ─── Panel Portal B2C ─────────────────────────────────────────────────────────

const PORTAL_TOGGLES = [
  { key: 'mostrarServicios',  label: 'Mostrar Servicios',          desc: 'Lista de servicios WISP, CCTV y Redes en el portal público.',         color: 'blue'    },
  { key: 'mostrarCotizador',  label: 'Mostrar Cotizador Inbound',  desc: 'Widget "Arma tu Plan" con calculadora de precios en tiempo real.',    color: 'indigo'  },
  { key: 'mostrarMapa',       label: 'Mostrar Mapa de Cobertura',  desc: 'Mapa Leaflet con polígono de cobertura WISP en Cristo Rey, SD.',      color: 'emerald' },
  { key: 'mostrarEquipos',    label: 'Mostrar Equipos en Venta',   desc: 'Catálogo de equipos disponibles para compra directa.',               color: 'amber'   },
  { key: 'permitirPagos',     label: 'Habilitar Botón de Pagos',   desc: 'Muestra botón "Pagar" en facturas vencidas del dashboard del cliente.', color: 'red'   },
]

function PanelPortalB2C() {
  const { tienePermiso } = useAuth()
  const canEdit = tienePermiso('sistema:config')
  const [settings, setSettings] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [dirty,    setDirty]    = useState(false)

  useEffect(() => {
    apiFetch('/api/portal/settings')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setSettings(data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function toggle(key) {
    if (!canEdit) return
    setSettings(prev => ({ ...prev, [key]: !prev[key] }))
    setDirty(true)
  }

  async function guardar() {
    setSaving(true)
    try {
      const r = await apiFetch('/api/portal/settings', {
        method: 'PUT',
        body: JSON.stringify({
          mostrarEquipos:   !!settings.mostrarEquipos,
          permitirPagos:    !!settings.permitirPagos,
          mostrarMapa:      !!settings.mostrarMapa,
          mostrarCotizador: !!settings.mostrarCotizador,
          mostrarServicios: !!settings.mostrarServicios,
        }),
      })
      if (r.ok) {
        const data = await r.json()
        setSettings(data)
        setDirty(false)
        toast.success('Configuración del portal actualizada.')
      } else {
        const err = await r.json().catch(() => ({}))
        toast.error(err.error ?? 'Error al guardar.')
      }
    } catch { toast.error('Error de conexión.') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
  if (!settings) return <p className="text-sm text-slate-600 text-center py-8">No se pudo cargar la configuración del portal.</p>

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-100">Portal B2C — Visibilidad de Secciones</h2>
          <p className="text-xs text-slate-500 mt-0.5">Controla qué secciones se muestran en el portal público de clientes.</p>
        </div>
        {canEdit && dirty && (
          <button onClick={guardar} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Guardar
          </button>
        )}
      </div>

      <div className="space-y-2.5">
        {PORTAL_TOGGLES.map(({ key, label, desc, color }) => {
          const c  = COLOR_MAP[color] ?? COLOR_MAP.blue
          const on = !!settings[key]
          return (
            <div key={key} className={`flex items-center justify-between p-4 rounded-xl border transition-all ${
              on ? `${c.bg} ${c.border}` : 'bg-slate-800/30 border-slate-700/30'
            }`}>
              <div className="flex-1 min-w-0 mr-4">
                <p className={`text-sm font-semibold ${on ? c.text : 'text-slate-400'}`}>{label}</p>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
              </div>
              <Toggle on={on} onChange={() => toggle(key)} disabled={!canEdit} />
            </div>
          )
        })}
      </div>

      {!canEdit && (
        <p className="text-xs text-slate-600 text-center py-1">
          Requiere permiso <code className="font-mono text-slate-500">sistema:config</code>
        </p>
      )}

      <div className="pt-2 border-t border-slate-800">
        <p className="text-[10px] text-slate-700 font-mono">URL del portal: <span className="text-slate-500">/portal</span></p>
      </div>
    </div>
  )
}

function PanelIncidencias() {
  const [data, setData]       = useState([])
  const [loading, setLoading] = useState(true)
  const [filtro, setFiltro]   = useState('pendientes')
  const [resolviendo, setResolviendo] = useState(null)
  const [resolucion, setResolucion]   = useState('')

  async function cargar() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filtro === 'pendientes') params.set('resueltas', 'false')
      if (filtro === 'resueltas')  params.set('resueltas', 'true')
      const r = await apiFetch(`/api/incidencias?${params}`)
      const j = await r.json()
      setData(Array.isArray(j.data) ? j.data : [])
    } catch { setData([]) }
    finally { setLoading(false) }
  }
  useEffect(() => { cargar() }, [filtro]) // eslint-disable-line

  async function resolver() {
    if (!resolviendo || resolucion.length < 3) { toast.error('Describe la resolución (min 3 chars).'); return }
    try {
      const r = await apiFetch(`/api/incidencias/${resolviendo.id}/resolver`, { method: 'PATCH', body: JSON.stringify({ resolucion }) })
      if (r.ok) { toast.success('Incidencia resuelta.'); setResolviendo(null); setResolucion(''); cargar() }
      else      { toast.error('Error al resolver.') }
    } catch { toast.error('Error de red.') }
  }

  const SEV_COLOR = {
    CRITICA: 'bg-red-500/15 text-red-400 border-red-500/30',
    ALTA:    'bg-orange-500/15 text-orange-400 border-orange-500/30',
    MEDIA:   'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  }
  const TIPO_LABEL = {
    ROBO_EQUIPO:        '🚨 Posible robo',
    FUGA_EFECTIVO:      '💸 Fuga efectivo',
    DISCREPANCIA_STOCK: '📦 Discrepancia stock',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle size={18} className="text-red-400" />
        <h2 className="text-lg font-bold text-slate-100">Incidencias de Reconciliación · {data.length}</h2>
        <button onClick={cargar} className="ml-auto p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      <div className="flex gap-1 bg-slate-800/50 rounded-lg p-1 w-fit">
        {[
          { id: 'pendientes', label: 'Pendientes' },
          { id: 'resueltas',  label: 'Resueltas'  },
          { id: 'todas',      label: 'Todas'      },
        ].map(o => (
          <button key={o.id} onClick={() => setFiltro(o.id)}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition ${filtro === o.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">Generadas por <code>backend/scripts/reconciliar.js</code>. Programa cron diario 23:00.</p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
      ) : data.length === 0 ? (
        <p className="text-center text-sm text-slate-600 py-12">Sin incidencias {filtro === 'pendientes' ? 'pendientes' : ''}.</p>
      ) : (
        <div className="space-y-2">
          {data.map(inc => (
            <div key={inc.id} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-bold text-slate-100">{TIPO_LABEL[inc.tipo] ?? inc.tipo}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${SEV_COLOR[inc.severidad] ?? 'bg-slate-700/30 text-slate-400 border-slate-600/30'}`}>{inc.severidad}</span>
                    <span className="text-[10px] text-slate-600">#{inc.id} · {new Date(inc.createdAt).toLocaleDateString('es-DO')}</span>
                  </div>
                  <p className="text-xs text-slate-300">{inc.descripcion}</p>
                  {inc.resueltoEn && (
                    <p className="text-[10px] text-emerald-400 mt-1.5">
                      ✓ Resuelta {new Date(inc.resueltoEn).toLocaleDateString('es-DO')} por {inc.empleado?.nombre ?? 'sistema'}: {inc.resolucion}
                    </p>
                  )}
                </div>
                {!inc.resueltoEn && (
                  <button onClick={() => setResolviendo(inc)} className="px-3 py-1.5 rounded bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-semibold flex items-center gap-1">
                    <CheckCircle size={11} />Resolver
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {resolviendo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-emerald-600/30 rounded-xl max-w-md w-full p-5 space-y-3">
            <h3 className="text-sm font-bold text-slate-100">Resolver incidencia #{resolviendo.id}</h3>
            <p className="text-xs text-slate-400">{resolviendo.descripcion}</p>
            <textarea rows={3} value={resolucion} onChange={e => setResolucion(e.target.value)}
              placeholder="Explica la resolución (ej. 'Equipo encontrado en cajón B'/'Factura emitida #FAC-0042')"
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200" autoFocus />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setResolviendo(null); setResolucion('') }} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancelar</button>
              <button onClick={resolver} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded">Confirmar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Configuracion() {
  const { tienePermiso } = useAuth()
  const isAdmin = tienePermiso('sistema:admin')
  const isOwner = tienePermiso('sistema:owner')
  const [activeTab,  setActiveTab]  = useState(isAdmin ? 'usuarios' : 'mi-perfil')
  const [permGroups, setPermGroups] = useState([])
  const [empleados,  setEmpleados]  = useState([])
  const [roles,      setRoles]      = useState([])
  const [selEmp,     setSelEmp]     = useState(null)
  const [selRol,     setSelRol]     = useState(null)
  const [newRolMode, setNewRolMode] = useState(false)
  const [loading,    setLoading]    = useState(false)

  const cargar = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    try {
      const [rEmp, rRoles, rPerms] = await Promise.all([
        apiFetch('/api/admin/empleados'),
        apiFetch('/api/roles'),
        apiFetch('/api/auth/permissions'),
      ])
      if (rEmp.ok) {
        const j = await rEmp.json()
        setEmpleados(j.data ?? [])
        setSelEmp(sel => sel ? (j.data?.find(e => e.id === sel.id) ?? j.data?.[0] ?? null) : (j.data?.[0] ?? null))
      }
      if (rRoles.ok) {
        const j = await rRoles.json()
        setRoles(j.data ?? [])
        setSelRol(prev => prev ? (j.data?.find(r => r.id === prev.id) ?? null) : null)
      }
      if (rPerms.ok) {
        const flat = await rPerms.json()
        setPermGroups(buildPermGroups(flat))
      }
    } catch {}
    finally { setLoading(false) }
  }, [isAdmin])

  useEffect(() => { cargar() }, [cargar])

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 font-mono tracking-tight">Configuración</h1>
          <p className="text-sm text-slate-500 mt-0.5">{isAdmin ? 'RBAC Híbrido · Roles + Permisos Extra por Usuario' : 'Perfil & Seguridad Personal'}</p>
        </div>
        {isAdmin && (
          <button onClick={cargar} className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-800/50 rounded-xl p-1 w-fit border border-slate-700/50">
        <button onClick={() => setActiveTab('mi-perfil')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'mi-perfil' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'}`}>
          <User size={14} />Mi Perfil
        </button>
        {isAdmin && [
          { key: 'usuarios', label: 'Usuarios', Icon: Users },
          { key: 'roles',    label: 'Roles',    Icon: Shield },
        ].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === key ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Icon size={14} />{label}
          </button>
        ))}
        {isAdmin && (
          <button onClick={() => setActiveTab('portal')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'portal' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Store size={14} />Portal B2C
          </button>
        )}
        {isAdmin && (
          <button onClick={() => setActiveTab('empresa')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'empresa' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Building2Icon size={14} />Mi Empresa
          </button>
        )}
        {isOwner && (
          <button onClick={() => setActiveTab('sesiones')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'sesiones' ? 'bg-amber-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Globe size={14} />Sesiones
          </button>
        )}
        {isOwner && (
          <button onClick={() => setActiveTab('api')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'api' ? 'bg-cyan-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <Activity size={14} />API
          </button>
        )}
        {isOwner && (
          <button onClick={() => setActiveTab('incidencias')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'incidencias' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-100'
            }`}>
            <AlertTriangle size={14} />Incidencias
          </button>
        )}
      </div>

      {activeTab === 'api'         && isOwner && <PanelApiEstado />}
      {activeTab === 'incidencias' && isOwner && <PanelIncidencias />}
      {activeTab === 'empresa'     && isAdmin && <PanelMiEmpresa />}

      {/* ── Tab: Mi Perfil ──────────────────────────────────────────────────── */}
      {activeTab === 'mi-perfil' && (
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5 max-w-xl">
          <PanelMiPerfil />
        </div>
      )}

      {/* ── Tab: Usuarios ───────────────────────────────────────────────────── */}
      {activeTab === 'usuarios' && (
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden h-fit">
            <div className="px-4 py-3 border-b border-slate-800">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Usuarios</p>
            </div>
            {loading && empleados.length === 0
              ? <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-blue-500" /></div>
              : <div className="divide-y divide-slate-800">
                  {empleados.map(e => {
                    const esOwner = e.roles?.some(r => Array.isArray(r.permisos) && r.permisos.includes('sistema:owner'))
                    return (
                      <button key={e.id} onClick={() => setSelEmp(e)}
                        className={`w-full text-left px-4 py-3 transition-colors hover:bg-slate-800/60 ${selEmp?.id === e.id ? 'bg-blue-600/10 border-r-2 border-blue-500' : ''}`}>
                        <div className="flex items-center gap-1.5">
                          <p className={`text-sm font-medium leading-tight ${selEmp?.id === e.id ? 'text-blue-300' : 'text-slate-200'}`}>{e.nombre}</p>
                          {esOwner && <Crown size={10} className="text-amber-400 flex-shrink-0" />}
                        </div>
                        <p className="text-xs text-slate-600 mt-0.5">{e.cargo}</p>
                        {e.bloqueado && <span className="inline-flex items-center gap-0.5 text-[10px] text-red-400 mt-1"><Ban size={9} />bloqueado</span>}
                        {Array.isArray(e.permisosExtra) && e.permisosExtra.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500 mt-0.5"><Sparkles size={9} />{e.permisosExtra.length} extra</span>
                        )}
                      </button>
                    )
                  })}
                </div>
            }
          </div>
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
            {selEmp
              ? <PanelUsuario key={selEmp.id} empleado={selEmp} roles={roles} permGroups={permGroups} onUpdated={cargar} />
              : <p className="text-sm text-slate-600 text-center py-8">Selecciona un usuario</p>
            }
          </div>
        </div>
      )}

      {/* ── Tab: Portal B2C ─────────────────────────────────────────────────── */}
      {activeTab === 'portal' && isAdmin && (
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <PanelPortalB2C />
        </div>
      )}

      {/* ── Tab: Sesiones Globales (Owner) ──────────────────────────────────── */}
      {activeTab === 'sesiones' && isOwner && (
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <PanelSesionesGlobales />
        </div>
      )}

      {/* ── Tab: Roles ──────────────────────────────────────────────────────── */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden h-fit">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Roles</p>
              <button onClick={() => { setNewRolMode(true); setSelRol(null) }}
                className="p-1 rounded text-slate-500 hover:text-slate-100 hover:bg-slate-700 transition-colors" title="Nuevo Rol">
                <Plus size={14} />
              </button>
            </div>
            {loading && roles.length === 0
              ? <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-blue-500" /></div>
              : <div className="divide-y divide-slate-800">
                  {[...roles].sort((a, b) => (b.nivel ?? 0) - (a.nivel ?? 0)).map(r => (
                    <button key={r.id} onClick={() => { setSelRol(r); setNewRolMode(false) }}
                      className={`w-full text-left px-4 py-3 transition-colors hover:bg-slate-800/60 ${
                        !newRolMode && selRol?.id === r.id ? 'bg-blue-600/10 border-r-2 border-blue-500' : ''
                      }`}>
                      <div className="flex items-center gap-1.5">
                        <p className={`text-sm font-medium leading-tight flex-1 min-w-0 truncate ${!newRolMode && selRol?.id === r.id ? 'text-blue-300' : 'text-slate-200'}`}>{r.nombre}</p>
                        {r.nivel > 0 && (
                          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded flex-shrink-0 ${
                            r.nivel >= 100 ? 'bg-amber-600/20 text-amber-400' :
                            r.nivel >= 80  ? 'bg-blue-600/20 text-blue-400' :
                            r.nivel >= 50  ? 'bg-indigo-600/20 text-indigo-400' :
                            'bg-slate-700 text-slate-500'
                          }`}>
                            niv.{r.nivel}
                          </span>
                        )}
                        {!r.activo && <span className="text-[10px] text-slate-600 font-mono">(off)</span>}
                      </div>
                      <p className="text-[10px] text-slate-600 mt-0.5 font-mono">
                        {Array.isArray(r.permisos) ? r.permisos.length : 0} permisos
                        {r._count?.empleados != null ? ` · ${r._count.empleados} usuarios` : ''}
                      </p>
                    </button>
                  ))}
                </div>
            }
          </div>
          <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
            {newRolMode
              ? <PanelRol key="new" rol={null} permGroups={permGroups} onUpdated={() => { setNewRolMode(false); cargar() }} />
              : selRol
              ? <PanelRol key={selRol.id} rol={selRol} permGroups={permGroups} onUpdated={cargar} />
              : (
                <div className="text-center py-10">
                  <Shield size={30} className="text-slate-700 mx-auto mb-3" />
                  <p className="text-sm text-slate-600 mb-1">Selecciona un rol o crea uno nuevo</p>
                  <button onClick={() => setNewRolMode(true)}
                    className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600/15 text-blue-400 border border-blue-600/30 text-sm font-medium hover:bg-blue-600/25 transition-colors">
                    <Plus size={13} />Nuevo Rol
                  </button>
                </div>
              )
            }
          </div>
        </div>
      )}
    </div>
  )
}
