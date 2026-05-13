import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  Plus, Search, Loader2, Save, X, RefreshCw,
  ClipboardList, FileText, User, Trash2, DollarSign, ChevronDown, ChevronRight,
} from 'lucide-react'
import { apiFetch } from '../../utils/api'
import { useAuth } from '../../contexts/AuthContext'
import EditorDescripcion from '../../components/EditorDescripcion'

// Helpers para descripción estructurada (mirror de pdf-templates _tryParseEstructurada).
function _parseDescEstruct(raw) {
  if (!raw || typeof raw !== 'string') return null
  const t = raw.trim()
  if (t.length < 2 || t[0] !== '{') return null
  try {
    const obj = JSON.parse(t)
    if (obj && obj.v === 1) return obj
  } catch {}
  return null
}
function _tituloDesc(raw) {
  const obj = _parseDescEstruct(raw)
  if (obj) return obj.titulo ?? ''
  return raw ?? ''
}
function _serializarDesc(val) {
  if (val == null) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'object' && val.v === 1) {
    const limpio = {
      v: 1,
      titulo:  String(val.titulo ?? '').slice(0, 200),
      bullets: Array.isArray(val.bullets) ? val.bullets.filter(b => b && b.trim()).slice(0, 30) : [],
    }
    return JSON.stringify(limpio)
  }
  return ''
}
import {
  TIPOS_OT, ESTADOS_OT, META_DEFAULTS,
  TH, LABEL_CLS, INPUT_CLS, SELECT_CLS, PAGE_SIZE,
  formatCurrency, formatDate,
  OtTipoBadge, OtEstadoBadge,
} from './_shared'

// ── MetadatosFields ───────────────────────────────────────────────────────────

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

// ── ClienteSearch ─────────────────────────────────────────────────────────────

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

// ── LineasPicker ──────────────────────────────────────────────────────────────

