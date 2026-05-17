/**
 * backend/modules/admin/ops/controller.js
 *
 * Capa HTTP de admin/ops. Thin handlers + Zod + _wrap.
 *
 * Factory: createOpsController({ service, schemas, helpers })
 */

const { z } = require('zod');
const { OpsError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _applyDescriptor(res, d) {
  const status = d?.status ?? 200;
  if (d?.stream) {
    res.setHeader('Content-Type', d.stream.contentType);
    if (d.stream.disposition) res.setHeader('Content-Disposition', d.stream.disposition);
    res.setHeader('Content-Length', d.stream.buffer.length);
    return res.status(status).end(d.stream.buffer);
  }
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
      if (err instanceof OpsError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      console.error('[OPS CTRL]', err.message, err.stack);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function _getClientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
       || req.socket?.remoteAddress
       || 'unknown').replace(/^::ffff:/, '');
}

function createOpsController({ service, schemas, helpers }) {
  if (!service) throw new Error('createOpsController: service required');
  if (!schemas) throw new Error('createOpsController: schemas required');
  if (!helpers) throw new Error('createOpsController: helpers required');
  const {
    incidenciaQuerySchema, resolverIncidenciaSchema, trackPinSchema, verifyHashSchema,
    auditCajaQuerySchema, auditVerifyQuerySchema, metaEndpointsQuerySchema,
  } = schemas;
  const { validUUID } = helpers;

  const getMapaNoc = _wrap(async () => service.getMapaNoc());

  const listIncidencias = _wrap(async (req) => {
    const q = incidenciaQuerySchema.parse(req.query);
    return service.listIncidencias(q);
  });

  const resolverIncidencia = _wrap(async (req) => {
    const dto = resolverIncidenciaSchema.parse(req.body);
    return service.resolverIncidencia(req.params.id, dto, req.user, _extractReqMeta(req));
  });

  const trackPin = _wrap(async (req) => {
    trackPinSchema.parse({ pin: String(req.params.pin || '').toUpperCase() });
    const ip = _getClientIp(req);
    return service.trackPin(req.params.pin, ip);
  });

  const getMetaEndpoints = _wrap(async (req) => {
    const q = metaEndpointsQuerySchema.parse(req.query);
    return service.getMetaEndpoints(q);
  });

  const resetPasswordUsuarioPortal = _wrap(async (req) =>
    service.resetPasswordUsuarioPortal(req.params.id, req.user, _extractReqMeta(req), validUUID),
  );

  const bloquearUsuarioPortal = _wrap(async (req) =>
    service.bloquearUsuarioPortal(req.params.id, req.user, _extractReqMeta(req), validUUID),
  );

  const verifyFactura = _wrap(async (req) => {
    verifyHashSchema.parse({ hash: String(req.params.hash || '').toLowerCase() });
    return service.verifyFacturaPublico(req.params.hash);
  });

  const portalFacturaPdfV2 = _wrap(async (req) =>
    service.getPortalFacturaPdfV2(req.params.id, req.portalUser),
  );

  const listAuditCaja = _wrap(async (req) => {
    const q = auditCajaQuerySchema.parse(req.query);
    return service.listAuditCaja(q);
  });

  const verifyAuditCaja = _wrap(async (req) => {
    const q = auditVerifyQuerySchema.parse(req.query);
    return service.verifyAuditCajaIntegrity(q);
  });

  const verifyAuditLog = _wrap(async (req) => {
    const q = auditVerifyQuerySchema.parse(req.query);
    return service.verifyAuditLogIntegrity(q);
  });

  return {
    getMapaNoc, listIncidencias, resolverIncidencia, trackPin,
    getMetaEndpoints, resetPasswordUsuarioPortal, bloquearUsuarioPortal,
    verifyFactura, portalFacturaPdfV2,
    listAuditCaja, verifyAuditCaja, verifyAuditLog,
  };
}

module.exports = createOpsController;
