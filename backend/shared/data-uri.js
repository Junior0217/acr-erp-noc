/**
 * backend/shared/data-uri.js
 *
 * Validación de data URIs de foto (image/jpeg|png|webp en base64). Antes el
 * patrón estaba duplicado entre el validador Zod del cotizador
 * (modules/ventas/cotizador-libre/schema.js) y el render del anexo
 * (modules/ventas/cotizador-libre/service.js). Centralizado para que ambas
 * capas usen exactamente la misma definición de "foto válida".
 *
 * El grupo de captura 2 es el payload base64 — `FOTO_DATA_URI_RE.exec(s)[2]`
 * permite medir el tamaño aproximado del binario sin decodificar.
 */

const FOTO_DATA_URI_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

function isFotoDataUri(s) {
  return typeof s === 'string' && FOTO_DATA_URI_RE.test(s);
}

module.exports = { FOTO_DATA_URI_RE, isFotoDataUri };
