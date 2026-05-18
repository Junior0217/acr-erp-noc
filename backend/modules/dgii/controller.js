/**
 * backend/modules/dgii/controller.js
 */

const { z } = require('zod');
const { DgiiError } = require('./service');

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
      if (err instanceof DgiiError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[DGII CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createDgiiController({ service, schemas, helpers }) {
  if (!service || !schemas || !helpers) throw new Error('createDgiiController: deps required');
  const { compraSchema, compraUpdateSchema, listComprasQuerySchema } = schemas;
  const { validUUID } = helpers;

  function _badId(req, res) {
    if (!validUUID(req.params.id)) {
      res.status(400).json({ error: 'ID inválido.' });
      return true;
    }
    return false;
  }

  const listCompras = _wrap(async (req) =>
    service.listarCompras(listComprasQuerySchema.parse(req.query))
  );

  const getCompra = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    return service.obtenerCompra(req.params.id);
  });

  const createCompra = _wrap(async (req) => {
    const data = compraSchema.parse(req.body);
    return service.crearCompra(data, req.user, _extractReqMeta(req));
  });

  const updateCompra = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    const data = compraUpdateSchema.parse(req.body);
    return service.actualizarCompra(req.params.id, data, req.user, _extractReqMeta(req));
  });

  const deleteCompra = _wrap(async (req, res) => {
    if (_badId(req, res)) return;
    return service.eliminarCompra(req.params.id, req.user, _extractReqMeta(req));
  });

  const listHistorial = _wrap(async (req) =>
    service.listarHistorialReportes(req.query || {})
  );

  return { listCompras, getCompra, createCompra, updateCompra, deleteCompra, listHistorial };
}

module.exports = createDgiiController;
