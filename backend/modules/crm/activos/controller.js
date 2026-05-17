/**
 * backend/modules/crm/activos/controller.js
 */

const { z } = require('zod');
const { ActivoError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const d = await fn(req, res);
      if (!res.headersSent) {
        const status = d?.status ?? 200;
        if (d?.body == null && (status === 204 || status === 205)) return res.status(status).end();
        return res.status(status).json(d?.body ?? {});
      }
    } catch (err) {
      if (err instanceof z.ZodError)  return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof ActivoError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[ACTIVOS CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createActivosController({ service, schemas, helpers }) {
  if (!service || !schemas || !helpers) throw new Error('createActivosController: deps required');
  const { activoSchema, timelineEventoSchema, listActivosQuerySchema } = schemas;
  const { validUUID } = helpers;

  function _badId(req, res) {
    if (!validUUID(req.params.id)) {
      res.status(400).json({ error: 'ID inválido.' });
      return true;
    }
    return false;
  }

  const list = _wrap(async (req) => {
    const q = listActivosQuerySchema.parse(req.query);
    return service.listarActivos(q);
  });

  const create = _wrap(async (req) => {
    const data = activoSchema.parse(req.body);
    return service.crearActivo(data, req.user, _extractReqMeta(req));
  });

  const remove = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    return service.eliminarActivo(req.params.id);
  });

  const timeline = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    return service.listarTimeline(req.params.id);
  });

  const createTimeline = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    const data = timelineEventoSchema.parse(req.body);
    return service.crearTimelineEvento(req.params.id, data, req.user, _extractReqMeta(req));
  });

  return { list, create, remove, timeline, createTimeline };
}

module.exports = createActivosController;
