/**
 * frontend/src/features/sales/panels/CotizadorManualPro.jsx
 *
 * Cotizador Manual Libre para proyectos de infraestructura/CCTV. Texto
 * editable plano, sin sincronización con stock físico. Genera PDF servido
 * por POST /api/ventas/cotizador-libre/pdf y persiste borradores via
 * PUT /api/ventas/cotizador-libre/draft (auto-save debounced a 3s).
 *
 * Ciclo 13:
 *   - Único `useReducer` centraliza cliente / items / numeroDocumento /
 *     switches de ITBIS y descuentos. `cond` (hook DRY) se folda en un
 *     `useMemo` consolidado que es la dependencia ÚNICA del auto-save.
 *   - Cada ítem soporta `lugarInstalacion` y `fotos[]` (data URI base64).
 *     Las fotos se comprimen client-side a 1280px de lado + JPEG quality
 *     0.7 antes de codificar — cap 5 fotos por ítem.
 *   - Modo supervisor (`isGlobal`): selector superior para abrir, listar y
 *     sobreescribir borradores de otros empleados (co-edición en vivo de
 *     la cotización Escuela Benito Juárez con Cristian).
 *
 * Estilo Cyber-Industrial: bg-slate-900, text-slate-100, blue-600 acentos.
 * Iconos: lucide-react. Responsive: w-full / max-w-7xl centrado.
 */

