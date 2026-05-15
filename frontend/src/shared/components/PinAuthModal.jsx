/**
 * Modal de autorización supervisor — usado por POS y Carrito para desbloquear
 * descuentos (global y por línea), modificar/ocultar condiciones comerciales
 * y otras acciones sensibles. El PIN vive en EmpresaPerfil.pinSupervisor y
 * se valida vía /api/pos/verificar-pin (rate-limited 10 intentos / 5 min).
 *
 * Aplica a TODOS los usuarios — incluyendo sistema:owner — por diseño:
 * el dueño no es excepción de los controles operativos. Cualquier cambio
 * en descuentos/condiciones queda auditable vía AuditLog del backend.
 */
import { useState } from 'react'
import { Loader2, KeyRound } from 'lucide-react'
import { apiFetch } from '../utils/api'

export default function PinAuthModal({
  open,
  onClose,
  onUnlock,
  titulo = 'Autorización Requerida',
  descripcion = 'Esta acción requiere el PIN de supervisor configurado en Mi Empresa. La validación aplica a todos los usuarios, incluido el dueño.',
}) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!open) return null
  async function verificar() {
    if (!pin.trim()) return
    setBusy(true); setErr('')
    try {
      const r = await apiFetch('/api/pos/verificar-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.trim() }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.valid) { setErr(j.error || 'PIN inválido.'); setPin(''); return }
      onUnlock(pin.trim())
      setPin('')
      onClose()
    } catch { setErr('Error de red.') }
    finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-amber-700/40 rounded-xl w-full max-w-sm mx-4 overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <KeyRound size={18} className="text-amber-400" />
          <h2 className="text-base font-bold text-slate-100">{titulo}</h2>
        </div>
        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">{descripcion}</p>
          <input
            type="password" inputMode="numeric" maxLength={12}
            value={pin}
            onChange={e => { setPin(e.target.value); setErr('') }}
            onKeyDown={e => e.key === 'Enter' && verificar()}
            placeholder="PIN supervisor"
            autoFocus
            className="w-full text-center text-lg font-mono tracking-[0.4em] bg-slate-800 border border-slate-700 focus:border-amber-500 focus:outline-none rounded-lg px-3 py-3 text-slate-100"
          />
          {err && <p className="text-xs text-red-400 text-center">{err}</p>}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors">Cancelar</button>
            <button onClick={verificar} disabled={busy || !pin.trim()} className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              Autorizar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
