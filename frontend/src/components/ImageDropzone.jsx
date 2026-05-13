/**
 * ImageDropzone — drag & drop + click-to-pick para subir imagen al storage.
 * Hace POST multipart a `/api/inventario/upload-image` (o el endpoint que
 * se le pase) y emite onChange(url) cuando termina.
 *
 * El backend ya valida MIME/tamaño/SVG-safe y comprime con sharp -> el frontend
 * solo necesita feedback visual (preview optimista + estado de subida).
 */
import { useRef, useState } from 'react'
import { Upload, Loader2, X, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../utils/api'

export default function ImageDropzone({
  url,
  onChange,
  kind = 'producto',
  endpoint = '/api/inventario/upload-image',
  label = 'Imagen',
  desc = 'PNG / JPG / WebP / SVG · max 2MB',
  height = 160,
}) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null) // dataURL local mientras sube
  const [dragOver, setDragOver] = useState(false)

  async function subir(file) {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { toast.error('Excede 2MB.'); return }
    if (!file.type.startsWith('image/')) { toast.error('Solo imágenes.'); return }
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target.result)
    reader.readAsDataURL(file)

    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      const r = await apiFetch(endpoint, { method: 'POST', body: fd })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.url) { toast.error(j.error ?? 'Error al subir.'); setPreview(null); return }
      onChange?.(j.url)
      toast.success('Imagen subida.')
      setPreview(null)
    } catch {
      toast.error('Error de red al subir.')
      setPreview(null)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  function onDrop(e) {
    e.preventDefault(); setDragOver(false)
    const f = e.dataTransfer?.files?.[0]
    if (f) subir(f)
  }

  const display = preview ?? url ?? ''

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</label>
        {url && !busy && (
          <button type="button" onClick={() => onChange?.(null)}
            className="text-[10px] text-slate-500 hover:text-red-400 transition-colors flex items-center gap-1">
            <X size={10} /> Quitar
          </button>
        )}
      </div>
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button" tabIndex={0}
        style={{ minHeight: height }}
        className={`relative overflow-hidden rounded-xl border-2 border-dashed transition-all cursor-pointer
          ${dragOver ? 'border-blue-500 bg-blue-500/10' : display ? 'border-slate-700 bg-slate-900' : 'border-slate-700/60 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/60'}
          ${busy ? 'pointer-events-none opacity-70' : ''}`}>
        {display ? (
          <>
            <img src={display} alt="" className="w-full h-full object-cover" style={{ minHeight: height }}
              onError={e => { e.currentTarget.style.display = 'none' }} />
            {!busy && (
              <div className="absolute inset-0 bg-black/0 hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                <span className="px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-700 text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                  <Upload size={11} /> Reemplazar
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center">
            <ImageIcon size={20} className={dragOver ? 'text-blue-400' : 'text-slate-600'} />
            <p className="text-xs font-semibold text-slate-400">
              {dragOver ? 'Soltar imagen aquí' : 'Arrastra o haz click para subir'}
            </p>
            <p className="text-[10px] text-slate-600">{desc}</p>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700">
              <Loader2 size={14} className="animate-spin text-blue-400" />
              <span className="text-xs font-semibold text-slate-300">Subiendo…</span>
            </div>
          </div>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden"
          onChange={e => subir(e.target.files?.[0])} />
      </div>
    </div>
  )
}