function LineasPicker({ lineas, setLineas }) {
  const [catalog, setCatalog] = useState([])
  const [search,  setSearch]  = useState('')
  const [show,    setShow]    = useState(false)
  const [expanded, setExpanded] = useState(null)  // index de la línea con detalle abierto
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
    // Preserva la descripción estructurada del catálogo si existe (v=1 JSON).
    // Si no hay descripción, usa el nombre como título base de un objeto v=1.
    const descSource = item.descripcion ?? ''
    const descEstruct = _parseDescEstruct(descSource)
    const descripcion = descEstruct
      ? JSON.stringify(descEstruct)
      : JSON.stringify({ v: 1, titulo: item.nombre, bullets: descSource ? [descSource] : [] })
    setLineas(prev => [...prev, {
      itemCatalogoId: item.id,
      descripcion,
      cantidad:       1,
      precioUnitario: Number(item.precio),
      consumoInterno: false,    // por default es facturable
    }])
    setSearch(''); setShow(false)
  }

  function remove(i) { setLineas(prev => prev.filter((_, idx) => idx !== i)) }
  function upd(i, k, v) { setLineas(prev => prev.map((l, idx) => idx === i ? { ...l, [k]: v } : l)) }

  const filtered = catalog
    .filter(c => !search || c.nombre.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 10)

  const total = (Array.isArray(lineas) ? lineas : []).reduce((s, l) => s + Number(l.precioUnitario) * (Number(l.cantidad) || 1), 0)

  return (
    <div className="space-y-2">
      {lineas.length > 0 && (
        <div className="bg-slate-800/50 border border-slate-700/40 rounded-lg overflow-hidden">
          <div className="divide-y divide-slate-700/40">
            {(Array.isArray(lineas) ? lineas : []).map((l, i) => {
              const isOpen = expanded === i
              const estruct = _parseDescEstruct(l.descripcion)
              const titulo  = estruct?.titulo ?? l.descripcion ?? ''
              const bulletsCount = Array.isArray(estruct?.bullets) ? estruct.bullets.length : 0
              return (
                <div key={i}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button type="button" onClick={() => setExpanded(isOpen ? null : i)}
                      className="text-slate-500 hover:text-blue-400 transition-colors flex-shrink-0"
                      title={isOpen ? 'Ocultar detalle' : 'Editar título + bullets'}>
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <input value={titulo}
                        onChange={e => {
                          // Edita solo el título; preserva bullets si la línea es estructurada.
                          if (estruct) {
                            upd(i, 'descripcion', _serializarDesc({ ...estruct, titulo: e.target.value }))
                          } else {
                            upd(i, 'descripcion', e.target.value)
                          }
                        }}
                        className="w-full bg-transparent text-xs text-slate-200 focus:outline-none focus:underline decoration-slate-600 truncate" />
                      {bulletsCount > 0 && !isOpen && (
                        <p className="text-[9px] text-slate-600 font-mono mt-0.5 truncate">
                          {bulletsCount} viñeta{bulletsCount === 1 ? '' : 's'} · {(estruct.bullets[0] ?? '').slice(0, 40)}{(estruct.bullets[0] ?? '').length > 40 ? '…' : ''}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* Toggle consumoInterno: si está ON, esta línea NO se factura al cliente
                          pero SÍ descuenta stock al cerrar la OT (BOM oculto de instalación). */}
                      <button type="button" onClick={() => upd(i, 'consumoInterno', !l.consumoInterno)}
                        title={l.consumoInterno ? 'Consumo interno · NO factura' : 'Facturable · cliente paga'}
                        className={`px-1.5 py-1 rounded text-[9px] font-bold uppercase transition-colors border ${
                          l.consumoInterno
                            ? 'bg-amber-600/20 text-amber-300 border-amber-600/40'
                            : 'bg-emerald-600/15 text-emerald-300 border-emerald-600/30'
                        }`}>
                        {l.consumoInterno ? '🔧 Interno' : '💰 Fact'}
                      </button>
                      <input type="number" min="1" value={l.cantidad}
                        onChange={e => upd(i, 'cantidad', parseInt(e.target.value) || 1)}
                        className="w-10 text-center bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 py-1 focus:outline-none focus:border-blue-500" />
                      <span className="text-[10px] text-slate-600">×</span>
                      <input type="number" min="0" step="0.01" value={l.precioUnitario}
                        onChange={e => upd(i, 'precioUnitario', parseFloat(e.target.value) || 0)}
                        disabled={l.consumoInterno}
                        title={l.consumoInterno ? 'Precio ignorado en facturación (consumo interno)' : ''}
                        className={`w-20 text-right border rounded text-xs py-1 px-1.5 font-mono focus:outline-none focus:border-blue-500 ${
                          l.consumoInterno ? 'bg-slate-800 border-slate-700 text-slate-500' : 'bg-slate-700 border-slate-600 text-slate-200'
                        }`} />
                      <button onClick={() => remove(i)} className="text-slate-600 hover:text-red-400 transition-colors ml-0.5">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="px-3 py-3 bg-slate-900/50 border-t border-slate-700/30">
                      <EditorDescripcion
                        value={estruct ?? l.descripcion}
                        onChange={v => upd(i, 'descripcion', _serializarDesc(v))}
                        mostrarImagen={false}
                      />
                    </div>
                  )}
                </div>
              )
            })}
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

// ── NuevaOTModal ──────────────────────────────────────────────────────────────

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
        lineas:       (Array.isArray(form.lineas) ? form.lineas : []).map(l => ({
          itemCatalogoId: l.itemCatalogoId,
          descripcion:    l.descripcion,
          cantidad:       Number(l.cantidad) || 1,
          // Si es consumo interno, el precio se fuerza a 0 (no factura).
          precioUnitario: l.consumoInterno ? 0 : (Number(l.precioUnitario) || 0),
          consumoInterno: !!l.consumoInterno,
        })),
      }
      const r = await apiFetch('/api/ventas/ordenes', { method: 'POST', body: JSON.stringify(body) })
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
                setLineas={updater => setForm(f => ({
                  ...f,
                  // LineasPicker llama setLineas con un updater (prev => next) estilo React.
                  // El wrapper original ignoraba esto y guardaba la función como valor
                  // -> form.lineas dejaba de ser array -> submit enviaba [] y backend 400.
                  lineas: typeof updater === 'function'
                    ? updater(Array.isArray(f.lineas) ? f.lineas : [])
                    : (Array.isArray(updater) ? updater : []),
                }))}
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

// ── PanelOrdenes ──────────────────────────────────────────────────────────────

export default function PanelOrdenes({ canEdit, clienteIdInit, clienteNombreInit }) {
  const { tienePermiso }                   = useAuth()
  const canBill                            = tienePermiso('factura:emitir')
  const [ordenes,       setOrdenes]       = useState([])
  const [loading,       setLoading]       = useState(false)
  const [billing,       setBilling]       = useState(null)
  const [showModal,     setShowModal]     = useState(!!clienteIdInit)
  const [filtroEstado,  setFiltroEstado]  = useState('')
  const [filtroTipo,    setFiltroTipo]    = useState('')
  const [filtroNumero,  setFiltroNumero]  = useState('')
  const [filtroCliente, setFiltroCliente] = useState('')
  const [filtroDesde,   setFiltroDesde]   = useState('')
  const [filtroHasta,   setFiltroHasta]   = useState('')
  const [page,          setPage]          = useState(0)
  const [total,         setTotal]         = useState(0)
  const [detalle,       setDetalle]       = useState(null)   // slide-over: OT seleccionada

  const fetchOrdenes = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (filtroEstado)  p.set('estado',        filtroEstado)
      if (filtroTipo)    p.set('tipoOT',        filtroTipo)
      if (filtroNumero)  p.set('search',        filtroNumero.trim())
      if (filtroCliente) p.set('clienteNombre', filtroCliente.trim())
      if (filtroDesde)   p.set('desde',         filtroDesde)
      if (filtroHasta)   p.set('hasta',         filtroHasta)
      p.set('limit',  String(PAGE_SIZE))
      p.set('offset', String(page * PAGE_SIZE))
      const r = await apiFetch(`/api/ventas/ordenes?${p}`)
      if (r.ok) { const j = await r.json(); setOrdenes(j.data ?? []); setTotal(j.total ?? 0) }
    } catch {}
    finally { setLoading(false) }
  }, [filtroEstado, filtroTipo, filtroNumero, filtroCliente, filtroDesde, filtroHasta, page])

  useEffect(() => { setPage(0) }, [filtroEstado, filtroTipo, filtroNumero, filtroCliente, filtroDesde, filtroHasta])
  useEffect(() => { fetchOrdenes() }, [fetchOrdenes])

  function limpiarFiltros() {
    setFiltroEstado(''); setFiltroTipo(''); setFiltroNumero('')
    setFiltroCliente(''); setFiltroDesde(''); setFiltroHasta('')
  }
  const hayFiltros = !!(filtroEstado || filtroTipo || filtroNumero || filtroCliente || filtroDesde || filtroHasta)

  async function facturarOT(ot) {
    if (!window.confirm(`¿Facturar la OT de "${ot.cliente?.razonSocial}"?\nEsto generará el NCF y marcará la OT como Completada.`)) return
    setBilling(ot.id)
    try {
      const r = await apiFetch('/api/ventas/facturas', { method: 'POST', body: JSON.stringify({ ordenId: ot.id }) })
      const j = await r.json()
      if (!r.ok) { toast.error(j.error ?? 'Error al facturar.'); return }
      toast.success(`Factura emitida · NCF ${j.ncf}`)
      fetchOrdenes()
    } catch { toast.error('Error de conexión.') }
    finally { setBilling(null) }
  }

  async function eliminarOT(ot) {
    if (!window.confirm(`¿Eliminar la OT ${ot.noOT ?? ot.id}?\nEsta acción es reversible solo por un administrador.`)) return
    try {
      const r = await apiFetch(`/api/ventas/ordenes/${ot.id}`, { method: 'DELETE' })
      if (!r.ok) { const j = await r.json(); toast.error(j.error ?? 'Error al eliminar.'); return }
      toast.success(`OT ${ot.noOT ?? ''} eliminada.`)
      fetchOrdenes()
    } catch { toast.error('Error de conexión.') }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Órdenes de Trabajo</h3>
        {canEdit && (
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-blue-600/20 whitespace-nowrap">
            <Plus size={16} />Nueva OT
          </button>
        )}
      </div>

      {/* Barra de filtros completa (paridad con Facturas/Cotizaciones) */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-3 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[140px]">
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Nº OT</label>
          <input value={filtroNumero} onChange={e => setFiltroNumero(e.target.value)} placeholder="OT-000..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Cliente</label>
          <input value={filtroCliente} onChange={e => setFiltroCliente(e.target.value)} placeholder="Razón social..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Estado</label>
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500">
            <option value="">Todos</option>
            {ESTADOS_OT.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Tipo</label>
          <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500">
            <option value="">Todos</option>
            {TIPOS_OT.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Desde</label>
          <input type="date" value={filtroDesde} onChange={e => setFiltroDesde(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Hasta</label>
          <input type="date" value={filtroHasta} onChange={e => setFiltroHasta(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
        </div>
        <button onClick={fetchOrdenes}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 border border-slate-700 transition-colors"
          title="Refrescar">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        {hayFiltros && (
          <button onClick={limpiarFiltros}
            className="p-2 px-3 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-red-900/20 border border-slate-700 hover:border-red-700/40 transition-colors">
            Limpiar
          </button>
        )}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/70 bg-slate-800/60">
                <th className={TH}>Código</th>
                <th className={TH}>Cliente</th>
                <th className={TH}>Tipo</th>
                <th className={TH}>Técnico</th>
                <th className={TH}>Estado</th>
                <th className={TH}>Items</th>
                <th className={TH}>Total</th>
                <th className={TH}>Fecha</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr><td colSpan={9} className="text-center py-12">
                  <Loader2 size={20} className="animate-spin text-blue-500 mx-auto" />
                </td></tr>
              ) : ordenes.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-500 text-xs font-mono">
                  No hay órdenes de trabajo.
                </td></tr>
              ) : ordenes.map(ot => {
                const total = Array.isArray(ot.lineas) ? ot.lineas.reduce((s, l) => s + Number(l.precioUnitario) * (l.cantidad ?? 1), 0) : 0
                return (
                  <tr key={ot.id} onClick={() => setDetalle(ot)}
                    className="hover:bg-slate-800/50 transition-colors cursor-pointer">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-xs font-mono font-bold text-purple-400 bg-purple-600/10 border border-purple-600/20 px-2 py-0.5 rounded">
                        {ot.noOT ?? '—'}
                      </span>
                    </td>
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
                    <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5 justify-end">
                        {canBill && ['Pendiente', 'EnProceso'].includes(ot.estado) && (ot._count?.facturas ?? 0) === 0 && (
                          <button
                            onClick={() => facturarOT(ot)}
                            disabled={billing === ot.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-400 text-xs font-semibold transition-all disabled:opacity-40">
                            {billing === ot.id ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                            Facturar
                          </button>
                        )}
                        {canBill && (ot._count?.facturas ?? 0) > 0 && (
                          <span className="text-[10px] font-mono text-slate-600 px-2">Facturada</span>
                        )}
                        {canEdit && !ot.estaFacturada && (
                          <button
                            onClick={() => eliminarOT(ot)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700/40 hover:bg-red-900/20 border border-slate-600/40 hover:border-red-700/30 text-slate-500 hover:text-red-400 text-xs font-medium transition-all">
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-700/50 flex items-center justify-between gap-4">
          <p className="text-xs text-slate-600 font-mono">
            {total} orden{total !== 1 ? 'es' : ''}
          </p>
          {total > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 disabled:opacity-30 hover:bg-slate-700 transition-colors">
                Anterior
              </button>
              <span className="text-xs text-slate-500 font-mono">
                {page + 1} / {Math.ceil(total / PAGE_SIZE)}
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={(page + 1) * PAGE_SIZE >= total || loading}
                className="px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 disabled:opacity-30 hover:bg-slate-700 transition-colors">
                Siguiente
              </button>
            </div>
          )}
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
      {detalle && <OTDetalleDrawer ot={detalle} onClose={() => setDetalle(null)} />}
    </div>
  )
}

// ── OTDetalleDrawer ──────────────────────────────────────────────────────────
function OTDetalleDrawer({ ot, onClose }) {
  const totalFacturable = (ot.lineas ?? [])
    .filter(l => !l.consumoInterno)
    .reduce((s, l) => s + Number(l.precioUnitario) * (l.cantidad ?? 1), 0)
  const totalInterno = (ot.lineas ?? [])
    .filter(l => l.consumoInterno)
    .reduce((s, l) => s + (l.cantidad ?? 1), 0)
  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-[60] w-full sm:w-[28rem] lg:w-[36rem] bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col">
        <header className="px-5 py-4 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-sm font-bold text-slate-100">Orden de Trabajo</h2>
            <p className="text-[10px] font-mono text-purple-400 mt-0.5">{ot.noOT ?? '—'}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-100 transition-colors"><X size={18} /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <section className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Cliente</p>
              <p className="text-sm text-slate-200">{ot.cliente?.razonSocial ?? '—'}</p>
              <p className="text-[10px] text-slate-500 font-mono">{ot.cliente?.noCliente}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Técnico</p>
              <p className="text-sm text-slate-200">{ot.tecnico?.nombre ?? <span className="text-slate-600 italic">Sin asignar</span>}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Tipo</p>
              <OtTipoBadge tipo={ot.tipoOT} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Estado</p>
              <OtEstadoBadge estado={ot.estado} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Creada</p>
              <p className="text-sm text-slate-300 font-mono">{formatDate(ot.createdAt)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">SLA</p>
              <p className="text-sm text-slate-300 font-mono">{ot.fechaVencimientoSLA ? formatDate(ot.fechaVencimientoSLA) : '—'}</p>
            </div>
          </section>
          {ot.notasTecnicas && (
            <section>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Notas técnicas</p>
              <p className="text-xs text-slate-300 whitespace-pre-wrap bg-slate-900/50 border border-slate-800 rounded-lg p-2.5">{ot.notasTecnicas}</p>
            </section>
          )}
          <section>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Líneas ({ot.lineas?.length ?? 0})</p>
            <div className="border border-slate-800 rounded-lg overflow-hidden divide-y divide-slate-800">
              {(ot.lineas ?? []).map((l, i) => {
                let titulo = l.descripcion ?? ''
                if (typeof titulo === 'string' && titulo.startsWith('{')) {
                  try { const o = JSON.parse(titulo); if (o?.v === 1) titulo = o.titulo ?? '' } catch {}
                }
                return (
                  <div key={i} className="px-3 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-200 truncate">{titulo}</p>
                      <p className="text-[10px] text-slate-600 font-mono">{l.cantidad} × RD$ {Number(l.precioUnitario).toLocaleString('es-DO', { minimumFractionDigits: 2 })}</p>
                    </div>
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                      l.consumoInterno
                        ? 'bg-amber-600/15 text-amber-300 border-amber-600/30'
                        : 'bg-emerald-600/15 text-emerald-300 border-emerald-600/30'
                    }`}>
                      {l.consumoInterno ? '🔧 Interno' : '💰 Fact'}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
          <section className="grid grid-cols-2 gap-3 bg-slate-900/50 border border-slate-800 rounded-lg p-3">
            <div>
              <p className="text-[10px] text-slate-500">Total facturable</p>
              <p className="text-lg font-bold text-emerald-400 font-mono">RD$ {totalFacturable.toLocaleString('es-DO', { minimumFractionDigits: 2 })}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500">Items internos (BOM)</p>
              <p className="text-lg font-bold text-amber-400 font-mono">{totalInterno}</p>
            </div>
          </section>
        </div>
      </aside>
    </>
  )
}
