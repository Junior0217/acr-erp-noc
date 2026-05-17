/**
 * backend/modules/ventas/pos/controller.js
 *
 * Capa HTTP del módulo POS. 3 handlers thin: verifyPin / venta / facturaManual.
 * Cero lógica de negocio. Cero Prisma. Cero cálculos.
 *
 * Factory: createPosController({ service, schemas, prisma })
 *   - prisma se pasa para que el service abra transacciones — la separación
 *     pura "service no recibe prisma" se rompería aquí porque procesarVentaPOS
 *     orquesta lectura + tx + post-commit, y el repo no provee primitiva
 *     "ejecuta tx con callback". Pragmático: prisma es dep inyectada.
 */

const { z } = require('zod');
const { PosError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _applyDescriptor(res, d) {
  const status = d?.status ?? 200;
  if (d?.body == null && (status === 204 || status === 205)) return res.status(status).end();
  return res.status(status).json(d?.body ?? {});
}

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const d = await fn(req, res);
      if (!res.headersSent) _applyDescriptor(res, d);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Datos inválidos.', detail: err.errors });
      }
      if (err instanceof PosError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      console.error('[POS CTRL]', err.message, err.stack);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Error al procesar venta.' });
    }
  };
}

function createPosController({ service, schemas, prisma }) {
  if (!service)  throw new Error('createPosController: service required');
  if (!schemas)  throw new Error('createPosController: schemas required');
  if (!prisma)   throw new Error('createPosController: prisma required');
  const { posVentaSchema, facturaManualSchema, verifyPinSchema } = schemas;

  const verifyPin = _wrap(async (req) => {
    const dto     = verifyPinSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.verifyPin(dto, reqMeta, req.user);
  });

  const postVenta = _wrap(async (req) => {
    const dto     = posVentaSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.procesarVentaPOS(dto, req.user, reqMeta, { prisma });
  });

  const postFacturaManual = _wrap(async (req) => {
    const dto     = facturaManualSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.procesarFacturaManual(dto, req.user, reqMeta, { prisma });
  });

  return { verifyPin, postVenta, postFacturaManual };
}

module.exports = createPosController;
