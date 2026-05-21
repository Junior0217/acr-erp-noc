/**
 * backend/modules/ventas/cotizador-libre/controller.js
 *
 * Capa HTTP del Cotizador Libre. Recibe payload JSON, valida con Zod, delega
 * al service para render PDF en memoria, devuelve `application/pdf` inline.
 *
 * Factory: createCotizadorLibreController({ service, schema, auditReq })
 */

const { z } = require('zod');
const { cotizadorLibreSchema } = require('./schema');
const { CotizadorLibreError }  = require('./service');

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.', issues: err.issues });
      }
      if (err instanceof CotizadorLibreError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[COTIZADOR-LIBRE CTRL]', err.message, err.stack);
      if (!res.headersSent) res.status(500).json({ error: 'Error generando PDF del cotizador libre.', detail: err.message });
    }
  };
}

function createCotizadorLibreController({ service, auditReq }) {
  if (!service)                       throw new Error('createCotizadorLibreController: service required');
  if (typeof auditReq !== 'function') throw new Error('createCotizadorLibreController: auditReq required');

  const postPdf = _wrap(async (req, res) => {
    const dto = cotizadorLibreSchema.parse(req.body ?? {});
    const { buffer, totales, numeroDocumento } = await service.generarPdf(dto);

    // Auditoría operacional: cuántas líneas, total RD$, quién lo emitió.
    // Sin PII detallada — solo metadatos del documento.
    auditReq('cotizador_libre:pdf', req, {
      numeroDocumento,
      items:    dto.items.length,
      total:    totales.total,
      itbis:    totales.itbis,
      descuento: totales.descuento,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cotizacion-libre-${numeroDocumento}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Cotizador-Libre', '1');
    res.end(buffer);
  });

  return { postPdf };
}

module.exports = createCotizadorLibreController;
