/**
 * backend/modules/ventas/carrito/controller.js
 */

const { z } = require('zod');
const { CarritoError } = require('./service');

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
      if (err instanceof z.ZodError)   return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof CarritoError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[CARRITO CTRL]', err.message);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Error interno.' });
    }
  };
}

function createCarritoController({ service, schemas }) {
  if (!service || !schemas) throw new Error('createCarritoController: deps required');
  const { patchCarritoSchema, addItemSchema, patchItemSchema, checkoutSchema } = schemas;

  const get   = _wrap(async (req) => service.obtenerCarrito(req.user.sub));

  const patch = _wrap(async (req) => {
    const data = patchCarritoSchema.parse(req.body);
    return service.actualizarCarrito(req.user.sub, data);
  });

  const addItem = _wrap(async (req) => {
    const data = addItemSchema.parse(req.body);
    return service.agregarItem(req.user.sub, data);
  });

  const updateItem = _wrap(async (req, res) => {
    const lineaId = parseInt(req.params.lineaId, 10);
    if (!lineaId) return res.status(400).json({ error: 'ID inválido.' });
    const data = patchItemSchema.parse(req.body);
    return service.actualizarLinea(req.user.sub, lineaId, data, req.user, _extractReqMeta(req));
  });

  const removeItem = _wrap(async (req, res) => {
    const lineaId = parseInt(req.params.lineaId, 10);
    if (!lineaId) return res.status(400).json({ error: 'ID inválido.' });
    return service.eliminarLinea(req.user.sub, lineaId);
  });

  const clear = _wrap(async (req) => service.vaciarCarrito(req.user.sub));

  const checkout = _wrap(async (req) => {
    const data = checkoutSchema.parse(req.body);
    return service.checkout(req.user.sub, data, req.user, _extractReqMeta(req));
  });

  return { get, patch, addItem, updateItem, removeItem, clear, checkout };
}

module.exports = createCarritoController;
