/**
 * Cliente PDF: descarga desde endpoints server-side y manejo de Blob.
 *
 * `fetchPdfBlob`     — descarga el PDF como Blob (para Drawer/preview en SPA).
 * `abrirPdfServidor` — descarga + abre en pestaña nueva (fallback / portal B2C).
 *
 * Por qué blob en vez de window.open(url):
 *   - Las rutas /api/.../pdf están bajo verificarJWT y exigen cookie httpOnly.
 *     window.open envía cookies pero no permite ver progreso ni manejar 401/500.
 */
import { apiFetch } from './api'
import { portalFetch } from './portalApi'
import { toast } from 'sonner'

/**
 * Descarga un PDF y devuelve { blob, blobUrl, filename } sin abrirlo.
 * Caller debe revocar blobUrl con URL.revokeObjectURL al cerrar el preview.
 */
export async function fetchPdfBlob(path, filename = 'documento.pdf', opts = {}) {
  const fetchFn = opts.portal ? portalFetch : apiFetch
  const r = await fetchFn(path, opts.fetchOpts ?? {})
  if (!r.ok) {
    let msg = 'No se pudo generar el PDF.'
    try { const j = await r.json(); if (j?.error) msg = j.error } catch {}
    toast.error(msg)
    return null
  }
  const blob = await r.blob()
  if (!blob || blob.size === 0) { toast.error('PDF vacío recibido del servidor.'); return null }
  return { blob, blobUrl: URL.createObjectURL(blob), filename }
}

/**
 * Descarga + abre un PDF en pestaña nueva (legacy / portal B2C).
 * Para el panel admin se usa Drawer en su lugar.
 */
export async function abrirPdfServidor(path, filename = 'documento.pdf', opts = {}) {
  const result = await fetchPdfBlob(path, filename, opts)
  if (!result) return false
  const { blobUrl } = result
  const win = window.open(blobUrl, '_blank', 'noopener,noreferrer')
  if (!win) {
    const a = document.createElement('a')
    a.href = blobUrl; a.download = filename
    document.body.appendChild(a); a.click(); a.remove()
    toast.info('PDF descargado (popup bloqueado).')
  } else {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  }
  return true
}

/**
 * Descarga forzada de un Blob (botón Descargar en Drawer).
 */
export function descargarBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4_000)
}

/**
 * Imprime un PDF embebido por objectURL.
 * Estrategia: abrir blob en window oculta -> esperar load -> window.print.
 * Más confiable que iframe.contentWindow.print en Chromium con blob: URLs.
 */
export function imprimirBlob(blob) {
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    toast.error('Habilita popups para imprimir.')
    setTimeout(() => URL.revokeObjectURL(url), 4_000)
    return
  }
  // El visor PDF nativo del navegador maneja el print dialog si el usuario lo dispara
  // explícitamente desde la nueva pestaña. Forzar print() vía postMessage no funciona
  // cross-origin con blobs en Chromium reciente.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * POST bulk export -> recibe ZIP stream y dispara descarga.
 */
export async function descargarBulkZip(ids, tipo) {
  if (!Array.isArray(ids) || ids.length === 0) return false
  try {
    const r = await apiFetch('/api/pdf/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, tipo }),
    })
    if (!r.ok) {
      let msg = 'Error generando ZIP.'
      try { const j = await r.json(); if (j?.error) msg = j.error } catch {}
      toast.error(msg)
      return false
    }
    const blob = await r.blob()
    const stamp = new Date().toISOString().replace(/-|:|T/g, '').slice(0, 14)
    const filename = `${tipo === 'cotizacion' ? 'cotizaciones' : 'facturas'}-${stamp}.zip`
    descargarBlob(blob, filename)
    toast.success(`${ids.length} ${tipo}s exportadas a ZIP`)
    return true
  } catch (e) {
    console.error('bulk-zip', e)
    toast.error('Error de conexión al exportar.')
    return false
  }
}
