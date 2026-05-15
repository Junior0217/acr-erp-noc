import { useState, useEffect, useRef } from 'react'
import { X, Trash2, Plus, Minus, ShoppingCart, FileText, CreditCard, Loader2, Search, UserCheck, Receipt, Tag, Lock, KeyRound } from 'lucide-react'
import { useCart } from '../contexts/CartContext'
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

function LineaRow({ linea, onUpdate, onRemove, descuentosUnlocked }) {
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
          <label className="block text-[10px] text-slate-500 mb-1">Precio Unit.</label>
          <input type="number" min="0" step="0.01" value={precio} onChange={e => setPrecioU(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1 flex items-center gap-1">Desc. % {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}</label>
          <input type="number" min="0" max="100" step="0.01" value={dctPct}
            onChange={e => setDPct(e.target.value)}
            disabled={!descuentosUnlocked}
            title={!descuentosUnlocked ? 'Bloqueado — requiere PIN de supervisor' : ''}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1 flex items-center gap-1">Desc. RD$ {!descuentosUnlocked && <Lock size={9} className="text-amber-400" />}</label>
          <input type="number" min="0" step="0.01" value={dctMon}
            onChange={e => setDMon(e.target.value)}
            disabled={!descuentosUnlocked}
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

export default function CarritoSlideOver() {
  const { carrito, open, setOpen, loading, updateItem, removeItem, clearCart, updateCartMeta, checkout } = useCart()
  const [nombreWalkIn, setNombreWalkIn] = useState('')
  const [descTipo, setDescTipo]         = useState('pct')
  const [descValor, setDescValor]       = useState(0)
  // Bloqueo de descuentos: por defecto LOCK. Solo se libera tras autorizar
  // con PIN del supervisor. Aplica también al owner — sin excepciones.
  // Un PIN válido libera tanto el descuento global como el descuento por
  // línea, y vuelve a bloquearse al cerrar el slide-over (vía useEffect).
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
  // pendingCondToggle: { campo: 'validez'|'pago'|...|'notas', nextValue: bool }
  // Se vacía al abrir/cancelar el modal. Al confirmar el PIN, aplicamos el
  // toggle al estado real (incluirCond/incluirNotas).
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
    }
  }, [open])

  // Solicita PIN para cambiar un switch de condiciones/notas. Si el usuario
  // cancela o el PIN falla, el switch debe permanecer en su valor anterior
  // (lo logramos no aplicando el cambio hasta confirmar).
  function requestToggleCondicion(campo, nextValue) {
    setPendingCondToggle({ campo, nextValue })
    setCondPinModalOpen(true)
  }
  function aplicarToggleConfirmado() {
    if (!pendingCondToggle) return
    const { campo, nextValue } = pendingCondToggle
    if (campo === 'notas') setIncluirNotas(nextValue)
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
    // Validación dura: cliente o contacto walk-in son OBLIGATORIOS para
    // emitir un documento. Antes ambos podían ser null y la factura quedaba
    // huérfana — ahora se exige al menos uno.
    const nombre = !cliente && nombreWalkIn.trim() ? nombreWalkIn.trim() : undefined
    if (!cliente && !nombre) {
      toast.error('Vincula un cliente o ingresa un nombre de contacto antes de continuar.')
      return
    }
    // tipoNcf eliminado del UI: se infiere automáticamente del cliente
    // seleccionado en el backend (cliente.tipoNCF / tipo fiscal default).
    const descuento = descValor > 0
      ? (descTipo === 'pct' ? { descuentoGlobalPct: descValor } : { descuentoGlobalMonto: descValor })
      : {}
    // condicionesOverride: solo enviamos campos donde el usuario tocó el
    // switch (incluir=false). Los que siguen true los omitimos para que
    // el backend caiga al default de empresa via mergeCondiciones.
    const condicionesOverride = {}
    for (const k of ['validez','pago','entrega','garantia']) {
      if (incluirCond[k] === false) condicionesOverride[k] = { incluir: false, texto: null }
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
    const f = await checkout(esCotizacion, undefined, nombre, extra)
    if (f) {
      setNombreWalkIn('')
      setDescValor(0)
      setDescTipo('pct')
      setOpen(false)
    }
  }

  async function handleClienteSelect(c) {
    await updateCartMeta({ clienteId: c?.id ?? null })
    if (c) setNombreWalkIn('')
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
            <label className="block text-xs text-slate-500 mb-1.5 font-medium">Cliente</label>
            <ClienteSearch clienteActual={cliente} onSelect={handleClienteSelect} />
            {cliente && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <UserCheck size={12} className="text-emerald-400" />
                <span className="text-xs text-emerald-400">{cliente.razonSocial}</span>
                <span className="text-xs text-slate-600">· {cliente.noCliente}</span>
              </div>
            )}
            {!cliente && (
              <input
                className="mt-2 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="Nombre walk-in (opcional)..."
                value={nombreWalkIn}
                onChange={e => setNombreWalkIn(e.target.value)}
                maxLength={100}
              />
            )}
          </div>

          {/* Tipo de Comprobante eliminado: el backend deriva el NCF
              automáticamente desde el cliente seleccionado (cliente.tipoNCF
              o el default fiscal del walk-in). Cero selector manual. */}

          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-400 font-medium">Aplicar ITBIS (18%)</label>
            <button
              onClick={() => updateCartMeta({ applyItbis: !carrito?.applyItbis })}
              className={`w-10 h-5 rounded-full transition-colors relative ${carrito?.applyItbis ? 'bg-blue-600' : 'bg-slate-700'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${carrito?.applyItbis ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {/* Condiciones del documento — switches togglables, cada cambio
              pide PIN supervisor. Si el PIN falla o se cancela, el switch
              NO cambia. Estado por defecto: todas ON (heredan empresa). */}
          <div className="pt-1 border-t border-slate-800 mt-1">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 flex items-center gap-1.5">
              <Lock size={9} className="text-amber-400" />
              Términos en PDF (cambios requieren PIN)
            </div>
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-3">
              {[
                { k: 'validez',  label: 'Validez' },
                { k: 'pago',     label: 'Forma de Pago' },
                { k: 'entrega',  label: 'Entrega' },
                { k: 'garantia', label: 'Garantía' },
              ].map(({ k, label }) => (
                <label key={k} className="flex items-center justify-between text-[11px] text-slate-300 cursor-pointer">
                  <span>{label}</span>
                  <button
                    type="button"
                    onClick={() => requestToggleCondicion(k, !incluirCond[k])}
                    className={`w-7 h-4 rounded-full transition-colors relative ${incluirCond[k] ? 'bg-blue-600' : 'bg-slate-700'}`}
                    aria-label={`Toggle ${label}`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${incluirCond[k] ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </button>
                </label>
              ))}
              {/* Notas — switch independiente abajo, span 2 columnas */}
              <label className="col-span-2 flex items-center justify-between text-[11px] text-slate-300 cursor-pointer pt-1 mt-1 border-t border-slate-800/50">
                <span>Agregar Notas al PDF</span>
                <button
                  type="button"
                  onClick={() => requestToggleCondicion('notas', !incluirNotas)}
                  className={`w-7 h-4 rounded-full transition-colors relative ${incluirNotas ? 'bg-blue-600' : 'bg-slate-700'}`}
                  aria-label="Toggle Notas"
                >
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${incluirNotas ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </label>
              {incluirNotas && (
                <textarea
                  value={notasTexto}
                  onChange={e => setNotasTexto(e.target.value)}
                  maxLength={2000}
                  rows={2}
                  placeholder="Notas internas / aclaraciones para el cliente..."
                  className="col-span-2 mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors resize-none"
                />
              )}
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

        {/* PIN gate de los switches de condiciones/notas — separado del PIN
            de descuentos para que la UI muestre el contexto correcto. */}
        <PinAuthModal
          open={condPinModalOpen}
          onClose={cancelarToggle}
          titulo="Modificar Términos del PDF"
          descripcion="Los términos comerciales (Validez · Pago · Entrega · Garantía · Notas) son fijos por defecto. Modificar cualquiera requiere PIN supervisor."
          onUnlock={(pin) => { setPinSupervisor(pin); aplicarToggleConfirmado(); toast.success('Cambio aplicado al documento.') }}
        />

        <div className="flex-1 overflow-y-auto">
          {lineas.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-600">
              <ShoppingCart size={32} />
              <p className="text-sm">Carrito vacío</p>
              <p className="text-xs text-center px-8">Agrega productos desde el catálogo de Inventario.</p>
            </div>
          )}
          {lineas.map(l => (
            <LineaRow key={l.id} linea={l} onUpdate={updateItem} onRemove={removeItem} descuentosUnlocked={descuentosUnlocked} />
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
            {!cliente && nombreWalkIn.trim() && (
              <div className="px-4 pb-1 flex items-center gap-1.5">
                <UserCheck size={11} className="text-sky-400" />
                <span className="text-xs text-sky-400">{nombreWalkIn.trim()}</span>
              </div>
            )}

            <div className="px-4 py-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => handleCheckout(true)}
                disabled={loading}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                Cotización
              </button>
              <button
                onClick={() => handleCheckout(false)}
                disabled={loading}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
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
