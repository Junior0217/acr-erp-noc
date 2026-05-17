/**
 * backend/modules/admin/empresa/ncf/controller.js
 *
 * Capa HTTP del sub-módulo NCF admin. Thin handlers. Cero lógica.
 *
 * Factory: createNcfAdminController({ service, schemas })
 */

const { z } = require('zod');
const { NcfAdminError } = require('./service');

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
      if (err instanceof NcfAdminError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[NCF ADMIN CTRL]', err.message, err.stack);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createNcfAdminController({ service, schemas }) {
  if (!service) throw new Error('createNcfAdminController: service required');
  if (!schemas) throw new Error('createNcfAdminController: schemas required');
  const { ncfConfigSchema } = schemas;

  const listar = _wrap(async () => service.listarConfiguraciones());

  const upsert = _wrap(async (req) => {
    const data    = ncfConfigSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.upsertConfiguracion(data, req.user, reqMeta);
  });

  return { listar, upsert };
}

module.exports = createNcfAdminController;
