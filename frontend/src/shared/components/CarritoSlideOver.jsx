import { useState, useEffect, useRef } from 'react'
import { X, Trash2, Plus, Minus, ShoppingCart, FileText, CreditCard, Loader2, Search, UserCheck, Receipt, Tag, Lock, KeyRound, Info, AlertCircle } from 'lucide-react'
import { useCart } from '../contexts/CartContext'
import { useEmpresa } from '../contexts/EmpresaContext'
// useAuth removido: Zero Trust no necesita conocer el rol; el candado aplica
// universalmente. La autorización se delega al PIN supervisor.
import { apiFetch } from '../utils/api'
import { useDebounce } from '../hooks/useDebounce'
import { toast } from 'sonner'
import PinAuthModal from './PinAuthModal'

const fmt = n => Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })

function ClienteSearch({ clienteActual, onSelect }) {
  const [query, setQuery]   = useState(clienteActual?.razonSocial ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen]     = useState(false)
  const dq = useDebounce(query, 350)
  const ref = useRef(null)

  useEffect(() => {
    if (!open || dq.length < 2) { setResults([]); return }
    apiFetch(`/api/clientes?search=${encodeURIComponent(dq)}&limit=6`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => setResults(j.data ?? []))
      .catch(() => {})
  }, [dq, open])

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    setQuery(clienteActual?.razonSocial ?? '')
  }, [clienteActual])

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
          placeholder="Buscar cliente (opcional)..."
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
        />
        {clienteActual && (
          <button
            onClick={() => { setQuery(''); onSelect(null); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-red-400 transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-50 top-full mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
          {results.map(c => (
            <li key={c.id}>
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
                onClick={() => { onSelect(c); setQuery(c.razonSocial); setOpen(false); }}
              >
                <div className="text-slate-100 font-medium leading-tight">{c.razonSocial}</div>
                <div className="text-xs text-slate-500 font-mono">{c.noCliente}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LineaRow({ linea, onUpdate, onRemove, descuentosUnlocked, onRequestUnlock }) {
  const [cant, setCant] = useState(linea.cantidad)
  const [precio, setPrecio] = useState(linea.precioUnitario)
  const [dctPct, setDctPct] = useState(linea.descuentoPorcentaje)
  const [dctMon, setDctMon] = useState(linea.descuentoMonto)
  const timer = useRef(null)

  function flush(patch) {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onUpdate(linea.id, patch), 500)
  }

  function setCantidad(v) {
    const n = Math.max(1, parseInt(v) || 1)
    setCant(n)
    flush({ cantidad: n })
  }
  function setPrecioU(v) {
    const n = Math.max(0, parseFloat(v) || 0)
    setPrecio(n)
    flush({ precioUnitario: n })
  }
  function setDPct(v) {
    const n = Math.min(100, Math.max(0, parseFloat(v) || 0))
    setDctPct(n)
    flush({ descuentoPorcentaje: n })
  }
  function setDMon(v) {
    const n = Math.max(0, parseFloat(v) || 0)
    setDctMon(n)
    flush({ descuentoMonto: n })
  }

  const esSrv = linea.producto?.tipoItem === 'SERVICIO'
  const eu = Math.max(0, Math.round((precio * (1 - dctPct / 100) - dctMon) * 100) / 100)
  const total = Math.round(eu * cant * 100) / 100

  return (
    <div className="p-3 border-b border-slate-800 last:border-0">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-200 leading-tight truncate">{linea.producto?.nombre ?? '—'}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] font-mono text-slate-500">{linea.producto?.sku}</span>
            {esSrv && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/30 text-purple-400 border border-purple-700/30">Servicio</span>
            )}
            {!esSrv && linea.producto?.stockActual <= 5 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 border border-red-700/30">Stock bajo</span>
            )}
          </div>
        </div>
        <button onClick={() => onRemove(linea.id)} className="text-slate-600 hover:text-red-400 transition-colors flex-shrink-0">
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Cantidad</label>
          <div className="flex items-center gap-1">
            <button onClick={() => setCantidad(cant - 1)} className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"><Minus size={11} /></button>
            <input type="number" min="1" value={cant} onChange={e => setCantidad(e.target.value)}
              className="w-12 text-center bg-slate-800 border border-slate-700 rounded px-1 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500" />
            <button onClick={() => setCantidad(cant + 1)} className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"><Plus size={11} /></button>
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1 flex items-center gap-1">Precio Unit. {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}</label>
          <input type="number" min="0" step="0.01" value={precio} onChange={e => setPrecioU(e.target.value)}
            disabled={!descuentosUnlocked}
            onClick={() => { if (!descuentosUnlocked && onRequestUnlock) onRequestUnlock() }}
            title={!descuentosUnlocked ? 'Override precio · requiere PIN de supervisor' : ''}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1 flex items-center gap-1">Desc. % {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}</label>
          <input type="number" min="0" max="100" step="0.01" value={dctPct}
            onChange={e => setDPct(e.target.value)}
            disabled={!descuentosUnlocked}
            onClick={() => { if (!descuentosUnlocked && onRequestUnlock) onRequestUnlock() }}
            title={!descuentosUnlocked ? 'Bloqueado — requiere PIN de supervisor' : ''}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1 flex items-center gap-1">Desc. RD$ {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}</label>
          <input type="number" min="0" step="0.01" value={dctMon}
            onChange={e => setDMon(e.target.value)}
            disabled={!descuentosUnlocked}
            onClick={() => { if (!descuentosUnlocked && onRequestUnlock) onRequestUnlock() }}
            title={!descuentosUnlocked ? 'Bloqueado — requiere PIN de supervisor' : ''}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
      </div>

      <div className="flex justify-end mt-2">
        <span className="text-sm font-semibold text-blue-300">RD$ {fmt(total)}</span>
      </div>
    </div>
  )
}

// Texto por defecto que se imprimirá si el switch correspondiente queda en ON.
// Lee de empresa.condicionesDefault (configurado en MiEmpresa) y cae al
// fallback hardcoded del contexto si aún no llegó la respuesta del backend.
function _previewCondicion(empresa, key) {
  const t = empresa?.condicionesDefault?.[key]
  if (typeof t === 'string' && t.trim()) return t.trim()
  return '— sin texto configurado, se omitirá del PDF —'
}

const CONDICIONES_META = [
  { k: 'validez',  label: 'Validez',        hint: 'Período durante el que la cotización conserva precios.' },
  { k: 'pago',     label: 'Forma de Pago',  hint: 'Esquema de anticipo / saldo / crédito que verá el cliente.' },
  { k: 'entrega',  label: 'Entrega',        hint: 'Tiempo de despacho/instalación comprometido.' },
  { k: 'garantia', label: 'Garantía',       hint: 'Cobertura post-venta sobre equipos y mano de obra.' },
]

export default function CarritoSlideOver() {
  const {
    carrito, open, setOpen, loading, updateItem, removeItem, clearCart, updateCartMeta, checkout,
    // posCart: carrito local del POS (localStorage). Mostramos aquí solo para
    // visibilidad — el cajero debe ir a /ventas → POS para emitir desde él.
    // Antes el badge contaba estos items pero el drawer estaba vacío → bug UX.
    posCart, posItemsCount,
  } = useCart()
  const { empresa } = useEmpresa()
  const [descTipo, setDescTipo]         = useState('pct')
  const [descValor, setDescValor]       = useState(0)
  // Bloqueo de descuentos: por defecto LOCK. Solo se libera tras autorizar
  // con PIN del supervisor. Aplica también al owner — sin excepciones.
  // Un PIN válido libera tanto el descuento global como el descuento por
  // línea, y vuelve a bloquearse al cerrar el slide-over (vía useEffect).
  // Zero Trust (política PO 2026-05-18): el candado aplica a TODOS los
  // roles. Owner también digita PIN para mutar precios / descuentos /
  // condiciones. Eliminado `|| isOwner`. Auditoría inmutable + anti
  // session-hijacking: el PIN supervisor vive en EmpresaPerfil y es
  // independiente de las credenciales de login.
  const [descuentosUnlocked, setDescuentosUnlocked] = useState(false)
  const [pinSupervisor, setPinSupervisor] = useState('')   // viaja al backend
  const [pinModalOpen, setPinModalOpen] = useState(false)

  // Condiciones (Validez / Pago / Entrega / Garantía) y Notas: cada uno
  // tiene un switch "incluir". Por defecto las condiciones se incluyen
  // (heredan default de empresa); las notas NO se incluyen por defecto.
  // CRÍTICO: cambiar cualquier switch dispara PinAuthModal. Solo se aplica
  // el toggle si el PIN es correcto, sino se revierte al estado anterior.
  const [incluirCond, setIncluirCond] = useState({ validez: true, pago: true, entrega: true, garantia: true })
  const [incluirNotas, setIncluirNotas] = useState(false)
  const [notasTexto,   setNotasTexto]   = useState('')
  // Paridad #5 con POS: textareas de override por condición. Si quedan vacíos,
  // el backend hace fallback al default de MiEmpresa via mergeCondiciones. Si
  // el cajero escribe override (tras PIN), se persiste en condicionesOverride.
  // El bloqueo aplica idéntico al POS — solo editable cuando descuentosUnlocked.
  const [overrideValidez,  setOverrideValidez]  = useState('')
  const [overridePago,     setOverridePago]     = useState('')
  const [overrideEntrega,  setOverrideEntrega]  = useState('')
  const [overrideGarantia, setOverrideGarantia] = useState('')
  // pendingCondToggle: { campo: 'validez'|'pago'|...|'notas'|'itbis', nextValue: bool }
  // Se vacía al abrir/cancelar el modal. Al confirmar el PIN, aplicamos el
  // toggle al estado real (incluirCond/incluirNotas/applyItbis vía updateCartMeta).
  const [pendingCondToggle, setPendingCondToggle] = useState(null)
  const [condPinModalOpen, setCondPinModalOpen] = useState(false)

  // Re-bloqueo automático: cada vez que el slide-over se cierra, perdemos
  // toda autorización (descuentos + condiciones). El siguiente "open" exige PIN.
  useEffect(() => {
    if (!open) {
      setDescuentosUnlocked(false)
      setPinSupervisor('')
      setDescValor(0)
      setIncluirCond({ validez: true, pago: true, entrega: true, garantia: true })
      setIncluirNotas(false)
      setNotasTexto('')
      setOverrideValidez('')
      setOverridePago('')
      setOverrideEntrega('')
      setOverrideGarantia('')
    }
  }, [open])

  // Solicita PIN para cambiar un switch de condiciones/notas. Si el usuario
  // cancela o el PIN falla, el switch debe permanecer en su valor anterior
  // (lo logramos no aplicando el cambio hasta confirmar).
  //
  // Zero Trust (política PO 2026-05-18): owner también pasa por aquí. Sin
  // excepciones — la única diferencia entre owner y otro rol es quién
  // conoce el PIN (configurado por owner en MiEmpresa).
  function requestToggleCondicion(campo, nextValue) {
    setPendingCondToggle({ campo, nextValue })
    setCondPinModalOpen(true)
  }
  function aplicarToggleConfirmado() {
    if (!pendingCondToggle) return
    const { campo, nextValue } = pendingCondToggle
    if (campo === 'notas') setIncluirNotas(nextValue)
    else if (campo === 'itbis') updateCartMeta({ applyItbis: nextValue })
    else setIncluirCond(prev => ({ ...prev, [campo]: nextValue }))
    setPendingCondToggle(null)
  }
  function cancelarToggle() {
    setPendingCondToggle(null)
    setCondPinModalOpen(false)
  }

  if (!open) return null

  const lineas   = carrito?.lineas ?? []
  const totales  = carrito?.totales ?? { subtotal: 0, itbis: 0, total: 0 }
  const cliente  = carrito?.cliente ?? null

  const subtotalBruto = totales.subtotal
  const descuentoAmt = descValor > 0
    ? (descTipo === 'pct'
        ? Math.round(subtotalBruto * (descValor / 100) * 100) / 100
        : Math.min(descValor, subtotalBruto))
    : 0
  const subtotalNeto = Math.max(0, Math.round((subtotalBruto - descuentoAmt) * 100) / 100)
  const itbisDisplay  = carrito?.applyItbis ? Math.round(subtotalNeto * 0.18 * 100) / 100 : 0
  const totalDisplay  = Math.round((subtotalNeto + itbisDisplay) * 100) / 100

  async function handleCheckout(esCotizacion) {
    if (!lineas.length) { toast.warning('El carrito está vacío.'); return }
    // Rigor Enterprise: clienteId obligatorio. Sin walk-in. El cajero debe
    // seleccionar un cliente real (o crearlo en CRM) antes de emitir.
    if (!cliente) {
      toast.error('Selecciona un cliente de la base de datos antes de emitir.')
      return
    }
    // tipoNcf eliminado del UI: se infiere automáticamente del cliente
    // seleccionado en el backend (cliente.tipoNCF / tipo fiscal default).
    const descuento = descValor > 0
      ? (descTipo === 'pct' ? { descuentoGlobalPct: descValor } : { descuentoGlobalMonto: descValor })
      : {}
    // condicionesOverride: 3 ramas por condición.
    //   1) Switch OFF → { incluir: false, texto: null } (oculta del PDF).
    //   2) Switch ON + texto override no vacío → { incluir: true, texto } (override del default empresa).
    //   3) Switch ON sin texto → se omite la clave (backend cae al default empresa).
    const condicionesOverride = {}
    const overridesMap = {
      validez:  overrideValidez,
      pago:     overridePago,
      entrega:  overrideEntrega,
      garantia: overrideGarantia,
    }
    for (const k of ['validez','pago','entrega','garantia']) {
      if (incluirCond[k] === false) {
        condicionesOverride[k] = { incluir: false, texto: null }
      } else if (overridesMap[k]?.trim()) {
        condicionesOverride[k] = { incluir: true, texto: overridesMap[k].trim().slice(0, 500) }
      }
    }
    // notasOverride: si el switch está OFF (default), enviamos string vacío
    // para que el backend persista null y el PDF oculte la sección. Si está
    // ON con texto, enviamos el texto. Si está ON sin texto, también vacío.
    const notasOverride = incluirNotas && notasTexto.trim() ? notasTexto.trim() : ''
    const extra = {
      ...descuento,
      ...(pinSupervisor ? { pinSupervisor } : {}),
      ...(Object.keys(condicionesOverride).length ? { condicionesOverride } : {}),
      notasOverride,
    }
    const f = await checkout(esCotizacion, undefined, extra)
    if (f) {
      setDescValor(0)
      setDescTipo('pct')
      setOpen(false)
    }
  }

  async function handleClienteSelect(c) {
    await updateCartMeta({ clienteId: c?.id ?? null })
  }

  return (
    <>
      {/* Backdrop sutil — no oscurece toda la pantalla. Click fuera cierra. */}
      <div className="fixed inset-0 z-[55] bg-black/30 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      {/* Slide-over más ancho: 24rem en sm → 32rem en lg → 40rem en xl
          para que la información completa de líneas (qty, precio, descuento,
          totales, cliente, NCF, condiciones) quepa sin scroll lateral. */}
      <div className="fixed inset-y-0 right-0 z-[60] w-full sm:w-[26rem] lg:w-[32rem] xl:w-[36rem] bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <ShoppingCart size={16} className="text-blue-400" />
            <span className="font-semibold text-slate-100">Carrito POS</span>
            {lineas.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-400 border border-blue-600/30">{lineas.length} items</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {lineas.length > 0 && (
              <button onClick={clearCart} className="text-xs text-slate-600 hover:text-red-400 transition-colors">Vaciar</button>
            )}
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-100 transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-4 py-3 border-b border-slate-800 flex-shrink-0 space-y-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5 font-medium flex items-center gap-1">
              Cliente <span className="text-red-400">*</span>
            </label>
            <ClienteSearch clienteActual={cliente} onSelect={handleClienteSelect} />
            {cliente && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <UserCheck size={12} className="text-emerald-400" />
                <span className="text-xs text-emerald-400">{cliente.razonSocial}</span>
                <span className="text-xs text-slate-600">· {cliente.noCliente}</span>
              </div>
            )}
            {!cliente && (
              <div className="mt-2 flex items-start gap-2 px-2.5 py-2 rounded-lg bg-red-900/20 border border-red-700/40 text-[11px] text-red-300">
                <AlertCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
                <span>
                  Selecciona un cliente registrado. No se permiten documentos sin vínculo a CRM
                  (sin clientes "walk-in" ni nombres manuales).
                </span>
              </div>
            )}
          </div>

          {/* Tipo de Comprobante eliminado: el backend deriva el NCF
              automáticamente desde el cliente seleccionado (cliente.tipoNcf). */}

          {/* ITBIS: por rigor fiscal, cualquier cambio exige PIN supervisor.
              El cajero NUNCA decide si la factura aplica ITBIS solo. El PIN
              valida y luego updateCartMeta persiste applyItbis vía PATCH al
              carrito. Si el PIN falla / se cancela, el toggle no cambia. */}
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400 font-medium truncate">
              Aplicar ITBIS (18%) <Lock size={9} className="text-amber-400 flex-shrink-0" />
            </label>
            <button
              type="button"
              onClick={() => requestToggleCondicion('itbis', !carrito?.applyItbis)}
              aria-pressed={!!carrito?.applyItbis}
              title="Bloqueado · requiere PIN de supervisor para cambiar (control fiscal)"
              className={`relative inline-flex h-5 w-10 flex-shrink-0 rounded-full transition-colors ${carrito?.applyItbis ? 'bg-blue-600' : 'bg-slate-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${carrito?.applyItbis ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          {/* Condiciones del documento — switches togglables, cada cambio
              pide PIN supervisor. Si el PIN falla o se cancela, el switch
              NO cambia. Estado por defecto: todas ON (heredan empresa).
              Cada item muestra debajo el texto real que se imprimirá si
              queda ON (preview del default configurado en MiEmpresa). */}
          <div className="pt-1 border-t border-slate-800 mt-1">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <Lock size={9} className="text-amber-400" />
                Términos en PDF (cambios requieren PIN)
              </span>
              <span className="text-[9px] normal-case tracking-normal text-slate-600 flex items-center gap-1">
                <Info size={9} /> Default desde MiEmpresa
              </span>
            </div>
            <div className="space-y-1.5">
              {CONDICIONES_META.map(({ k, label, hint }) => {
                // Obligatorio: configurado por owner en MiEmpresa. Si está ON,
                // el toggle queda forzado ON y bloqueado — ni PIN supervisor
                // puede ocultar la fila (el backend también lo enforcea).
                const obligatorio = !!empresa?.condicionesDefault?._obligatorio?.[k]
                const on   = obligatorio ? true : incluirCond[k]
                const def  = _previewCondicion(empresa, k)
                const hasDefault = !def.startsWith('— sin texto')
                return (
                  <div
                    key={k}
                    className={`w-full overflow-hidden rounded-lg border px-2.5 py-1.5 transition-colors ${on ? 'border-blue-600/30 bg-blue-600/5' : 'border-slate-800 bg-slate-900/40'}`}
                    title={obligatorio ? `${label} es obligatorio (configurado en MiEmpresa)` : hint}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-slate-200">{label}</span>
                        {obligatorio && <Lock size={9} className="flex-shrink-0 text-amber-400" />}
                        <span className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${on ? 'bg-blue-600/20 text-blue-300 border-blue-600/30' : 'bg-slate-800 text-slate-500 border-slate-700'}`}>
                          {obligatorio ? 'Forzado' : (on ? 'En PDF' : 'Oculto')}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (obligatorio) {
                            toast.error(`${label} está marcado como obligatorio en MiEmpresa — no se puede ocultar.`)
                            return
                          }
                          requestToggleCondicion(k, !on)
                        }}
                        disabled={obligatorio}
                        aria-pressed={on}
                        aria-label={`Toggle ${label}`}
                        className={`relative inline-flex h-4 w-8 flex-shrink-0 rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-slate-700'} ${obligatorio ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                    <div className={`mt-1 text-[10px] leading-snug line-clamp-2 break-words ${on ? (hasDefault ? 'text-slate-400' : 'text-amber-400/80 italic') : 'text-slate-600 line-through'}`}>
                      <span className="mr-1 font-semibold text-slate-500">Default:</span>{def}
                    </div>
                    {/* Override editable (paridad #5 con POS). Solo visible si la
                        condición está incluida + no es obligatoria. Bloqueado
                        hasta autorización por PIN supervisor — clic abre modal. */}
                    {on && !obligatorio && (() => {
                      const overrideVal = k === 'validez'  ? overrideValidez
                                        : k === 'pago'     ? overridePago
                                        : k === 'entrega'  ? overrideEntrega
                                        : overrideGarantia
                      const overrideSet = k === 'validez'  ? setOverrideValidez
                                        : k === 'pago'     ? setOverridePago
                                        : k === 'entrega'  ? setOverrideEntrega
                                        : setOverrideGarantia
                      return (
                        <input
                          type="text"
                          maxLength={500}
                          value={overrideVal}
                          onChange={e => overrideSet(e.target.value)}
                          disabled={!descuentosUnlocked}
                          onClick={() => { if (!descuentosUnlocked) setPinModalOpen(true) }}
                          placeholder={!descuentosUnlocked
                            ? 'Override · clic para autorizar (PIN supervisor)'
                            : `Sobrescribir "${label}" para este documento (vacío = default empresa)`}
                          className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                      )
                    })()}
                  </div>
                )
              })}
              {/* Notas — switch independiente con preview del textarea */}
              <div className={`w-full overflow-hidden rounded-lg border px-2.5 py-1.5 transition-colors ${incluirNotas ? 'border-blue-600/30 bg-blue-600/5' : 'border-slate-800 bg-slate-900/40'}`}>
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[11px] font-medium text-slate-200">Notas / Aclaraciones</span>
                    <span className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${incluirNotas ? 'bg-blue-600/20 text-blue-300 border-blue-600/30' : 'bg-slate-800 text-slate-500 border-slate-700'}`}>
                      {incluirNotas ? 'En PDF' : 'Oculto'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => requestToggleCondicion('notas', !incluirNotas)}
                    aria-pressed={incluirNotas}
                    aria-label="Toggle Notas"
                    className={`relative inline-flex h-4 w-8 flex-shrink-0 rounded-full transition-colors ${incluirNotas ? 'bg-blue-600' : 'bg-slate-700'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${incluirNotas ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>
                {!incluirNotas && (
                  <div className="mt-1 text-[10px] leading-snug text-slate-600 italic">
                    Por defecto el PDF no incluye notas. Activa para añadir un mensaje libre al cliente.
                  </div>
                )}
                {incluirNotas && (
                  <textarea
                    value={notasTexto}
                    onChange={e => setNotasTexto(e.target.value)}
                    maxLength={2000}
                    rows={2}
                    disabled={!descuentosUnlocked}
                    onClick={() => { if (!descuentosUnlocked) setPinModalOpen(true) }}
                    placeholder={!descuentosUnlocked ? 'Override notas · requiere PIN supervisor' : 'Notas internas / aclaraciones para el cliente (máx. 2000 caracteres)...'}
                    className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors resize-none disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Descuento global — BLOQUEADO por defecto. Click en candado abre
              el modal de PIN supervisor. Una vez desbloqueado, los inputs
              quedan editables hasta cerrar el slide-over. */}
          <div className="pt-1">
            <div className="flex items-center justify-between mb-1.5">
              <label className="flex items-center gap-1.5 text-xs text-slate-400 font-medium">
                <Tag size={11} /> Descuento Global
                {!descuentosUnlocked && <Lock size={10} className="text-amber-400" />}
              </label>
              <div className="flex items-center gap-1">
                {!descuentosUnlocked && (
                  <button
                    onClick={() => setPinModalOpen(true)}
                    className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-600/20 text-amber-400 border border-amber-600/40 hover:bg-amber-600/40 transition-colors flex items-center gap-1"
                    title="Solicitar autorización del supervisor"
                  >
                    <KeyRound size={9} /> Autorizar
                  </button>
                )}
                {descuentosUnlocked && (
                  <>
                    <button
                      onClick={() => { setDescTipo('pct'); setDescValor(0) }}
                      className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${descTipo === 'pct' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}
                    >%</button>
                    <button
                      onClick={() => { setDescTipo('monto'); setDescValor(0) }}
                      className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors ${descTipo === 'monto' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}
                    >RD$</button>
                  </>
                )}
              </div>
            </div>
            <input
              type="number"
              min="0"
              max={descTipo === 'pct' ? 100 : undefined}
              step="0.01"
              value={descValor || ''}
              onChange={e => setDescValor(Math.max(0, parseFloat(e.target.value) || 0))}
              disabled={!descuentosUnlocked}
              placeholder={descuentosUnlocked
                ? (descTipo === 'pct' ? '0.00 %' : '0.00 RD$')
                : 'Bloqueado · pide PIN para habilitar'}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
        </div>

        <PinAuthModal
          open={pinModalOpen}
          onClose={() => setPinModalOpen(false)}
          onUnlock={(pin) => { setPinSupervisor(pin); setDescuentosUnlocked(true); toast.success('Descuentos habilitados para esta sesión del carrito.') }}
        />

        {/* PIN gate de los switches de condiciones/notas + ITBIS — separado
            del PIN de descuentos para que la UI muestre el contexto correcto.
            El ITBIS también pasa por aquí (control fiscal: ningún cajero
            decide solo si una factura lleva impuesto). */}
        <PinAuthModal
          open={condPinModalOpen}
          onClose={cancelarToggle}
          titulo={pendingCondToggle?.campo === 'itbis' ? 'Modificar Aplicación de ITBIS' : 'Modificar Términos del PDF'}
          descripcion={pendingCondToggle?.campo === 'itbis'
            ? 'Aplicar ITBIS afecta directamente el monto facturado y la presentación al cliente. Requiere PIN de supervisor.'
            : 'Los términos comerciales (Validez · Pago · Entrega · Garantía · Notas) son fijos por defecto. Modificar cualquiera requiere PIN supervisor.'}
          onUnlock={(pin) => { setPinSupervisor(pin); aplicarToggleConfirmado(); toast.success('Cambio aplicado al documento.') }}
        />

        <div className="flex-1 overflow-y-auto">
          {/* Banner POS Cart — visibilidad de items del carrito POS (localStorage)
              que el cajero agregó desde el panel POS. El checkout NO ocurre acá:
              el link "Ir al POS" lleva al cajero al panel donde puede emitir.
              Antes el badge contaba estos items pero el drawer estaba vacío. */}
          {Array.isArray(posCart) && posCart.length > 0 && (
            <div className="border-b border-slate-800 bg-orange-950/20">
              <div className="px-4 py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShoppingCart size={14} className="text-orange-400" />
                  <span className="text-xs font-bold text-orange-300 uppercase tracking-wider">
                    Carrito POS · {posItemsCount} {posItemsCount === 1 ? 'ítem' : 'ítems'}
                  </span>
                </div>
                <a
                  href="/ventas?tab=pos"
                  onClick={() => setOpen(false)}
                  className="text-[10px] px-2 py-1 rounded bg-orange-600 hover:bg-orange-500 text-white font-bold"
                >
                  Ir al POS →
                </a>
              </div>
              <div className="px-4 pb-2 space-y-1">
                {posCart.map((l, i) => (
                  <div key={i} className="flex items-center justify-between text-xs gap-2 bg-slate-900/40 rounded px-2 py-1">
                    <span className="text-slate-300 truncate flex-1" title={l.nombre}>
                      {l.cantidad}× <span className="text-slate-200">{l.nombre}</span>
                    </span>
                    <span className="font-mono text-slate-400 tabular-nums">
                      RD$ {fmt((l.precioUnitario ?? 0) * l.cantidad)}
                    </span>
                  </div>
                ))}
                <p className="text-[10px] text-slate-500 italic pt-1">
                  Estos ítems solo se cobran desde el panel POS (no aquí).
                </p>
              </div>
            </div>
          )}

          {lineas.length === 0 && (!Array.isArray(posCart) || posCart.length === 0) && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-600">
              <ShoppingCart size={32} />
              <p className="text-sm">Carrito vacío</p>
              <p className="text-xs text-center px-8">Agrega productos desde el catálogo de Inventario.</p>
            </div>
          )}
          {lineas.map(l => (
            <LineaRow key={l.id} linea={l} onUpdate={updateItem} onRemove={removeItem} descuentosUnlocked={descuentosUnlocked} onRequestUnlock={() => setPinModalOpen(true)} />
          ))}
        </div>

        {lineas.length > 0 && (
          <div className="flex-shrink-0 border-t border-slate-800">
            <div className="px-4 py-3 space-y-1 bg-slate-900/60">
              <div className="flex justify-between text-sm text-slate-400">
                <span>Subtotal</span>
                <span className="tabular-nums">RD$ {fmt(subtotalBruto)}</span>
              </div>
              {descuentoAmt > 0 && (
                <div className="flex justify-between text-sm text-red-400">
                  <span>Descuento {descTipo === 'pct' ? `(${descValor}%)` : ''}</span>
                  <span className="tabular-nums">−RD$ {fmt(descuentoAmt)}</span>
                </div>
              )}
              {carrito?.applyItbis && (
                <div className="flex justify-between text-sm text-slate-400">
                  <span>ITBIS (18%)</span>
                  <span className="tabular-nums">RD$ {fmt(itbisDisplay)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-slate-100 pt-1 border-t border-slate-800">
                <span>Total</span>
                <span className="tabular-nums text-blue-300">RD$ {fmt(totalDisplay)}</span>
              </div>
            </div>

            {/* NCF indicador removido — se infiere del cliente automáticamente. */}
            {!cliente && (
              <div className="px-4 pb-1 flex items-center gap-1.5">
                <AlertCircle size={11} className="text-red-400" />
                <span className="text-[11px] text-red-400">Selecciona un cliente para habilitar emisión</span>
              </div>
            )}

            <div className="px-4 py-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => handleCheckout(true)}
                disabled={loading || !cliente}
                title={!cliente ? 'Selecciona un cliente registrado' : ''}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                Cotización
              </button>
              <button
                onClick={() => handleCheckout(false)}
                disabled={loading || !cliente}
                title={!cliente ? 'Selecciona un cliente registrado' : ''}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                Emitir Factura
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
