/**
 * backend/modules/ventas/taller/controller.js
 */

const { z } = require('zod');
const { TallerError } = require('./service');

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
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof TallerError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[TALLER CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createTallerController({ service, schemas, helpers }) {
  if (!service || !schemas || !helpers) throw new Error('createTallerController: deps required');
  const { ticketTallerSchema, ticketEstadoSchema, listTallerQuerySchema, ticketTallerUpdateSchema } = schemas;
  const { validUUID } = helpers;

  function _badId(req, res) {
    if (!validUUID(req.params.id)) {
      res.status(400).json({ error: 'ID inválido.' });
      return true;
    }
    return false;
  }

  const list = _wrap(async (req) => service.listarTickets(listTallerQuerySchema.parse(req.query)));

  const create = _wrap(async (req) => {
    const data = ticketTallerSchema.parse(req.body);
    return service.crearTicket(data, req.user, _extractReqMeta(req));
  });

  const updateEstado = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    const data = ticketEstadoSchema.parse(req.body);
    return service.cambiarEstado(req.params.id, data, req.user, _extractReqMeta(req));
  });

  const update = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    const data = ticketTallerUpdateSchema.parse(req.body);
    return service.editarTicket(req.params.id, data);
  });

  const reabrir = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    return service.reabrirTicket(req.params.id, req.user, _extractReqMeta(req));
  });

  return { list, create, updateEstado, update, reabrir };
}

module.exports = createTallerController;
