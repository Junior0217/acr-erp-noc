/**
 * backend/modules/ventas/cotizador-libre/controller.js
 *
 * Capa HTTP del Cotizador Libre. Recibe payload JSON, valida con Zod, delega
 * al service para render PDF en memoria, devuelve `application/pdf` inline.
 *
 * Factory: createCotizadorLibreController({ service, schema, auditReq })
 */

const { z } = require('zod');
const {
  cotizadorLibreSchema,
  draftPayloadSchema,
  numeroParamSchema,
} = require('./schema');
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

  // ─── Drafts CRUD ──────────────────────────────────────────────────────────
  const listDrafts = _wrap(async (req, res) => {
    const empleadoId = Number(req.user?.sub);
    const limit      = req.query?.limit;
    const out = await service.listDrafts(empleadoId, { limit });
    res.json(out);
  });

  const getDraft = _wrap(async (req, res) => {
    const empleadoId = Number(req.user?.sub);
    const numero     = numeroParamSchema.parse(req.params.numero);
    const draft      = await service.getDraft(empleadoId, numero);
    res.json(draft);
  });

  const upsertDraft = _wrap(async (req, res) => {
    const empleadoId = Number(req.user?.sub);
    const dto        = draftPayloadSchema.parse(req.body ?? {});
    const saved      = await service.upsertDraft(empleadoId, dto);
    auditReq('cotizador_libre:draft_upsert', req, {
      numeroDocumento: saved.numeroDocumento,
      items:           Array.isArray(saved.items) ? saved.items.length : null,
    });
    res.json({ ok: true, id: saved.id, updatedAt: saved.updatedAt });
  });

  const deleteDraft = _wrap(async (req, res) => {
    const empleadoId = Number(req.user?.sub);
    const numero     = numeroParamSchema.parse(req.params.numero);
    const out        = await service.deleteDraft(empleadoId, numero);
    auditReq('cotizador_libre:draft_delete', req, { numeroDocumento: numero, deleted: out.deleted });
    res.json(out);
  });

  return { postPdf, listDrafts, getDraft, upsertDraft, deleteDraft };
}

module.exports = createCotizadorLibreController;
