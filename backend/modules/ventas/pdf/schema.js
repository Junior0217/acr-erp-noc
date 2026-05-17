/**
 * backend/modules/ventas/pdf/schema.js
 *
 * Zod DTOs del sub-módulo PDF (cotización / factura / bulk export).
 */

const { z } = require('zod');

const BULK_PDF_MAX = 50;

const bulkPdfSchema = z.object({
  ids:  z.array(z.string().uuid()).min(1).max(BULK_PDF_MAX),
  tipo: z.enum(['factura', 'cotizacion']),
});

/**
 * Query params para GET /(cotizaciones|facturas)/:id/pdf.
 * `fresh=1`  → fuerza regeneración (ignora cache).
 * `json=1`   → devuelve { url, cached } en lugar de redirect 302 (evita CORS
 *              cuando el SPA hace fetch con credentials:include).
 */
const pdfQuerySchema = z.object({
  fresh: z.enum(['0', '1']).optional(),
  json:  z.enum(['0', '1']).optional(),
});

module.exports = {
  BULK_PDF_MAX,
  bulkPdfSchema,
  pdfQuerySchema,
};
