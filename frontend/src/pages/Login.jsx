import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Mail, Loader2, Eye, EyeOff, ShieldCheck } from 'lucide-react'
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

const PHASE_LABEL = {
  idle:       null,
  challenge:  'Generando clave efímera...',
  encrypt:    'Cifrando credenciales RSA-OAEP...',
  auth:       'Verificando identidad...',
}

export default function Login() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPwd,  setShowPwd]  = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [phase,    setPhase]    = useState('idle')
  const { login }               = useAuth()
  const navigate                = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true); setError('')
    setPhase('challenge')
    try {
      // AuthContext.login() handles full challenge + WebCrypto flow
      // phase labels are visual only; actual states are in AuthContext
      setPhase('encrypt')
      await login(email, password)
      setPhase('auth')
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
      setPhase('idle')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">

      {/* Cyber grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.025)_1px,transparent_1px)] bg-[size:48px_48px] pointer-events-none" />

      {/* Radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(6,182,212,0.06),transparent)] pointer-events-none" />

      {/* Horizontal scan line */}
      <div className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent top-[38%] pointer-events-none" />

      <div className="relative z-10 w-full max-w-[420px]">

        {/* System status badge */}
        <div className="flex justify-center mb-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-mono text-emerald-400 tracking-widest uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Sistema Operativo
          </span>
        </div>

        {/* Logo */}
        <LogoContenedor />

        {/* Glassmorphism card */}
        <div className="backdrop-blur-sm sm:backdrop-blur-xl bg-white/[0.03] border border-white/[0.07] rounded-2xl p-7 shadow-2xl shadow-blue-950/50">
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
                <button
                  type="button"
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/30 text-xs text-red-400 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                {error}
              </div>
            )}

            {loading && PHASE_LABEL[phase] && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-900/15 border border-cyan-700/20 text-xs text-cyan-400 font-mono">
                <Loader2 size={12} className="animate-spin flex-shrink-0" />
                {PHASE_LABEL[phase]}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full py-3 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white text-sm font-bold font-mono tracking-widest uppercase transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-cyan-900/30 flex items-center justify-center gap-2 mt-1"
            >
              {loading
                ? <Loader2 size={14} className="animate-spin" />
                : <ShieldCheck size={14} />
              }
              {loading ? '···' : 'Autenticar'}
            </button>
          </form>

          {/* Encryption indicator */}
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[10px] text-slate-600 font-mono">
            <Lock size={9} />
            <span>RSA-OAEP · AES-256-GCM · HttpOnly · SameSite:Strict</span>
          </div>
        </div>

        <p className="text-center text-[10px] text-slate-700 mt-5 font-mono tracking-widest uppercase">
          Acceso Restringido · Solo Personal Autorizado · {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
