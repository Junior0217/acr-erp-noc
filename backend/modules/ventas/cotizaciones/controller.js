/**
 * backend/modules/ventas/cotizaciones/controller.js
 *
 * Capa HTTP. Thin handlers + Zod + _wrap centralizado.
 *
 * Factory: createCotizacionesController({ service, schemas, helpers })
 */

const { z } = require('zod');
const { CotError } = require('./service');

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
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof CotError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      console.error('[COT CTRL]', err.message, err.stack);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Error interno.' });
    }
  };
}

function createCotizacionesController({ service, schemas, helpers }) {
  if (!service) throw new Error('createCotizacionesController: service required');
  if (!schemas) throw new Error('createCotizacionesController: schemas required');
  if (!helpers) throw new Error('createCotizacionesController: helpers required');
  const {
    listCotizacionesQuerySchema, revivirSchema,
    listFacturasQuerySchema, cambiarEstadoFacturaSchema, cambiarEtapaCotizacionSchema,
  } = schemas;
  const { validUUID } = helpers;

  function _assertUUID(id) {
    if (!validUUID(id)) throw new CotError(400, 'BAD_ID', 'ID inválido.');
  }

  const listCotizaciones = _wrap(async (req) => {
    const q = listCotizacionesQuerySchema.parse(req.query);
    return service.listarCotizaciones(q);
  });

  const postRevivir = _wrap(async (req) => {
    _assertUUID(req.params.id);
    const dto     = revivirSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.revivirCotizacion(req.params.id, dto, req.user, reqMeta);
  });

  const getFactura = _wrap(async (req) => {
    _assertUUID(req.params.id);
    return service.getFacturaById(req.params.id);
  });

  const listFacturas = _wrap(async (req) => {
    const q = listFacturasQuerySchema.parse(req.query);
    return service.listarFacturas(q);
  });

  const patchEstadoFactura = _wrap(async (req) => {
    _assertUUID(req.params.id);
    const dto     = cambiarEstadoFacturaSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.cambiarEstadoFactura(req.params.id, dto, req.user, reqMeta);
  });

  const patchEtapaCotizacion = _wrap(async (req) => {
    _assertUUID(req.params.id);
    const dto     = cambiarEtapaCotizacionSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.cambiarEtapaCotizacion(req.params.id, dto, req.user, reqMeta);
  });

  return { listCotizaciones, postRevivir, getFactura, listFacturas, patchEstadoFactura, patchEtapaCotizacion };
}

module.exports = createCotizacionesController;
