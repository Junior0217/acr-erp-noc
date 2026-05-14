// build: 2026-05-11
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Zap, CheckCircle, Clock, MapPin, Phone, ChevronLeft, Loader2, Wrench, Navigation } from 'lucide-react'

const STEPS = [
  { id: 'asignado',   label: 'Orden Asignada',       desc: 'Tu técnico fue asignado a la instalación.',         icon: CheckCircle },
  { id: 'camino',     label: 'Técnico en Camino',     desc: 'El técnico está en ruta hacia tu dirección.',       icon: Navigation  },
  { id: 'sitio',      label: 'Técnico en Sitio',      desc: 'El técnico llegó y está trabajando.',               icon: Wrench      },
  { id: 'completado', label: 'Instalación Completa',  desc: '¡Listo! Tu servicio está activo.',                  icon: Zap         },
]

const MOCK_ORDEN = {
  'ORD-2026-0042': {
    cliente: 'Cliente ACR',
    direccion: 'Cristo Rey, C/ Principal #42, Santo Domingo',
    servicio: 'Internet Pro 30 Mbps',
    tecnico: { nombre: 'Técnico NOC', telefono: '809-555-0001' },
    stepIndex: 1,
    eta: '20 min',
    fechaProgramada: '2026-05-11 10:30',
  },
}

export default function PortalTracking() {
  const { ordenId }  = useParams()
  const navigate     = useNavigate()
  const [orden, setOrden] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    setTimeout(() => {
      setOrden(MOCK_ORDEN[ordenId] ?? null)
      setLoading(false)
    }, 800)
  }, [ordenId])

  // Simulate live pulsing indicator
  useEffect(() => {
    const t = setInterval(() => setPulse(v => !v), 1800)
    return () => clearInterval(t)
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <Loader2 size={20} className="animate-spin text-blue-500" />
          <span className="text-sm">Cargando estado de la orden…</span>
        </div>
      </div>
    )
  }

  if (!orden) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mx-auto">
            <Wrench size={28} className="text-slate-600" />
          </div>
          <p className="text-slate-400 text-sm">Orden <span className="font-mono text-slate-300">{ordenId}</span> no encontrada.</p>
          <button onClick={() => navigate('/portal')} className="text-blue-400 text-sm hover:text-blue-300 transition-colors underline">
            Volver al portal
          </button>
        </div>
      </div>
    )
  }

  const currentStep = orden.stepIndex

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">

      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/95 backdrop-blur border-b border-slate-800">
        <div className="max-w-xl mx-auto px-4 h-14 flex items-center justify-between">
          <button onClick={() => navigate('/portal')} className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-100 transition-colors">
            <ChevronLeft size={16} />Portal
          </button>
          <div className="flex items-center gap-2">
            <Zap size={14} className="text-blue-400" />
            <span className="text-xs font-bold text-slate-300 font-mono">{ordenId}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
            <span className={`w-2 h-2 rounded-full bg-emerald-400 transition-opacity ${pulse ? 'opacity-100' : 'opacity-40'}`} />
            En vivo
          </div>
        </div>
      </header>

      <div className="max-w-xl mx-auto px-4 py-8 space-y-6">

        {/* Titulo */}
        <div>
          <h1 className="text-xl font-black text-slate-100">Seguimiento de Instalación</h1>
          <p className="text-sm text-slate-500 mt-1">{orden.servicio}</p>
        </div>

        {/* ETA card */}
        {currentStep === 1 && (
          <div className="flex items-center gap-4 p-4 rounded-xl bg-blue-600/10 border border-blue-600/25">
            <div className="w-12 h-12 rounded-full bg-blue-600/20 flex items-center justify-center flex-shrink-0">
              <Navigation size={22} className="text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-widest font-semibold">Tiempo estimado de llegada</p>
              <p className="text-2xl font-black text-blue-300">{orden.eta}</p>
              <p className="text-xs text-slate-500 mt-0.5">{orden.direccion}</p>
            </div>
          </div>
        )}

        {/* Progress tracker */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6">
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-slate-800" />
            <div
              className="absolute left-[19px] top-6 w-0.5 bg-blue-500 transition-all duration-700"
              style={{ height: `${(currentStep / (STEPS.length - 1)) * 100}%` }}
            />

            <div className="space-y-6">
              {STEPS.map((step, i) => {
                const done    = i < currentStep
                const current = i === currentStep
                const pending = i > currentStep
                const Icon    = step.icon
                return (
                  <div key={step.id} className="flex items-start gap-4 relative z-10">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border-2 transition-all ${
                      done    ? 'bg-blue-600 border-blue-500' :
                      current ? 'bg-blue-600/20 border-blue-500' :
                                'bg-slate-800 border-slate-700'
                    }`}>
                      {current ? (
                        <span className={`w-3 h-3 rounded-full bg-blue-400 ${pulse ? 'scale-110' : 'scale-90'} transition-transform`} />
                      ) : (
                        <Icon size={16} className={done ? 'text-white' : 'text-slate-600'} />
                      )}
                    </div>
                    <div className="flex-1 pt-1.5">
                      <p className={`text-sm font-semibold ${done || current ? 'text-slate-100' : 'text-slate-600'}`}>
                        {step.label}
                        {current && <span className="ml-2 text-[10px] font-bold text-blue-400 bg-blue-600/15 border border-blue-600/30 px-1.5 py-0.5 rounded-full">AHORA</span>}
                      </p>
                      <p className={`text-xs mt-0.5 ${done || current ? 'text-slate-400' : 'text-slate-700'}`}>{step.desc}</p>
                    </div>
                    {done && <CheckCircle size={16} className="text-blue-500 flex-shrink-0 mt-1.5" />}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Technician card */}
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-5">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Tu Técnico</p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
                <Wrench size={16} className="text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-100">{orden.tecnico.nombre}</p>
                <div className="flex items-center gap-1 mt-0.5">
                  {[...Array(5)].map((_, i) => (
                    <span key={i} className="text-amber-400 text-[10px]">★</span>
                  ))}
                  <span className="text-[10px] text-slate-600 ml-1">5.0 · 48 trabajos</span>
                </div>
              </div>
            </div>
            <a href={`tel:${orden.tecnico.telefono}`}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600/15 border border-blue-600/30 text-blue-400 text-sm font-semibold hover:bg-blue-600/25 transition-colors">
              <Phone size={14} />Llamar
            </a>
          </div>
        </div>

        {/* Address */}
        <div className="flex items-start gap-3 p-4 rounded-xl bg-slate-900 border border-slate-700/50">
          <MapPin size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Dirección de instalación</p>
            <p className="text-sm text-slate-300 mt-1">{orden.direccion}</p>
          </div>
        </div>

        {/* Date */}
        <div className="flex items-center gap-3 p-4 rounded-xl bg-slate-900 border border-slate-700/50">
          <Clock size={16} className="text-blue-400 flex-shrink-0" />
          <div>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Fecha programada</p>
            <p className="text-sm text-slate-300 mt-1">{orden.fechaProgramada}</p>
          </div>
        </div>

      </div>
    </div>
  )
}