import { useEffect, useMemo, useReducer, useRef, useState, useCallback } from 'react'
import {
  Plus, Trash2, FileDown, Loader2, Building2, ShieldCheck, FileText, Save,
  Boxes, Camera, X as XIcon, Users, MapPin, ChevronDown, ChevronUp, ImageOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@shared/utils/api'
import EditorCondiciones  from '@features/sales/panels/_shared/EditorCondiciones'
import useCondicionesDoc  from '@features/sales/panels/_shared/useCondicionesDoc'

const INPUT = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors'
const LABEL = 'block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5'

// ─── Compresión client-side de fotos ─────────────────────────────────────────
// Target: largo máx 1280px, JPEG quality 0.7. Output: data URI base64.
// Implementado con canvas + toBlob → FileReader.readAsDataURL. Soporta HEIC
// solo si el browser ya lo decodifica (iOS Safari sí; Chrome desktop NO —
// en ese caso falla con toast). Para evitar UI bloqueada en celulares lentos,
// la compresión corre fuera del thread principal vía createImageBitmap.
const MAX_FOTO_LADO    = 1280
const FOTO_QUALITY     = 0.7
const MAX_FOTOS_X_ITEM = 5
const MAX_FOTO_BYTES   = 320 * 1024  // alineado con backend MAX_FOTO_BYTES

async function comprimirImagen(file) {
  if (!file || !file.type?.startsWith('image/')) {
    throw new Error('No es una imagen')
  }
  // createImageBitmap soporta orientation EXIF en navegadores modernos.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale  = Math.min(1, MAX_FOTO_LADO / Math.max(bitmap.width, bitmap.height))
  const w      = Math.max(1, Math.round(bitmap.width  * scale))
  const h      = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()

  // Encode to JPEG. Si el resultado pasa el cap, reintentar con quality
  // menor (escalado lineal entre 0.5 y 0.7).
  let quality = FOTO_QUALITY
  let blob    = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  while (blob && blob.size > MAX_FOTO_BYTES && quality > 0.45) {
    quality -= 0.1
    blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  }
  if (!blob) throw new Error('Falló la codificación de la imagen')
  if (blob.size > MAX_FOTO_BYTES) {
    throw new Error(`Imagen demasiado grande tras compresión (${Math.round(blob.size / 1024)}KB > ${Math.round(MAX_FOTO_BYTES / 1024)}KB)`)
  }
  const dataUri = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
  return { dataUri, nombre: file.name, size: blob.size, w, h }
}

// ─── Estado inicial / defaults ───────────────────────────────────────────────
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

function nuevaLinea(over = {}) {
  return {
    id:                crypto.randomUUID(),
    codigo:            '',
    descripcion:       '',
    cantidad:          1,
    precioUnit:        0,
    aplicaItbis:       true,
    lugarInstalacion:  '',
    fotos:             [],
    ...over,
  }
}

const ITEMS_INICIAL = [nuevaLinea()]

// Plantilla CCTV híbrida — 36 cámaras Escuela Benito Juárez.
const PLANTILLA_CCTV_36 = [
  { codigo: 'CCTV-DAH-HFW1839T',     descripcion: 'Cámara IP Dahua 4K 8MP IPC-HFW1839T1-LED tipo bullet ColorVu 2.8mm',                cantidad: 36, precioUnit: 0, aplicaItbis: true },
  { codigo: 'CCTV-DAH-NVR5232',      descripcion: 'NVR Dahua 32 Canales NVR5232-EI 4K H.265+ con AI (rostros + cruce de línea)',         cantidad: 2,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'STORAGE-WD-8TB-PURPLE', descripcion: 'Disco duro Western Digital Purple 8TB Surveillance WD84PURZ',                          cantidad: 4,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'NET-UBQ-USW-24-POE',    descripcion: 'Switch UniFi USW-24-POE 24-puerto gigabit con 16 PoE+ (250W total)',                   cantidad: 2,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'NET-UBQ-USW-LITE-8',    descripcion: 'Switch UniFi USW-Lite-8-POE 8-puerto gigabit con 4 PoE+ (52W)',                        cantidad: 2,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'FO-DROP-2H-1000M',      descripcion: 'Bobina Fibra Óptica Drop 2 Hilos SM G657A1 1000m (interplanta entre edificios)',     cantidad: 2,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'NET-CAB-UTP6-305M',     descripcion: 'Bobina Cable UTP Cat6 305m exterior (gel-filled) para tendido entre cámaras y rack', cantidad: 6,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'NET-RJ45-CAT6-PACK100', descripcion: 'Conectores RJ45 Cat6 blindados pack×100 con bota anti-tirón',                          cantidad: 2,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'NET-RACK-12U',          descripcion: 'Rack mural 12U 600mm con organizador y bandeja para NVR + switches',                  cantidad: 2,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'POWER-UPS-3KVA',        descripcion: 'UPS APC SmartConnect 3000VA online con respaldo 2h al rack principal',               cantidad: 1,  precioUnit: 0, aplicaItbis: true },
  { codigo: 'SVC-INSTALACION',       descripcion: 'Servicio técnico: instalación, configuración remota DMSS, programación AI y entrega final con planos as-built', cantidad: 1, precioUnit: 0, aplicaItbis: true },
  { codigo: 'SVC-CAPACITACION',      descripcion: 'Capacitación 2 horas presencial al personal designado (uso de NVR, exportación de video, alertas móvil)',       cantidad: 1, precioUnit: 0, aplicaItbis: true },
]

const CONDICIONES_DEFAULT = {
  validez:  { incluir: true,  texto: 'Esta cotización es válida por 15 días calendarios.' },
  pago:     { incluir: true,  texto: '50% anticipo + 50% contra entrega.' },
  entrega:  { incluir: true,  texto: 'Entrega e instalación en 5-7 días laborables tras confirmación.' },
  garantia: { incluir: true,  texto: '12 meses contra defectos de fábrica para equipos. Mano de obra: 90 días.' },
  notas:    { incluir: false, texto: '' },
}

const LS_KEY_ULTIMO_DOC = 'acr.cotizadorLibre.ultimoDoc'

function fmtRD(n) {
  return Number(n ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Reducer: estado consolidado del editor ──────────────────────────────────
// Una sola fuente de verdad para los campos que el auto-save persiste. `cond`
// vive en su hook (DRY con otros paneles) y se folda en el payload via useMemo.
const initialState = {
  cliente:           CLIENTE_DEFAULT,
  numeroDocumento:   '',
  items:             ITEMS_INICIAL,
  aplicaItbisGlobal: true,
  porcentajeItbis:   18,
  descuentoPct:      0,
  descuentoMonto:    0,
  // `editingEmpleadoId` ≠ null indica que el caller (Owner/Socio) está
  // co-editando el borrador de otro empleado. El auto-save manda
  // `targetEmpleadoId` para que el backend escriba en el row correcto.
  editingEmpleadoId: null,
}

function reducer(state, action) {
  switch (action.type) {
    case 'INIT_FROM_DRAFT': {
      const d = action.draft ?? {}
      return {
        ...state,
        cliente:           { ...CLIENTE_DEFAULT, ...(d.cliente ?? {}) },
        items:             Array.isArray(d.items) && d.items.length > 0
                              ? d.items.map((it) => nuevaLinea(it))
                              : ITEMS_INICIAL,
        aplicaItbisGlobal: typeof d.meta?.aplicaItbisGlobal === 'boolean' ? d.meta.aplicaItbisGlobal : state.aplicaItbisGlobal,
        porcentajeItbis:   typeof d.meta?.porcentajeItbis   === 'number'  ? d.meta.porcentajeItbis   : state.porcentajeItbis,
        descuentoPct:      typeof d.meta?.descuentoGlobalPct   === 'number' ? d.meta.descuentoGlobalPct   : state.descuentoPct,
        descuentoMonto:    typeof d.meta?.descuentoGlobalMonto === 'number' ? d.meta.descuentoGlobalMonto : state.descuentoMonto,
        numeroDocumento:   d.numeroDocumento ?? state.numeroDocumento,
        editingEmpleadoId: action.editingEmpleadoId ?? null,
      }
    }
    case 'SET_NUMERO_DOC':
      return { ...state, numeroDocumento: action.value }
    case 'SET_CLIENTE':
      return { ...state, cliente: { ...state.cliente, ...action.patch } }
    case 'ADD_ITEM':
      return { ...state, items: [...state.items, nuevaLinea()] }
    case 'DEL_ITEM':
      // Garantiza siempre al menos 1 ítem en la lista.
      return state.items.length <= 1
        ? state
        : { ...state, items: state.items.filter((l) => l.id !== action.id) }
    case 'UPD_ITEM':
      return {
        ...state,
        items: state.items.map((l) => l.id === action.id ? { ...l, ...action.patch } : l),
      }
    case 'ADD_FOTO': {
      return {
        ...state,
        items: state.items.map((l) => {
          if (l.id !== action.id) return l
          const next = [...(l.fotos ?? [])]
          if (next.length >= MAX_FOTOS_X_ITEM) return l
          next.push(action.foto)
          return { ...l, fotos: next }
        }),
      }
    }
    case 'DEL_FOTO': {
      return {
        ...state,
        items: state.items.map((l) => l.id === action.id
          ? { ...l, fotos: (l.fotos ?? []).filter((_, i) => i !== action.index) }
          : l,
        ),
      }
    }
    case 'LOAD_PLANTILLA_CCTV':
      return { ...state, items: PLANTILLA_CCTV_36.map((p) => nuevaLinea(p)) }
    case 'SET_APLICA_ITBIS_GLOBAL':
      return { ...state, aplicaItbisGlobal: !!action.value }
    case 'SET_PCT_ITBIS':
      return { ...state, porcentajeItbis: action.value }
    case 'SET_DSC_PCT':
      return { ...state, descuentoPct: action.value }
    case 'SET_DSC_MONTO':
      return { ...state, descuentoMonto: action.value }
    case 'SET_EDITING_EMPLEADO':
      return { ...state, editingEmpleadoId: action.id ?? null }
    case 'RESET_TO_NEW': {
      // Crear cotización en blanco para el caller actual.
      const nuevoNum = `COT-${Date.now().toString().slice(-6)}`
      return { ...initialState, numeroDocumento: nuevoNum, editingEmpleadoId: null }
    }
    default:
      return state
  }
}

// ─── Badge de estado de auto-save ────────────────────────────────────────────
function SaveStatusBadge({ status, lastSavedAt }) {
  const rel = lastSavedAt ? Math.max(0, Math.floor((Date.now() - lastSavedAt.getTime()) / 1000)) : null
  const relTxt = rel == null ? '' : rel < 60 ? `hace ${rel}s` : rel < 3600 ? `hace ${Math.floor(rel / 60)}m` : `hace ${Math.floor(rel / 3600)}h`
  if (status === 'saving') {
    return <span className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-300 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30"><Loader2 size={11} className="animate-spin" /> Guardando…</span>
  }
  if (status === 'error') {
    return <span className="text-[10px] font-semibold text-red-300 px-2 py-1 rounded bg-red-500/10 border border-red-500/30">Error al guardar</span>
  }
  if (status === 'saved' || lastSavedAt) {
    return <span className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-300 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/30"><Save size={11} /> Guardado {relTxt}</span>
  }
  return <span className="text-[10px] font-semibold text-slate-500 px-2 py-1 rounded bg-slate-800 border border-slate-700">Sin cambios</span>
}

// ─── Componente principal ───────────────────────────────────────────────────
export default function CotizadorManualPro() {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => ({
    ...init,
    numeroDocumento: (() => {
      try {
        const prev = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY_ULTIMO_DOC) : null
        if (prev && prev.trim()) return prev
      } catch {}
      return `COT-${Date.now().toString().slice(-6)}`
    })(),
  }))

  // Hook DRY de condiciones — sigue siendo su propio state, lo foldeamos en
  // el payload memoizado para que el auto-save tenga UNA dependencia única.
  const {
    cond, reset: resetCond,
    values: condValues, mostrar: condMostrar,
    onChange: condOnChange, onMostrar: condOnMostrar,
  } = useCondicionesDoc(CONDICIONES_DEFAULT)

  // ─── Whoami: detecta scope global (Owner/Socio) y lista filas-resumen ───
  const [whoami, setWhoami] = useState({ requesterId: null, isGlobal: false })
  const [borradoresGlobales, setBorradoresGlobales] = useState([])     // solo si isGlobal
  const [cargandoBorradores, setCargandoBorradores] = useState(false)

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const r = await apiFetch('/api/ventas/cotizador-libre/whoami')
        if (cancel) return
        if (r.ok) {
          const w = await r.json()
          setWhoami(w)
        }
      } catch { /* whoami no es crítico — defaults se mantienen */ }
    })()
    return () => { cancel = true }
  }, [])

  // ─── Carga inicial: hidrata desde un draft existente ────────────────────
  const isReadyRef  = useRef(false)
  const debounceRef = useRef(null)
  const [saveStatus,  setSaveStatus]  = useState('idle')
  const [lastSavedAt, setLastSavedAt] = useState(null)

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const r = await apiFetch(`/api/ventas/cotizador-libre/draft/${encodeURIComponent(state.numeroDocumento)}`)
        if (cancel) return
        if (r.ok) {
          const draft = await r.json()
          dispatch({ type: 'INIT_FROM_DRAFT', draft, editingEmpleadoId: null })
          if (draft?.condiciones) resetCond(draft.condiciones)
          setLastSavedAt(new Date(draft.updatedAt))
        }
      } catch { /* sin draft o sin red → defaults */ }
      finally {
        if (!cancel) setTimeout(() => { isReadyRef.current = true }, 0)
      }
    })()
    return () => { cancel = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // intencionalmente solo al montar

  // Persiste el numeroDocumento en LS para hidratar tras recarga.
  useEffect(() => {
    try {
      if (state.numeroDocumento) localStorage.setItem(LS_KEY_ULTIMO_DOC, state.numeroDocumento)
    } catch {}
  }, [state.numeroDocumento])

  // ─── Cálculo totales (espejo del backend _calcularTotales) ──────────────
  const totales = useMemo(() => {
    const pct = Number(state.porcentajeItbis) / 100
    const lineas = state.items.map((it) => {
      const qty = Math.max(0, Math.floor(Number(it.cantidad ?? 0)))
      const pu  = Math.max(0, Number(it.precioUnit ?? 0))
      const sub = Math.round(qty * pu * 100) / 100
      const itl = state.aplicaItbisGlobal && it.aplicaItbis ? Math.round(sub * pct * 100) / 100 : 0
      return { ...it, qty, pu, subtotal: sub, itbisLinea: itl }
    })
    const subtotal      = lineas.reduce((s, l) => s + l.subtotal, 0)
    const dscPct        = Math.max(0, Math.min(100, Number(state.descuentoPct ?? 0))) / 100
    const dscFijo       = Math.max(0, Number(state.descuentoMonto ?? 0))
    const descuentoCalc = Math.round((subtotal * dscPct + dscFijo) * 100) / 100
    const descuento     = Math.min(descuentoCalc, subtotal)
    const baseImponible = Math.max(0, subtotal - descuento)
    const itbis         = state.aplicaItbisGlobal ? Math.round(baseImponible * pct * 100) / 100 : 0
    const total         = Math.round((baseImponible + itbis) * 100) / 100
    return { lineas, subtotal, descuento, baseImponible, itbis, total }
  }, [state.items, state.aplicaItbisGlobal, state.porcentajeItbis, state.descuentoPct, state.descuentoMonto])

  // ─── Payload consolidado para auto-save (única dependencia del effect) ──
  const persistPayload = useMemo(() => ({
    numeroDocumento: state.numeroDocumento,
    cliente: state.cliente,
    items: state.items.map((l) => ({
      codigo:           l.codigo?.trim() || null,
      descripcion:      l.descripcion ?? '',
      cantidad:         Number(l.cantidad ?? 0),
      precioUnit:       Number(l.precioUnit ?? 0),
      aplicaItbis:      !!l.aplicaItbis,
      lugarInstalacion: (l.lugarInstalacion ?? '').toString().slice(0, 300),
      fotos:            Array.isArray(l.fotos) ? l.fotos.slice(0, MAX_FOTOS_X_ITEM) : [],
    })),
    condiciones: cond,
    meta: {
      aplicaItbisGlobal:    state.aplicaItbisGlobal,
      porcentajeItbis:      Number(state.porcentajeItbis),
      descuentoGlobalPct:   Number(state.descuentoPct),
      descuentoGlobalMonto: Number(state.descuentoMonto),
    },
    // Solo se honra server-side si el caller es global; lo enviamos siempre
    // que estemos en modo co-edición (UI solo lo permite si isGlobal=true).
    targetEmpleadoId: state.editingEmpleadoId,
  }), [state, cond])

  // ─── Auto-save debounced 3s (única dependencia: persistPayload) ─────────
  useEffect(() => {
    if (!isReadyRef.current) return
    if (!persistPayload.numeroDocumento?.trim()) return
    setSaveStatus('idle')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        setSaveStatus('saving')
        const res = await apiFetch('/api/ventas/cotizador-libre/draft', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(persistPayload),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json().catch(() => ({}))
        setSaveStatus('saved')
        setLastSavedAt(j?.updatedAt ? new Date(j.updatedAt) : new Date())
      } catch {
        setSaveStatus('error')
      }
    }, 3000)
    return () => clearTimeout(debounceRef.current)
  }, [persistPayload])

  // ─── Fetch lista cross-user (solo si isGlobal) ──────────────────────────
  const refrescarBorradoresGlobales = useCallback(async () => {
    if (!whoami.isGlobal) return
    setCargandoBorradores(true)
    try {
      const r = await apiFetch('/api/ventas/cotizador-libre/drafts?limit=50')
      if (r.ok) {
        const j = await r.json()
        setBorradoresGlobales(Array.isArray(j?.drafts) ? j.drafts : [])
      }
    } catch { /* sin red */ }
    finally { setCargandoBorradores(false) }
  }, [whoami.isGlobal])

  useEffect(() => {
    if (whoami.isGlobal) refrescarBorradoresGlobales()
  }, [whoami.isGlobal, refrescarBorradoresGlobales])

  // Cargar un borrador específico (modo supervisor → cross-user).
  const cargarBorrador = useCallback(async ({ numeroDocumento, empleadoId }) => {
    try {
      isReadyRef.current = false   // evita un PUT entre el GET y el dispatch
      const url = empleadoId
        ? `/api/ventas/cotizador-libre/draft/${encodeURIComponent(numeroDocumento)}?empleadoId=${empleadoId}`
        : `/api/ventas/cotizador-libre/draft/${encodeURIComponent(numeroDocumento)}`
      const r = await apiFetch(url)
      if (!r.ok) {
        toast.error('No se pudo cargar el borrador.')
        return
      }
      const draft = await r.json()
      const cross = empleadoId && empleadoId !== whoami.requesterId
      dispatch({
        type: 'INIT_FROM_DRAFT',
        draft,
        editingEmpleadoId: cross ? empleadoId : null,
      })
      if (draft?.condiciones) resetCond(draft.condiciones)
      setLastSavedAt(new Date(draft.updatedAt))
      toast.success(cross
        ? `Cargado borrador de ${draft.empleado?.nombre ?? `empleado #${empleadoId}`} — ${draft.numeroDocumento}`
        : `Cargado borrador ${draft.numeroDocumento}`,
      )
    } catch {
      toast.error('Error al cargar el borrador.')
    } finally {
      setTimeout(() => { isReadyRef.current = true }, 50)
    }
  }, [whoami.requesterId, resetCond])

  // ─── Carga de fotos por ítem (compresión + dispatch ADD_FOTO) ───────────
  const handleAttachPhotos = useCallback(async (itemId, fileList) => {
    if (!fileList || fileList.length === 0) return
    const currentLinea = state.items.find((l) => l.id === itemId)
    const slotsLibres  = Math.max(0, MAX_FOTOS_X_ITEM - (currentLinea?.fotos?.length ?? 0))
    if (slotsLibres === 0) {
      toast.error(`Cap ${MAX_FOTOS_X_ITEM} fotos por ítem.`)
      return
    }
    const files = Array.from(fileList).slice(0, slotsLibres)
    let okCount = 0
    for (const f of files) {
      try {
        const foto = await comprimirImagen(f)
        dispatch({ type: 'ADD_FOTO', id: itemId, foto })
        okCount++
      } catch (e) {
        toast.error(`Foto ${f.name}: ${e.message}`)
      }
    }
    if (okCount > 0) toast.success(`${okCount} foto${okCount === 1 ? '' : 's'} adjunta${okCount === 1 ? '' : 's'} y comprimida${okCount === 1 ? '' : 's'}.`)
  }, [state.items])

  // ─── Plantilla CCTV ─────────────────────────────────────────────────────
  const cargarPlantillaCctv = () => {
    if (state.items.length > 1 || (state.items[0]?.descripcion?.trim())) {
      const ok = window.confirm('¿Reemplazar las líneas actuales con la plantilla CCTV 36 cámaras? El cliente y condiciones se mantienen.')
      if (!ok) return
    }
    dispatch({ type: 'LOAD_PLANTILLA_CCTV' })
    toast.success(`Plantilla CCTV cargada · ${PLANTILLA_CCTV_36.length} líneas`)
  }

  // ─── Generar PDF ────────────────────────────────────────────────────────
  const [generando, setGenerando] = useState(false)
  async function generarPdf() {
    if (!state.cliente.razonSocial?.trim()) { toast.error('Falta el nombre del cliente.'); return }
    if (state.items.some((l) => !l.descripcion?.trim())) { toast.error('Todas las líneas requieren descripción.'); return }
    setGenerando(true)
    try {
      const payload = {
        numeroDocumento: state.numeroDocumento,
        titulo: 'COTIZACIÓN',
        cliente: state.cliente,
        aplicaItbisGlobal: state.aplicaItbisGlobal,
        porcentajeItbis:  Number(state.porcentajeItbis),
        descuentoGlobalPct:   Number(state.descuentoPct),
        descuentoGlobalMonto: Number(state.descuentoMonto),
        condiciones: cond,
        items: state.items.map((l) => ({
          codigo:           l.codigo?.trim() || null,
          descripcion:      l.descripcion.trim(),
          cantidad:         Number(l.cantidad ?? 0),
          precioUnit:       Number(l.precioUnit ?? 0),
          aplicaItbis:      !!l.aplicaItbis,
          lugarInstalacion: (l.lugarInstalacion ?? '').toString().slice(0, 300),
          fotos:            Array.isArray(l.fotos) ? l.fotos.slice(0, MAX_FOTOS_X_ITEM) : [],
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
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast.success('PDF generado.')
    } catch (e) {
      toast.error(`Error generando PDF: ${e.message}`)
    } finally { setGenerando(false) }
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  const totalFotos = state.items.reduce((n, l) => n + (l.fotos?.length ?? 0), 0)
  const esCrossUser = !!(state.editingEmpleadoId && state.editingEmpleadoId !== whoami.requesterId)

  return (
    <div className="min-h-screen bg-slate-950 py-6 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">

        {/* ─── Header ────────────────────────────────────────────────────── */}
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
              <FileText size={24} className="text-blue-500" />
              Cotizador Manual Pro
              {totalFotos > 0 && (
                <span className="ml-2 text-[10px] font-semibold text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded px-2 py-0.5 uppercase tracking-wider">
                  {totalFotos} foto{totalFotos === 1 ? '' : 's'}
                </span>
              )}
            </h1>
            <p className="text-xs text-slate-500 mt-1 tracking-wide">
              Editor libre · Sin stock rígido · PDF on-demand · Auto-guardado · Anexo fotográfico
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={cargarPlantillaCctv}
              title="Inyectar listado: 36 cámaras + 2 NVRs + discos + switches + bobinas + servicio técnico"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-600/30 text-emerald-300 text-xs font-bold transition-colors">
              <Boxes size={13} />
              Plantilla Base CCTV (36 cám.)
            </button>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">N° doc:</label>
              <input
                value={state.numeroDocumento}
                onChange={(e) => dispatch({ type: 'SET_NUMERO_DOC', value: e.target.value })}
                className={INPUT + ' w-44'}
                placeholder="COT-XXXXXX"
              />
            </div>
            <SaveStatusBadge status={saveStatus} lastSavedAt={lastSavedAt} />
          </div>
        </header>

        {/* ─── Selector cross-user (solo isGlobal) ─────────────────────── */}
        {whoami.isGlobal && (
          <section className="bg-slate-900 border border-amber-600/30 rounded-xl p-4 shadow-lg">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-amber-300">
                <Users size={16} />
                <span className="text-xs font-bold uppercase tracking-wider">Modo supervisor — cross-user</span>
                {esCrossUser && (
                  <span className="ml-2 text-[10px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-0.5">
                    Editando borrador del empleado #{state.editingEmpleadoId}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refrescarBorradoresGlobales}
                  disabled={cargandoBorradores}
                  className="text-[10px] font-bold text-amber-300 hover:text-amber-200 uppercase tracking-wider px-2 py-1 rounded border border-amber-500/30 disabled:opacity-50">
                  {cargandoBorradores ? 'Cargando…' : 'Refrescar'}
                </button>
                <button
                  onClick={() => dispatch({ type: 'RESET_TO_NEW' })}
                  className="text-[10px] font-bold text-slate-400 hover:text-slate-200 uppercase tracking-wider px-2 py-1 rounded border border-slate-700">
                  Nueva cotización (mía)
                </button>
              </div>
            </div>
            <div className="mt-3">
              <label className={LABEL}>Cargar / interceptar borrador del técnico</label>
              <select
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  const [empId, num] = v.split('::')
                  cargarBorrador({ empleadoId: Number(empId), numeroDocumento: num })
                  e.target.value = ''  // reset visual
                }}
                className={INPUT}
                defaultValue=""
              >
                <option value="" disabled>— Seleccionar borrador —</option>
                {borradoresGlobales.length === 0 && (
                  <option disabled>Sin borradores activos</option>
                )}
                {borradoresGlobales.map((d) => {
                  const cli   = (d.cliente && typeof d.cliente === 'object' && d.cliente.razonSocial) || 'Sin cliente'
                  const fecha = d.updatedAt ? new Date(d.updatedAt).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : ''
                  const emp   = d.empleado?.nombre ?? `Empl. #${d.empleadoId}`
                  return (
                    <option key={d.id} value={`${d.empleadoId}::${d.numeroDocumento}`}>
                      {emp} · {d.numeroDocumento} · {cli} · {fecha}
                    </option>
                  )
                })}
              </select>
              <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                Cualquier edición que hagas aquí <strong>sobreescribe el borrador del técnico original</strong> en tiempo real (auto-save a 3s). Útil para co-diseñar la propuesta — sin último-escritor-pierde garantizado.
              </p>
            </div>
          </section>
        )}

        {/* ─── Cliente ─────────────────────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider mb-4">
            <Building2 size={16} className="text-blue-500" />
            Cliente
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <label className={LABEL}>Razón social *</label>
              <input
                value={state.cliente.razonSocial}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { razonSocial: e.target.value } })}
                className={INPUT}
                placeholder="Escuela Benito Juárez"
              />
            </div>
            <div>
              <label className={LABEL}>RNC / Cédula</label>
              <input
                value={state.cliente.rnc ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { rnc: e.target.value } })}
                className={INPUT}
                placeholder="Opcional"
              />
            </div>
            <div>
              <label className={LABEL}>Persona de contacto</label>
              <input
                value={state.cliente.contacto ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { contacto: e.target.value } })}
                className={INPUT}
                placeholder="Nombre del contacto"
              />
            </div>
            <div>
              <label className={LABEL}>Teléfono (opcional)</label>
              <input
                value={state.cliente.telefono ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { telefono: e.target.value } })}
                className={INPUT}
                placeholder="809-000-0000"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className={LABEL}>Dirección de la instalación</label>
              <input
                value={state.cliente.direccion ?? ''}
                onChange={(e) => dispatch({ type: 'SET_CLIENTE', patch: { direccion: e.target.value } })}
                className={INPUT}
                placeholder="C/ Ejemplo #123, Sector, Provincia"
              />
            </div>
          </div>
        </section>

        {/* ─── Tabla de ítems ─────────────────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-100 uppercase tracking-wider">
              Ítems del proyecto
              <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal">
                · {state.items.length} línea{state.items.length !== 1 ? 's' : ''}
              </span>
            </h2>
            <button
              onClick={() => dispatch({ type: 'ADD_ITEM' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors">
              <Plus size={13} /> Añadir Fila
            </button>
          </div>
          <div className="space-y-3">
            {totales.lineas.map((l, idx) => (
              <ItemRow
                key={l.id}
                idx={idx}
                linea={l}
                aplicaItbisGlobal={state.aplicaItbisGlobal}
                onUpdate={(patch) => dispatch({ type: 'UPD_ITEM', id: l.id, patch })}
                onDelete={() => dispatch({ type: 'DEL_ITEM', id: l.id })}
                onAttachPhotos={(fl) => handleAttachPhotos(l.id, fl)}
                onDeletePhoto={(i) => dispatch({ type: 'DEL_FOTO', id: l.id, index: i })}
                disabled={state.items.length === 1}
              />
            ))}
          </div>
        </section>

        {/* ─── Impuestos / descuentos / totales ─────────────────────────── */}
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
                  checked={state.aplicaItbisGlobal}
                  onChange={(e) => dispatch({ type: 'SET_APLICA_ITBIS_GLOBAL', value: e.target.checked })}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30"
                />
              </label>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={LABEL}>% ITBIS</label>
                  <input
                    type="number" min="0" max="40" step="0.01"
                    value={state.porcentajeItbis}
                    onChange={(e) => dispatch({ type: 'SET_PCT_ITBIS', value: e.target.value })}
                    disabled={!state.aplicaItbisGlobal}
                    className={INPUT + ' text-right disabled:opacity-50'}
                  />
                </div>
                <div>
                  <label className={LABEL}>Descuento %</label>
                  <input
                    type="number" min="0" max="100" step="0.01"
                    value={state.descuentoPct}
                    onChange={(e) => dispatch({ type: 'SET_DSC_PCT', value: e.target.value })}
                    className={INPUT + ' text-right'}
                  />
                </div>
                <div>
                  <label className={LABEL}>Descuento RD$</label>
                  <input
                    type="number" min="0" step="0.01"
                    value={state.descuentoMonto}
                    onChange={(e) => dispatch({ type: 'SET_DSC_MONTO', value: e.target.value })}
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
              {state.aplicaItbisGlobal && (
                <div className="flex justify-between text-slate-300 border-t border-slate-800 pt-2">
                  <span>ITBIS {Number(state.porcentajeItbis).toFixed(0)}%</span>
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

        {/* ─── Editor de condiciones ──────────────────────────────────── */}
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
          <div className="flex justify-end mt-3">
            <button
              onClick={() => resetCond(CONDICIONES_DEFAULT)}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-wider">
              Restaurar defaults
            </button>
          </div>
        </section>

        {/* ─── Botón generar PDF ─────────────────────────────────────── */}
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

// ─── Sub-componente ItemRow: línea con expand para lugar + fotos ───────────
// Diseñado para que la fila base se vea compacta en mobile pero permita expandir
// la zona de "detalles técnicos" (lugar de instalación + fotos comprimidas).
function ItemRow({
  idx, linea, aplicaItbisGlobal,
  onUpdate, onDelete, onAttachPhotos, onDeletePhoto,
  disabled,
}) {
  const [expanded, setExpanded] = useState(() => (linea.fotos?.length > 0) || !!linea.lugarInstalacion)
  const fileInputRef = useRef(null)

  const onPickFiles = () => fileInputRef.current?.click()
  const onFileChange = (e) => {
    onAttachPhotos(e.target.files)
    e.target.value = ''  // permitir re-seleccionar mismo archivo
  }
  const onDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer?.files?.length) onAttachPhotos(e.dataTransfer.files)
  }

  const fotosCount = linea.fotos?.length ?? 0
  const tieneLugar = !!(linea.lugarInstalacion ?? '').trim()

  return (
    <div className="bg-slate-800/30 border border-slate-800 rounded-lg overflow-hidden">
      {/* Fila base — grid responsive */}
      <div className="grid grid-cols-12 gap-2 items-center p-3">
        <div className="col-span-1 text-slate-500 text-xs font-bold">{idx + 1}</div>
        <div className="col-span-3 sm:col-span-2">
          <input
            value={linea.codigo}
            onChange={(e) => onUpdate({ codigo: e.target.value })}
            placeholder="Código"
            className={INPUT + ' py-1.5 text-xs'}
          />
        </div>
        <div className="col-span-8 sm:col-span-4">
          <input
            value={linea.descripcion}
            onChange={(e) => onUpdate({ descripcion: e.target.value })}
            placeholder="Descripción del ítem"
            className={INPUT + ' py-1.5 text-xs'}
          />
        </div>
        <div className="col-span-3 sm:col-span-1">
          <input
            type="number" min="0" step="1"
            value={linea.cantidad}
            onChange={(e) => onUpdate({ cantidad: e.target.value })}
            className={INPUT + ' py-1.5 text-xs text-center'}
          />
        </div>
        <div className="col-span-4 sm:col-span-2">
          <input
            type="number" min="0" step="0.01"
            value={linea.precioUnit}
            onChange={(e) => onUpdate({ precioUnit: e.target.value })}
            className={INPUT + ' py-1.5 text-xs text-right'}
          />
        </div>
        <div className="col-span-3 sm:col-span-1 text-right text-slate-200 text-xs font-medium tabular-nums">
          {fmtRD(linea.subtotal)}
        </div>
        <div className="col-span-2 sm:col-span-1 flex items-center justify-end gap-1">
          <label
            className="cursor-pointer text-slate-400 hover:text-blue-400 transition-colors"
            title={aplicaItbisGlobal ? 'Aplicar ITBIS a esta línea' : 'ITBIS global desactivado'}>
            <input
              type="checkbox"
              checked={!!linea.aplicaItbis}
              onChange={(e) => onUpdate({ aplicaItbis: e.target.checked })}
              disabled={!aplicaItbisGlobal}
              className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500/30 disabled:opacity-40 mr-1"
            />
            <span className="text-[9px] uppercase tracking-wider">ITBIS</span>
          </label>
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Ocultar detalles' : 'Ver lugar de instalación y fotos'}
            className={`p-1 rounded transition-colors ${(tieneLugar || fotosCount > 0) ? 'text-amber-300 hover:text-amber-200' : 'text-slate-500 hover:text-slate-200'}`}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            onClick={onDelete}
            disabled={disabled}
            title="Eliminar línea"
            className="text-slate-500 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Resumen visible siempre (cuando hay datos extras) */}
      {!expanded && (tieneLugar || fotosCount > 0) && (
        <div className="px-3 pb-2 flex items-center gap-3 text-[10px] text-slate-500">
          {tieneLugar && (<span className="flex items-center gap-1"><MapPin size={10} /> {linea.lugarInstalacion}</span>)}
          {fotosCount > 0 && (<span className="flex items-center gap-1"><Camera size={10} /> {fotosCount} foto{fotosCount === 1 ? '' : 's'}</span>)}
        </div>
      )}

      {/* Detalles expandidos */}
      {expanded && (
        <div className="border-t border-slate-800 bg-slate-900/50 p-3 space-y-3"
             onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
             onDrop={onDrop}>
          <div>
            <label className={LABEL + ' flex items-center gap-1'}>
              <MapPin size={10} /> Lugar de instalación
            </label>
            <input
              value={linea.lugarInstalacion ?? ''}
              onChange={(e) => onUpdate({ lugarInstalacion: e.target.value })}
              placeholder="Ej: Pasillo Norte, segundo nivel — sobre puerta entrada principal"
              className={INPUT + ' py-1.5 text-xs'}
              maxLength={300}
            />
          </div>
          <div>
            <label className={LABEL + ' flex items-center justify-between gap-2'}>
              <span className="flex items-center gap-1"><Camera size={10} /> Fotos del levantamiento</span>
              <span className="normal-case text-slate-500 tracking-normal text-[10px] font-normal">
                {fotosCount} / {MAX_FOTOS_X_ITEM} · Comprimidas a 1280px · JPEG 70%
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              {linea.fotos?.map((f, i) => (
                <div key={i} className="relative group">
                  <img
                    src={f.dataUri}
                    alt={f.nombre ?? `Foto ${i + 1}`}
                    className="w-20 h-20 object-cover rounded border border-slate-700"
                  />
                  <button
                    onClick={() => onDeletePhoto(i)}
                    title="Eliminar foto"
                    className="absolute -top-1 -right-1 bg-red-600 hover:bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <XIcon size={11} />
                  </button>
                </div>
              ))}
              {fotosCount < MAX_FOTOS_X_ITEM && (
                <button
                  onClick={onPickFiles}
                  className="w-20 h-20 rounded border-2 border-dashed border-slate-700 hover:border-blue-500 hover:bg-blue-500/5 text-slate-500 hover:text-blue-400 flex flex-col items-center justify-center gap-1 transition-colors">
                  <Camera size={16} />
                  <span className="text-[9px] font-bold uppercase tracking-wider">Adjuntar</span>
                </button>
              )}
              {fotosCount === 0 && (
                <div className="flex items-center gap-1 text-[10px] text-slate-500 italic">
                  <ImageOff size={11} /> Sin fotos · Tap "Adjuntar" o arrastra al área
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              className="hidden"
              onChange={onFileChange}
            />
          </div>
        </div>
      )}
    </div>
  )
}
