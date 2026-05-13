/**
 * Cliente PDF: descarga desde endpoints server-side y abre/descarga via Blob.
 *
 * Por qué blob + objectURL en vez de window.open(url):
 *   - Las rutas /api/.../pdf están bajo verificarJWT y exigen cookie httpOnly.
 *     window.open envía cookies pero no permite ver progreso ni manejar 401/500.
 *   - Con fetch+blob: spinner, manejo de error con toast, y el navegador abre
 *     un objectURL en una pestaña con su visor PDF nativo (donde el usuario
 *     puede imprimir o descargar). Sin esto el usuario veía el HTML viejo.
 */
import { apiFetch } from './api'
import { portalFetch } from './portalApi'
import { toast } from 'sonner'

/**
 * Descarga + abre un PDF generado por el backend.
 * @param {string} path     ruta del endpoint, ej. '/api/ventas/facturas/abc/pdf'
 * @param {string} filename nombre por defecto en la pestaña/descarga
 * @param {object} [opts]   { portal: bool } usa portalFetch si true
 * @returns {Promise<boolean>}
 */
export async function abrirPdfServidor(path, filename = 'documento.pdf', opts = {}) {
  const fetchFn = opts.portal ? portalFetch : apiFetch
  try {
    const r = await fetchFn(path)
    if (!r.ok) {
      let msg = 'No se pudo generar el PDF.'
      try { const j = await r.json(); if (j?.error) msg = j.error } catch {}
      toast.error(msg)
      return false
    }
    const blob = await r.blob()
    if (!blob || blob.size === 0) { toast.error('PDF vacío recibido del servidor.'); return false }
    const url = URL.createObjectURL(blob)

    // Visor PDF nativo del navegador: pestaña nueva con controles imprimir/descargar.
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    if (!win) {
      // Popup bloqueado -> fallback: descarga directa con <a download>.
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      toast.info('PDF descargado (popup bloqueado).')
    } else {
      // El visor toma su tiempo en leer el blob; liberar URL tras un margen.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    return true
  } catch (e) {
    console.error('[pdf:abrir]', e)
    toast.error('Error de conexión al generar el PDF.')
    return false
  }
}
