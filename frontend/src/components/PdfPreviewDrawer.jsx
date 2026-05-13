/**
 * PdfPreviewDrawer — slide-over (60% width desktop / fullscreen mobile) que
 * incrusta el PDF generado server-side en un <iframe src={blobUrl}>.
 *
 * Reemplaza el comportamiento viejo de window.open(blobUrl), que perdía
 * el contexto de la tabla. Acciones en barra: Descargar, Imprimir, Cerrar.
 *
 * El padre administra el blob: cuando llama onClose, este componente revoca
 * el objectURL via el handler `onClose(blobUrl)` que el padre debe respetar.
 */
import { useEffect } from 'react'
import { X, Download, Printer, Maximize2, FileText, Loader2 } from 'lucide-react'
import { descargarBlob, imprimirBlob } from '../utils/pdf'

export default function PdfPreviewDrawer({ open, blob, blobUrl, filename, title, subtitle, loading, onClose }) {
  // ESC cierra el drawer
  useEffect(() => {
    if (!open) return
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  if (!open) return null

  function handleDescargar() {
    if (blob && filename) descargarBlob(blob, filename)
  }
  function handleImprimir() {
    if (blob) imprimirBlob(blob)
  }
  function handleAbrirNuevaPestana() {
    if (blobUrl) window.open(blobUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Vista previa de PDF">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer panel: 100vw en móvil, 60vw en desktop (mín 720px) */}
      <div className="relative h-full w-full sm:w-[60vw] sm:min-w-[720px] bg-slate-950 border-l border-slate-800 flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/80 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-blue-600/15 border border-blue-600/30 flex items-center justify-center flex-shrink-0">
              <FileText size={16} className="text-blue-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-100 truncate">{title || 'Vista previa de documento'}</p>
              {subtitle && <p className="text-[11px] text-slate-500 font-mono truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 transition-colors flex-shrink-0"
            title="Cerrar (ESC)">
            <X size={18} />
          </button>
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-slate-800 bg-slate-900/40 flex-shrink-0">
          <button onClick={handleDescargar} disabled={!blob}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40">
            <Download size={12} />Descargar
          </button>
          <button onClick={handleImprimir} disabled={!blob}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors disabled:opacity-40">
            <Printer size={12} />Imprimir
          </button>
          <button onClick={handleAbrirNuevaPestana} disabled={!blobUrl}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors disabled:opacity-40"
            title="Abrir en pestaña nueva (más espacio)">
            <Maximize2 size={12} />Ampliar
          </button>
          <span className="ml-auto text-[10px] text-slate-600 font-mono">ESC para cerrar</span>
        </div>

        {/* Body: iframe con el PDF */}
        <div className="flex-1 min-h-0 bg-slate-900 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-400 gap-2 z-10 bg-slate-900/80">
              <Loader2 size={18} className="animate-spin text-blue-400" />
              <span className="text-sm">Generando PDF…</span>
            </div>
          )}
          {blobUrl ? (
            <iframe
              src={`${blobUrl}#toolbar=1&navpanes=0&zoom=page-fit`}
              title={title || 'PDF'}
              className="w-full h-full border-0 bg-white"
            />
          ) : !loading ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-2">
              <FileText size={36} className="opacity-40" />
              <p className="text-sm">Sin documento</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
