/**
 * ImageDropzone — drag & drop + click-to-pick para subir imagen al storage.
 * Hace POST multipart a `/api/inventario/upload-image` (o el endpoint que
 * se le pase) y emite onChange(url) cuando termina.
 *
 * El backend ya valida MIME/tamaño/SVG-safe y comprime con sharp -> el frontend
 * solo necesita feedback visual (preview optimista + estado de subida).
 */
import { useRef, useState } from 'react'
import { Upload, Loader2, X, Image as ImageIcon, Link2, Globe } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../utils/api'

export default function ImageDropzone({
  url,
  onChange,
  kind = 'producto',
  endpoint = '/api/inventario/upload-image',
  endpointUrl = '/api/inventario/upload-url',
  label = 'Imagen',
  desc = 'PNG / JPG / WebP / SVG · max 2MB',
  height = 160,
}) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null) // dataURL local mientras sube
  const [dragOver, setDragOver] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [mode, setMode] = useState('file') // 'file' | 'url'

  async function subirPorUrl() {
    const u = urlInput.trim()
    if (!u) return
    try { new URL(u) } catch { toast.error('URL inválida.'); return }
    setBusy(true)
    setPreview(u) // optimista
    try {
      const r = await apiFetch(endpointUrl, { method: 'POST', body: JSON.stringify({ url: u, kind }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.url) { toast.error(j.error ?? 'No se pudo importar la URL.'); setPreview(null); return }
      onChange?.(j.url)
      toast.success('Imagen importada y rehospedada.')
      setUrlInput(''); setPreview(null)
    } catch {
      toast.error('Error al importar URL.')
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

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
        <div className="flex items-center gap-3">
          <div className="inline-flex bg-slate-800 border border-slate-700 rounded-md p-0.5">
            <button type="button" onClick={() => setMode('file')}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 ${mode === 'file' ? 'bg-slate-700 text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}>
              <Upload size={10} />Archivo
            </button>
            <button type="button" onClick={() => setMode('url')}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 ${mode === 'url' ? 'bg-slate-700 text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}>
              <Globe size={10} />URL
            </button>
          </div>
          {url && !busy && (
            <button type="button" onClick={() => onChange?.(null)}
              className="text-[10px] text-slate-500 hover:text-red-400 transition-colors flex items-center gap-1">
              <X size={10} /> Quitar
            </button>
          )}
        </div>
      </div>

      {mode === 'url' && (
        <div className="mb-2 flex gap-2">
          <div className="relative flex-1">
            <Link2 size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type="url" value={urlInput} onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); subirPorUrl() } }}
              placeholder="https://… (Google/proveedor) — se rehospeda en Supabase"
              className="w-full pl-7 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
          </div>
          <button type="button" onClick={subirPorUrl} disabled={busy || !urlInput.trim()}
            className="px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40 flex items-center gap-1.5">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Globe size={11} />}
            Importar
          </button>
        </div>
      )}

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
