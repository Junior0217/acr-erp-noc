/**
 * Modal de autorización supervisor — usado por POS y Carrito para desbloquear
 * descuentos (global y por línea), modificar/ocultar condiciones comerciales
 * y otras acciones sensibles.
 *
 * Tres canales de autorización (tabs):
 *   1) PIN — vive en EmpresaPerfil.pinSupervisor.
 *      Valida vía POST /api/pos/verificar-pin (rate-limited 10/5min).
 *   2) TOTP — token 6 dígitos del Authenticator del usuario autenticado
 *      (Empleado.twoFactorSecret descifrado por shared/jwt-crypto).
 *      Valida vía POST /api/pos/authorize-totp.
 *   3) Webhook — solicitud async al OWNER_ALERT_WEBHOOK_URL. El recipient
 *      (típicamente el dueño con su teléfono) firma con HMAC AUDIT_SECRET y
 *      hace POST /api/pos/authorize-webhook/:id/approve. El modal hace
 *      polling cada 2s del status hasta resolverse o expirar (5 min TTL).
 *
 * Aplica a TODOS los usuarios — incluyendo sistema:owner — por diseño.
 * Cualquier autorización queda auditable vía AuditLog del backend.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, KeyRound, ShieldCheck, Webhook, ScanLine } from 'lucide-react'
import { apiFetch } from '../utils/api'

const TABS = [
  { key: 'pin',     label: 'PIN',     icon: KeyRound,    desc: 'PIN del supervisor configurado en Mi Empresa.' },
  { key: 'totp',    label: 'TOTP',    icon: ShieldCheck, desc: 'Token de 6 dígitos del Authenticator del usuario actual.' },
  { key: 'webhook', label: 'Webhook', icon: Webhook,     desc: 'Solicitud remota — el dueño aprueba desde su dispositivo.' },
]

export default function PinAuthModal({
  open,
  onClose,
  onUnlock,
  titulo = 'Autorización Requerida',
  descripcion = 'Esta acción requiere autorización supervisor. La validación aplica a todos los usuarios, incluido el dueño.',
}) {
  const [tab, setTab]   = useState('pin')
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState('')

  // PIN
  const [pin, setPin] = useState('')

  // TOTP
  const [totp, setTotp] = useState('')

  // Webhook
  const [chId, setChId]         = useState(null)
  const [chStatus, setChStatus] = useState(null)   // 'pending' | 'approved' | 'rejected' | 'expired' | 'webhook_unreachable'
  const [chRemaining, setChRem] = useState(null)
  const [chMotivo, setChMotivo] = useState('')
  const pollRef = useRef(null)

  useEffect(() => {
    if (!open) { setErr(''); setBusy(false); setPin(''); setTotp(''); resetWebhook(); }
    return () => { stopPolling(); }
  }, [open])

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }
  function resetWebhook() {
    stopPolling();
    setChId(null); setChStatus(null); setChRem(null); setChMotivo('');
  }

  async function verificarPin() {
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

  async function verificarTotp() {
    if (!/^\d{6}$/.test(totp)) {
      setErr('TOTP debe ser exactamente 6 dígitos.'); return
    }
    setBusy(true); setErr('')
    try {
      const r = await apiFetch('/api/pos/authorize-totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: totp }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.valid) {
        setErr(j.mensaje || j.error || 'TOTP inválido.')
        setTotp('')
        return
      }
      onUnlock('TOTP')
      setTotp('')
      onClose()
    } catch { setErr('Error de red.') }
    finally { setBusy(false) }
  }

  async function pedirWebhook() {
    setBusy(true); setErr('')
    try {
      const r = await apiFetch('/api/pos/authorize-webhook/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo: chMotivo.trim() || undefined }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(j.mensaje || j.error || 'No se pudo enviar la solicitud al webhook.')
        return
      }
      setChId(j.challengeId)
      setChStatus(j.status || 'pending')
      setChRem(j.ttlMs ?? null)
      // Polling cada 2s del status.
      pollRef.current = setInterval(async () => {
        try {
          const r2 = await apiFetch(`/api/pos/authorize-webhook/${j.challengeId}/status`)
          const j2 = await r2.json().catch(() => ({}))
          if (!r2.ok) return
          setChStatus(j2.status)
          setChRem(j2.remainingMs ?? null)
          if (j2.status === 'approved') {
            stopPolling()
            onUnlock('WEBHOOK')
            onClose()
          } else if (j2.status === 'rejected' || j2.status === 'expired') {
            stopPolling()
            setErr(j2.status === 'expired'
              ? 'La solicitud expiró sin respuesta (5 min).'
              : 'La solicitud fue rechazada por el supervisor.')
          }
        } catch { /* silencio — siguiente tick */ }
      }, 2000)
    } catch { setErr('Error de red al iniciar el webhook.') }
    finally { setBusy(false) }
  }

  function onEnter() {
    if (busy) return
    if (tab === 'pin')  return verificarPin()
    if (tab === 'totp') return verificarTotp()
  }

  if (!open) return null

  const ctaDisabled = busy
    || (tab === 'pin'  && !pin.trim())
    || (tab === 'totp' && !/^\d{6}$/.test(totp))
    || (tab === 'webhook' && chStatus === 'pending')

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-amber-700/40 rounded-xl w-full max-w-md mx-4 overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <KeyRound size={18} className="text-amber-400" />
          <h2 className="text-base font-bold text-slate-100">{titulo}</h2>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = tab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTab(t.key); setErr(''); }}
                className={`flex-1 px-3 py-2.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                  active
                    ? 'bg-slate-900 text-amber-300 border-b-2 border-amber-500'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/50'
                }`}
              >
                <Icon size={13} />
                {t.label}
              </button>
            )
          })}
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            {descripcion} <br/>
            <span className="text-slate-500">{TABS.find((t) => t.key === tab)?.desc}</span>
          </p>

          {/* PIN */}
          {tab === 'pin' && (
            <input
              type="password" inputMode="numeric" maxLength={12}
              value={pin}
              onChange={e => { setPin(e.target.value); setErr('') }}
              onKeyDown={e => e.key === 'Enter' && onEnter()}
              placeholder="PIN supervisor"
              autoFocus
              className="w-full text-center text-lg font-mono tracking-[0.4em] bg-slate-800 border border-slate-700 focus:border-amber-500 focus:outline-none rounded-lg px-3 py-3 text-slate-100"
            />
          )}

          {/* TOTP */}
          {tab === 'totp' && (
            <div className="space-y-2">
              <input
                type="text" inputMode="numeric" maxLength={6}
                value={totp}
                onChange={e => { setTotp(e.target.value.replace(/\D/g, '').slice(0, 6)); setErr('') }}
                onKeyDown={e => e.key === 'Enter' && onEnter()}
                placeholder="000000"
                autoFocus
                className="w-full text-center text-2xl font-mono tracking-[0.6em] bg-slate-800 border border-slate-700 focus:border-amber-500 focus:outline-none rounded-lg px-3 py-3 text-slate-100"
              />
              <p className="text-[10px] text-slate-500 text-center flex items-center justify-center gap-1.5">
                <ScanLine size={11} /> Abre tu app Authenticator (Google/MS/Authy) y teclea el código de 6 dígitos.
              </p>
            </div>
          )}

          {/* Webhook */}
          {tab === 'webhook' && (
            <div className="space-y-3">
              {!chId ? (
                <>
                  <input
                    type="text" maxLength={200}
                    value={chMotivo}
                    onChange={e => setChMotivo(e.target.value)}
                    placeholder="Motivo (opcional, ej. 'Descuento 25% cliente VIP')"
                    className="w-full bg-slate-800 border border-slate-700 focus:border-amber-500 focus:outline-none rounded-lg px-3 py-2 text-sm text-slate-100"
                  />
                  <p className="text-[10px] text-slate-500">
                    Al confirmar, se enviará una solicitud firmada al webhook configurado en
                    <code className="mx-1 px-1 py-0.5 bg-slate-800 rounded text-amber-300">OWNER_ALERT_WEBHOOK_URL</code>.
                    El dueño aprueba desde su dispositivo. TTL 5 min.
                  </p>
                </>
              ) : (
                <div className="text-center space-y-2 py-2">
                  <Loader2 size={20} className="animate-spin text-amber-400 mx-auto" />
                  <p className="text-sm text-slate-300">
                    {chStatus === 'pending' && 'Esperando aprobación del supervisor...'}
                    {chStatus === 'webhook_unreachable' && 'Webhook inalcanzable — esperando aprobación manual.'}
                    {chStatus === 'rejected' && 'Solicitud rechazada.'}
                    {chStatus === 'expired' && 'Solicitud expirada.'}
                    {chStatus === 'approved' && 'Aprobada. Cerrando...'}
                  </p>
                  {typeof chRemaining === 'number' && chStatus === 'pending' && (
                    <p className="text-[10px] text-slate-500 font-mono">
                      ⏱ {Math.max(0, Math.ceil(chRemaining / 1000))}s restantes
                    </p>
                  )}
                  <p className="text-[10px] text-slate-600 font-mono break-all">
                    ID: {chId}
                  </p>
                </div>
              )}
            </div>
          )}

          {err && <p className="text-xs text-red-400 text-center">{err}</p>}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { resetWebhook(); onClose(); }}
              disabled={busy && tab !== 'webhook'}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => {
                if (tab === 'pin')  return verificarPin()
                if (tab === 'totp') return verificarTotp()
                if (tab === 'webhook' && !chId) return pedirWebhook()
              }}
              disabled={ctaDisabled}
              className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {tab === 'webhook' && chId ? 'Esperando...' : 'Autorizar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
