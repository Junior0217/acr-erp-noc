/**
 * backend/shared/html-escape.js
 *
 * Único helper de escape HTML del backend. Antes vivía duplicado como
 * `escape()` en services/pdf-templates.js y `_esc()` en
 * modules/ventas/cotizador-libre/service.js — dos copias que podían divergir
 * en su política de escape (un fix en una no llegaba a la otra). Centralizado
 * aquí para que TODO render de PDF use exactamente la misma sanitización.
 *
 * Escapa los 5 caracteres peligrosos en contexto HTML de texto/atributo:
 *   &  → &amp;   (debe ir PRIMERO para no doble-escapar las entidades siguientes)
 *   <  → &lt;
 *   >  → &gt;
 *   "  → &quot;
 *   '  → &#39;
 *
 * `null`/`undefined` → '' (cadena vacía) para no imprimir "null"/"undefined".
 */

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
