import { useRegisterSW } from 'virtual:pwa-register/react'
import { RefreshCw } from 'lucide-react'

export default function PWAUpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      if (r) setInterval(() => r.update(), 60 * 60 * 1000)
    },
  })

  if (!needRefresh) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 bg-blue-600 text-white rounded-xl shadow-2xl border border-blue-500 text-sm font-medium animate-in slide-in-from-bottom-2">
      <RefreshCw size={15} className="flex-shrink-0" />
      <span>Nueva versión disponible</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="ml-1 px-3 py-1 bg-white text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-50 transition-colors"
      >
        Actualizar ahora
      </button>
    </div>
  )
}
