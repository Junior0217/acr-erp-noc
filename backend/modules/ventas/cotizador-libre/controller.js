/**
 * backend/modules/ventas/cotizador-libre/controller.js
 *
 * Capa HTTP del Cotizador Libre. Recibe payload JSON, valida con Zod, delega
 * al service para render PDF en memoria, devuelve `application/pdf` inline.
 *
 * Ciclo 13: extrae el scope (requesterId + isGlobal + targetEmpleadoId) de
 * req.user.permisos + query/body. Un caller con `ventas:cotizador_libre_global`
 * o `sistema:owner` puede listar, abrir y sobreescribir borradores de otros
 * empleados (co-edición en vivo). Un caller sin esos permisos queda fail-closed
 * en sus propios drafts incluso si intenta pasar targetEmpleadoId.
 *
 * Factory: createCotizadorLibreController({ service, auditReq })
 */

const { z } = require('zod');
const {
  cotizadorLibreSchema,
  draftPayloadSchema,
  numeroParamSchema,
  targetEmpleadoQuerySchema,
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

// Detecta si el caller tiene permiso supervisor (puede ver/editar drafts de
// otros empleados). El `sistema:owner` lo activa siempre, como también lo
// hace en `requerirPermiso`. Esta función es la fuente de verdad para el
// scope global server-side — el frontend NO decide; solo sugiere via params.
function _isGlobalCaller(req) {
  const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : [];
  return permisos.includes('sistema:owner') ||
         permisos.includes('ventas:cotizador_libre_global');
}

function createCotizadorLibreController({ service, auditReq }) {
  if (!service)                       throw new Error('createCotizadorLibreController: service required');
  if (typeof auditReq !== 'function') throw new Error('createCotizadorLibreController: auditReq required');

  const postPdf = _wrap(async (req, res) => {
    const dto = cotizadorLibreSchema.parse(req.body ?? {});
    const { buffer, totales, numeroDocumento } = await service.generarPdf(dto);

    // Auditoría operacional: cuántas líneas, total RD$, quién lo emitió, y
    // cuántas fotos viajan en el anexo. Sin PII detallada.
    const fotos = dto.items.reduce((n, it) => n + (Array.isArray(it.fotos) ? it.fotos.length : 0), 0);
    auditReq('cotizador_libre:pdf', req, {
      numeroDocumento,
      items:     dto.items.length,
      total:     totales.total,
      itbis:     totales.itbis,
      descuento: totales.descuento,
      fotos,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cotizacion-libre-${numeroDocumento}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Cotizador-Libre', '1');
    res.end(buffer);
  });

  // ─── Drafts CRUD ──────────────────────────────────────────────────────────
  const listDrafts = _wrap(async (req, res) => {
    const requesterId = Number(req.user?.sub);
    const isGlobal    = _isGlobalCaller(req);
    const q           = targetEmpleadoQuerySchema.parse(req.query ?? {});
    // Si caller NO es global, se ignora cualquier ?empleadoId= que mande el cliente.
    const targetEmpleadoId = isGlobal ? (q.empleadoId ?? null) : null;
    const out = await service.listDrafts(
      { requesterId, isGlobal, targetEmpleadoId },
      { limit: q.limit },
    );
    res.json(out);
  });

  const getDraft = _wrap(async (req, res) => {
    const requesterId = Number(req.user?.sub);
    const isGlobal    = _isGlobalCaller(req);
    const numero      = numeroParamSchema.parse(req.params.numero);
    const q           = targetEmpleadoQuerySchema.parse(req.query ?? {});
    const targetEmpleadoId = isGlobal ? (q.empleadoId ?? null) : null;
    const draft = await service.getDraft(
      { requesterId, isGlobal, targetEmpleadoId },
      numero,
    );
    res.json(draft);
  });

  const upsertDraft = _wrap(async (req, res) => {
    const requesterId = Number(req.user?.sub);
    const isGlobal    = _isGlobalCaller(req);
    const dto         = draftPayloadSchema.parse(req.body ?? {});
    // targetEmpleadoId del body solo se honra si el caller es global.
    // Para usuarios ordinarios se descarta — fail-closed.
    const targetEmpleadoId = isGlobal ? (dto.targetEmpleadoId ?? null) : null;
    const saved = await service.upsertDraft(
      { requesterId, isGlobal, targetEmpleadoId },
      dto,
    );
    auditReq('cotizador_libre:draft_upsert', req, {
      numeroDocumento: saved.numeroDocumento,
      items:           Array.isArray(saved.items) ? saved.items.length : null,
      ownerEmpleadoId: saved.empleadoId,
      crossUser:       !!(isGlobal && targetEmpleadoId && targetEmpleadoId !== requesterId),
    });
    res.json({ ok: true, id: saved.id, updatedAt: saved.updatedAt, empleadoId: saved.empleadoId });
  });

  const deleteDraft = _wrap(async (req, res) => {
    const requesterId = Number(req.user?.sub);
    const isGlobal    = _isGlobalCaller(req);
    const numero      = numeroParamSchema.parse(req.params.numero);
    const q           = targetEmpleadoQuerySchema.parse(req.query ?? {});
    const targetEmpleadoId = isGlobal ? (q.empleadoId ?? null) : null;
    const out = await service.deleteDraft(
      { requesterId, isGlobal, targetEmpleadoId },
      numero,
    );
    auditReq('cotizador_libre:draft_delete', req, {
      numeroDocumento: numero,
      deleted: out.deleted,
      crossUser: !!(isGlobal && targetEmpleadoId && targetEmpleadoId !== requesterId),
    });
    res.json(out);
  });

  // Helper expuesto para que el frontend pueda saber si está en modo global
  // (oculta/muestra selectores) sin tener que mirar permisos por sí mismo.
  const whoami = _wrap(async (req, res) => {
    res.json({
      requesterId: Number(req.user?.sub),
      isGlobal:    _isGlobalCaller(req),
      permisos:    Array.isArray(req.user?.permisos) ? req.user.permisos.filter(p => p.startsWith('ventas:cotizador') || p === 'cotizador_libre_manual' || p === 'sistema:owner') : [],
    });
  });

  return { postPdf, listDrafts, getDraft, upsertDraft, deleteDraft, whoami };
}

module.exports = createCotizadorLibreController;
