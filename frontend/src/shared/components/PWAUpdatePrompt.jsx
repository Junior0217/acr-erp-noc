import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { RefreshCw } from 'lucide-react'

// Con registerType: 'autoUpdate' en vite.config, el SW se replaza solo (skipWaiting
// + clientsClaim implícitos). Cuando vite-plugin-pwa detecta nueva versión seta
// needRefresh=true. Este componente entonces:
//   1. Avisa al usuario con un toast persistente (5s).
//   2. Auto-aplica updateServiceWorker(true) si no hay interacción → reload sin
//      esperar clics, alineado con la directiva "actualización al instante".
// Si el usuario hace click en "Recargar ahora" la transición es inmediata.

const AUTO_APPLY_MS = 5000

export default function PWAUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      // Heartbeat hourly — atrapa nuevas builds aunque el usuario nunca cambie
      // de ruta y sólo tenga la app abierta en una pestaña inactiva.
      if (r) setInterval(() => r.update(), 60 * 60 * 1000)
    },
  })

  const [count, setCount] = useState(AUTO_APPLY_MS / 1000)

  useEffect(() => {
    if (!needRefresh) return
    let secs = AUTO_APPLY_MS / 1000
    setCount(secs)
    const tick = setInterval(() => {
      secs -= 1
      setCount(secs)
      if (secs <= 0) {
        clearInterval(tick)
        updateServiceWorker(true)
      }
    }, 1000)
    return () => clearInterval(tick)
  }, [needRefresh, updateServiceWorker])

  if (!needRefresh) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 bg-blue-600 text-white rounded-xl shadow-2xl border border-blue-500 text-sm font-medium animate-in slide-in-from-bottom-2">
      <RefreshCw size={15} className="flex-shrink-0 animate-spin" />
      <span>Nueva versión lista — recargando en <span className="font-mono font-bold tabular-nums">{count}s</span></span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="ml-1 px-3 py-1 bg-white text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-50 transition-colors"
      >
        Recargar ahora
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        className="text-blue-200 hover:text-white text-xs font-mono opacity-70 hover:opacity-100"
        title="Posponer (re-aparecerá en 1 h)"
      >
        ×
      </button>
    </div>
  )
}
