import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Mail, Loader2, Eye, EyeOff, ShieldCheck, KeyRound } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

function LogoContenedor() {
  return (
    <div className="text-center mb-8">
      <div className="relative inline-flex items-center justify-center mb-5">
        <div className="absolute w-32 h-32 rounded-3xl bg-cyan-500/20 blur-2xl" />
        <div className="absolute w-28 h-28 rounded-3xl bg-blue-600/15 blur-xl" />
        <div className="relative w-24 h-24 rounded-2xl bg-slate-900/80 border border-cyan-500/25 p-2 flex items-center justify-center shadow-xl shadow-cyan-900/30">
          <img
            src="/logo-acr.png"
            alt="ACR Networks Logo"
            className="w-full h-full object-contain"
            onError={e => { e.target.style.display = 'none' }}
          />
        </div>
      </div>
      <h1 className="text-xl sm:text-2xl font-black font-mono tracking-tight leading-tight">
        <span className="text-slate-100">ACR NETWORKS </span>
        <span className="text-cyan-400">&amp;</span>
        <span className="text-slate-100"> SOLUTIONS</span>
      </h1>
      <p className="text-[10px] text-slate-500 mt-1.5 font-mono tracking-[0.3em] uppercase">
        NOC · Command Center
      </p>
    </div>
  )
}

export default function Login() {
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [showPwd,    setShowPwd]    = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [totp,       setTotp]       = useState('')
  const [tempToken,  setTempToken]  = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const { login, verifyTOTP }     = useAuth()
  const navigate                  = useNavigate()

  const is2FAStep = !!tempToken

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      if (is2FAStep) {
        await verifyTOTP(tempToken, totp)
        navigate('/', { replace: true })
      } else {
        const result = await login(email, password, rememberMe)
        if (result?.requires2FA) {
          setTempToken(result.tempToken)
        } else {
          navigate('/', { replace: true })
        }
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function cancelar2FA() {
    setTempToken(null)
    setTotp('')
    setError('')
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.025)_1px,transparent_1px)] bg-[size:48px_48px] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(6,182,212,0.06),transparent)] pointer-events-none" />
      <div className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent top-[38%] pointer-events-none" />

      <div className="relative z-10 w-full max-w-[420px]">
        <div className="flex justify-center mb-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-mono text-emerald-400 tracking-widest uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Sistema Operativo
          </span>
        </div>

        <LogoContenedor />

        <div className="backdrop-blur-sm sm:backdrop-blur-xl bg-white/[0.03] border border-white/[0.07] rounded-2xl p-7 shadow-2xl shadow-blue-950/50">

          {is2FAStep ? (
            /* ── 2FA Step ── */
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="text-center pb-2">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-cyan-600/15 border border-cyan-600/30 mb-3">
                  <KeyRound size={22} className="text-cyan-400" />
                </div>
                <p className="text-sm font-semibold text-slate-200">Verificación en 2 pasos</p>
                <p className="text-xs text-slate-500 mt-1">Ingresa el código de tu app autenticadora</p>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 font-mono">
                  PIN de 6 Dígitos
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totp}
                  onChange={e => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  placeholder="000000"
                  className="w-full bg-slate-900/80 border border-slate-700/50 rounded-lg px-4 py-3 text-center text-2xl tracking-[0.5em] text-slate-100 placeholder-slate-700 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all font-mono"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading || totp.length !== 6}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-sm font-bold font-mono tracking-widest uppercase transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                {loading ? '···' : 'Verificar PIN'}
              </button>
              <button type="button" onClick={cancelar2FA}
                className="w-full text-xs text-slate-600 hover:text-slate-400 font-mono transition-colors py-1">
                ← Volver al inicio de sesión
              </button>
            </form>
          ) : (
            /* ── Password Step ── */
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 font-mono">
                  Identificador
                </label>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    placeholder="usuario@acrnetworks.do"
                    className="w-full bg-slate-900/80 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 font-mono">
                  Clave de Acceso
                </label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    placeholder="••••••••••••"
                    className="w-full bg-slate-900/80 border border-slate-700/50 rounded-lg pl-9 pr-10 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all font-mono"
                  />
                  <button type="button" onClick={() => setShowPwd(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors">
                    {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer select-none group">
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                  rememberMe ? 'bg-blue-600 border-blue-500' : 'bg-slate-800 border-slate-600 group-hover:border-slate-500'
                }`} onClick={() => setRememberMe(v => !v)}>
                  {rememberMe && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="sr-only" />
                <span className="text-xs text-slate-500 group-hover:text-slate-400 transition-colors font-mono">
                  Mantener sesión iniciada <span className="text-slate-700">(30 días)</span>
                </span>
              </label>

              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading || !email || !password}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white text-sm font-bold font-mono tracking-widest uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-cyan-900/30 flex items-center justify-center gap-2 mt-1">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                {loading ? '···' : 'Autenticar'}
              </button>
            </form>
          )}

          <div className="mt-4 flex items-center justify-center gap-1.5 text-[10px] text-slate-600 font-mono">
            <Lock size={9} />
            <span>RSA-OAEP · AES-256-GCM · CSRF · {is2FAStep ? 'TOTP-RFC6238' : 'HttpOnly'}</span>
          </div>
        </div>

        <p className="text-center text-[10px] text-slate-700 mt-5 font-mono tracking-widest uppercase">
          Acceso Restringido · Solo Personal Autorizado · {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
