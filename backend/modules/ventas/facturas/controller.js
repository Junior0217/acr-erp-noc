/**
 * backend/modules/ventas/facturas/controller.js
 *
 * Capa HTTP del módulo Facturas. Thin handlers + Zod validation + error
 * mapping centralizado. CERO Prisma, CERO lógica fiscal.
 *
 * Factory: createFacturasController({ service, schemas, prisma, helpers })
 */

const { z } = require('zod');
const { FacturaError } = require('./service');

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
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof FacturaError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      // NcfError (importado dinámicamente vía ncfService.nextNcfSequence)
      if (err?.status && err?.code && /^NCF_/.test(err.code)) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[FACTURAS CTRL]', err.message, err.stack);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Error interno.' });
    }
  };
}

function createFacturasController({ service, schemas, prisma, helpers }) {
  if (!service) throw new Error('createFacturasController: service required');
  if (!schemas) throw new Error('createFacturasController: schemas required');
  if (!prisma)  throw new Error('createFacturasController: prisma required');
  if (!helpers) throw new Error('createFacturasController: helpers required');

  const { emitirFacturaSchema, revertirSchema, notaCreditoSchema, notaDebitoSchema, condicionesSchema } = schemas;
  const { validUUID } = helpers;

  function _assertValidUUID(id) {
    if (!validUUID(id)) throw new FacturaError(400, 'BAD_ID', 'ID inválido.');
  }

  const postFactura = _wrap(async (req) => {
    const dto     = emitirFacturaSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.emitirFacturaDesdeOT(dto, req.user, reqMeta, { prisma });
  });

  const postRevertir = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto     = revertirSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.revertirFactura(req.params.id, dto, req.user, reqMeta, { prisma });
  });

  const postNotaCredito = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto     = notaCreditoSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.emitirNotaCredito(req.params.id, dto, req.user, reqMeta, { prisma });
  });

  const postNotaDebito = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto     = notaDebitoSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.emitirNotaDebito(req.params.id, dto, req.user, reqMeta, { prisma });
  });

  const patchCondiciones = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto     = condicionesSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.patchCondiciones(req.params.id, dto, req.user, reqMeta);
  });

  return {
    postFactura,
    postRevertir,
    postNotaCredito,
    postNotaDebito,
    patchCondiciones,
  };
}

module.exports = createFacturasController;
