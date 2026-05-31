/**
 * backend/shared/format.js
 *
 * Helpers de formato compartidos (moneda RD$, fechas es-DO). Antes vivían SOLO
 * en services/pdf-templates.js y el módulo cotizador-libre dependía de ese
 * archivo de plantillas solo para formatear — acoplamiento innecesario
 * (cotizador ↔ plantillas PDF). Centralizados aquí para que cualquier módulo
 * formatee sin arrastrar el template engine.
 *
 * pdf-templates.js los re-exporta para no romper imports existentes.
 */

function fmtMoney(n) {
  return new Intl.NumberFormat('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);
}

function fechaCorta(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fechaLarga(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' });
}

module.exports = { fmtMoney, fechaCorta, fechaLarga };
