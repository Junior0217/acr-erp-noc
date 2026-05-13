/**
 * VoiceDictationButton — botón de micrófono que activa Web Speech API nativa.
 * Append-mode: el texto reconocido se CONCATENA al valor actual (no reemplaza).
 *
 * Props:
 *   value, onChange  — controlled value del textarea/input padre
 *   lang             — 'es-DO' por defecto (acepta cualquier BCP-47)
 *   maxAlternatives  — confianza alternativas (default 1)
 *   className        — wrapper opcional
 *
 * Estados visuales:
 *   idle      → ícono Mic gris
 *   listening → ícono Mic rojo pulsante
 *   error     → tooltip + reset a idle
 *
 * Browser support: Chrome/Edge/Safari iOS 14.5+. Firefox NO soporta nativo
 * (muestra el botón deshabilitado con tooltip explicativo).
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { toast } from 'sonner'

const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
  : null

export default function VoiceDictationButton({ value, onChange, lang = 'es-DO', className = '' }) {
  const [listening, setListening] = useState(false)
  const recRef = useRef(null)
  const baseRef = useRef('')  // snapshot del value al iniciar el dictado

  useEffect(() => {
    return () => { try { recRef.current?.stop() } catch {} }
  }, [])

  if (!SR) {
    return (
      <button type="button" disabled
        title="Dictado por voz no soportado en este navegador (usa Chrome/Edge/Safari iOS)."
        className={`p-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-600 cursor-not-allowed ${className}`}>
        <MicOff size={13} />
      </button>
    )
  }

  function iniciar() {
    if (listening) { detener(); return }
    try {
      const rec = new SR()
      rec.lang = lang
      rec.continuous = true
      rec.interimResults = true
      rec.maxAlternatives = 1

      baseRef.current = value ?? ''
      let interim = ''

      rec.onresult = (event) => {
        let finalText = ''
        interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i]
          if (r.isFinal) finalText += r[0].transcript + ' '
          else interim += r[0].transcript
        }
        if (finalText) {
          baseRef.current = (baseRef.current + ' ' + finalText.trim()).trim()
        }
        // Refleja interim + final en el field para feedback inmediato.
        onChange((baseRef.current + (interim ? ' ' + interim : '')).slice(0, 5000))
      }
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          toast.error('Permiso de micrófono denegado.')
        } else if (e.error === 'no-speech') {
          // silencio prolongado — no es un error real
        } else {
          toast.error(`Dictado falló: ${e.error}`)
        }
        setListening(false)
      }
      rec.onend = () => {
        setListening(false)
        // Limpia interim residual y deja solo el texto final.
        onChange(baseRef.current.trim())
      }
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch (err) {
      console.error('[VOICE]', err)
      toast.error('No se pudo iniciar el dictado.')
    }
  }

  function detener() {
    try { recRef.current?.stop() } catch {}
    setListening(false)
  }

  return (
    <button type="button" onClick={iniciar}
      title={listening ? 'Detener dictado' : 'Dictar por voz'}
      className={`relative p-1.5 rounded-md border transition-colors ${
        listening
          ? 'bg-red-600 border-red-500 text-white animate-pulse shadow-lg shadow-red-600/40'
          : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-blue-400 hover:border-blue-600/40'
      } ${className}`}>
      <Mic size={13} />
      {listening && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-300 animate-ping" />
      )}
    </button>
  )
}
