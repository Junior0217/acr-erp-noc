/**
 * FotosOT — captura, marca con watermark anti-fraude (Canvas API) y sube fotos
 * de evidencia para una Orden de Trabajo.
 *
 * Flujo:
 *  1. Botón "Tomar foto" abre la cámara nativa (capture="environment" en móvil).
 *  2. Se solicita GPS via navigator.geolocation.getCurrentPosition (lat/lng).
 *  3. Canvas API dibuja la imagen original + overlay inferior con:
 *       ACR NETWORKS · OT-XXXX · timestamp · GPS lat,lng
 *  4. canvas.toBlob → POST multipart a /api/ordenes/:id/fotos/upload.
 *  5. Backend comprime + strip EXIF + sube a Supabase + crea OrdenFoto.
 *
 * Anti-fraude: el watermark es PIXELS del PNG/JPEG, no metadata.
 * Borrar el watermark requiere editar la imagen, que rompe el píxel-perfect
 * y deja un parche visible. Las coordenadas GPS provienen del navegador del
 * técnico al momento de la captura — falsearlas requiere mocking del API.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { Camera, Loader2, MapPin, AlertCircle, Image as ImageIcon, Trash2, Clock, User } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@shared/utils/api'

const WATERMARK_HEIGHT_RATIO = 0.12   // 12% inferior reservado al watermark
const WATERMARK_BG_OPACITY   = 0.62   // overlay negro semi-transparente
const JPEG_QUALITY           = 0.85

function fmtTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function pedirGPS() {
  if (!navigator.geolocation) return null
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 6000)
    navigator.geolocation.getCurrentPosition(
      pos => { clearTimeout(t); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }) },
      ()  => { clearTimeout(t); resolve(null) },
      { enableHighAccuracy: true, timeout: 5500, maximumAge: 0 },
    )
  })
}

async function fileToImage(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
    return img
  } finally {
    // Revocar después de un tick para que el browser ya tenga los pixels.
    setTimeout(() => URL.revokeObjectURL(url), 100)
  }
}

function dibujarWatermark(img, { otCode, gps }) {
  // Limita el lado largo a 1920px para no inflar el upload con fotos 4K.
  const MAX = 1920
  let w = img.naturalWidth, h = img.naturalHeight
  const scale = Math.min(1, MAX / Math.max(w, h))
  w = Math.round(w * scale); h = Math.round(h * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas no soportado.')

  ctx.drawImage(img, 0, 0, w, h)

  // ── Overlay inferior ────────────────────────────────────────────────
  const bandH = Math.max(60, Math.round(h * WATERMARK_HEIGHT_RATIO))
  ctx.fillStyle = `rgba(15, 23, 42, ${WATERMARK_BG_OPACITY})`   // slate-900 con alpha
  ctx.fillRect(0, h - bandH, w, bandH)
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)'                  // blue-500
  ctx.lineWidth   = Math.max(1, Math.round(h * 0.002))
  ctx.beginPath(); ctx.moveTo(0, h - bandH); ctx.lineTo(w, h - bandH); ctx.stroke()

  // Tipografías escaladas a la dimensión de la imagen.
  const fontPx     = Math.max(14, Math.round(bandH * 0.20))
  const smallPx    = Math.max(11, Math.round(bandH * 0.14))
  const padX       = Math.round(w * 0.025)
  const baseY      = h - bandH + Math.round(bandH * 0.35)
  const lineSpace  = Math.round(bandH * 0.28)

  ctx.fillStyle = '#60a5fa'
  ctx.font      = `bold ${fontPx}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillText('ACR NETWORKS', padX, baseY - fontPx)

  ctx.fillStyle = '#e2e8f0'
  ctx.font      = `${smallPx}px sans-serif`
  const otStr   = otCode ? `OT ${otCode}` : 'OT —'
  const tsStr   = new Date().toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const gpsStr  = gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}${gps.acc ? ` ±${Math.round(gps.acc)}m` : ''}` : 'GPS no disponible'

  ctx.fillText(otStr,  padX, baseY + lineSpace * 0.0)
  ctx.fillText(tsStr,  padX, baseY + lineSpace * 1.0)

  // GPS a la derecha si cabe, sino debajo
  const gpsWidth = ctx.measureText(gpsStr).width
  if (gpsWidth + padX < w * 0.45) {
    ctx.textAlign = 'right'
    ctx.fillStyle = gps ? '#34d399' : '#fbbf24'
    ctx.fillText(gpsStr, w - padX, baseY + lineSpace * 1.0)
    ctx.textAlign = 'left'
  } else {
    ctx.fillStyle = gps ? '#34d399' : '#fbbf24'
    ctx.fillText(gpsStr, padX, baseY + lineSpace * 2.0)
  }

  // Watermark diagonal sutil arriba (anti-photoshop visual).
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.rotate(-Math.PI / 8)
  ctx.fillStyle = 'rgba(255,255,255,0.045)'
  ctx.font      = `bold ${Math.round(h * 0.12)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('ACR NETWORKS', 0, 0)
  ctx.restore()

  return canvas
}

function canvasToBlob(canvas, quality = JPEG_QUALITY) {
  return new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob falló.')), 'image/jpeg', quality)
  })
}

export default function FotosOT({ ordenId, otCode, readonly = false }) {
  const [fotos, setFotos] = useState([])
  const [loading, setLoading] = useState(false)
  const [subiendo, setSubiendo] = useState(false)
  const [gpsStatus, setGpsStatus] = useState('idle')  // idle | pedido | ok | sin
  const fileRef = useRef(null)

  const cargar = useCallback(async () => {
    if (!ordenId) return
    setLoading(true)
    try {
      const r = await apiFetch(`/api/ordenes/${ordenId}/fotos`)
      if (r.ok) { const j = await r.json(); setFotos(Array.isArray(j.data) ? j.data : []) }
    } finally { setLoading(false) }
  }, [ordenId])

  useEffect(() => { cargar() }, [cargar])

  async function onFileSelected(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''   // reset input para permitir re-seleccionar el mismo archivo
    if (!/^image\//.test(file.type)) { toast.error('Selecciona una imagen.'); return }
    if (file.size > 8 * 1024 * 1024) { toast.error('Imagen excede 8MB.'); return }

    setSubiendo(true); setGpsStatus('pedido')
    try {
      const gps = await pedirGPS()
      setGpsStatus(gps ? 'ok' : 'sin')

      const img = await fileToImage(file)
      const canvas = dibujarWatermark(img, { otCode, gps })
      const blob = await canvasToBlob(canvas)
      if (blob.size > 5 * 1024 * 1024) {
        toast.error('Imagen procesada excede 5MB. Reduce calidad de cámara.'); return
      }

      const form = new FormData()
      form.append('file', blob, `ot-${otCode ?? ordenId}-${Date.now()}.jpg`)
      if (gps) {
        form.append('latitud',  String(gps.lat))
        form.append('longitud', String(gps.lng))
      }
      const r = await apiFetch(`/api/ordenes/${ordenId}/fotos/upload`, { method: 'POST', body: form })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        toast.error(j.error ?? 'Error al subir foto.')
        return
      }
      toast.success(gps ? 'Foto subida con GPS.' : 'Foto subida (sin GPS).')
      await cargar()
    } catch (err) {
      console.error('[OT FOTO]', err)
      toast.error('Error al procesar foto.')
    } finally {
      setSubiendo(false)
      setTimeout(() => setGpsStatus('idle'), 2000)
    }
  }

  async function borrar(fotoId) {
    if (!window.confirm('¿Eliminar esta foto-evidencia?')) return
    try {
      const r = await apiFetch(`/api/ordenes/${ordenId}/fotos/${fotoId}`, { method: 'DELETE' })
      if (r.status === 204) { toast.success('Foto eliminada.'); cargar() }
      else { toast.error('Error al eliminar.') }
    } catch { toast.error('Error de red.') }
  }

  if (!ordenId) {
    return (
      <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 p-3 text-xs text-slate-500 italic">
        Las fotos se habilitan después de guardar la orden.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ImageIcon size={14} className="text-blue-400" />
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Fotos de evidencia ({fotos.length})</p>
        </div>
        {!readonly && (
          <button type="button" onClick={() => fileRef.current?.click()} disabled={subiendo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors">
            {subiendo ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            {subiendo ? 'Procesando…' : 'Tomar foto'}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" capture="environment"
          onChange={onFileSelected} className="hidden" />
      </div>

      {gpsStatus === 'pedido' && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-900/20 border border-amber-700/30 text-[11px] text-amber-300">
          <Loader2 size={11} className="animate-spin" />Solicitando ubicación GPS… acepta el permiso del navegador.
        </div>
      )}
      {gpsStatus === 'sin' && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-900/15 border border-amber-700/20 text-[11px] text-amber-400">
          <AlertCircle size={11} />Foto sin GPS — el permiso fue denegado o no hay señal.
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-blue-500" /></div>
      ) : fotos.length === 0 ? (
        <p className="text-xs text-slate-600 text-center py-6 border border-dashed border-slate-800 rounded-lg">
          Sin fotos. Captura evidencia del trabajo realizado para protección anti-fraude.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {fotos.map(f => (
            <div key={f.id} className="relative group rounded-lg overflow-hidden border border-slate-700/40 bg-slate-800">
              <img src={f.url} alt="" loading="lazy" className="w-full h-32 object-cover" />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 to-transparent p-2">
                <div className="flex items-center gap-1 text-[9px] text-slate-300 font-mono">
                  <Clock size={9} /><span>{fmtTime(f.takenAt)}</span>
                </div>
                {f.latitud && f.longitud && (
                  <a href={`https://maps.google.com/?q=${f.latitud},${f.longitud}`} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-[9px] text-emerald-400 font-mono hover:text-emerald-300">
                    <MapPin size={9} />Ver en mapa
                  </a>
                )}
                {f.empleado?.nombre && (
                  <div className="flex items-center gap-1 text-[9px] text-blue-400 font-mono">
                    <User size={9} /><span>{f.empleado.nombre}</span>
                  </div>
                )}
              </div>
              {!readonly && (
                <button onClick={() => borrar(f.id)}
                  className="absolute top-1 right-1 p-1 rounded-md bg-red-900/60 hover:bg-red-600 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Eliminar">
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
