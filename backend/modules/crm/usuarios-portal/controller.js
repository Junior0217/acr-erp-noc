/**
 * backend/modules/crm/usuarios-portal/controller.js
 */

const { z } = require('zod');
const { UsuarioPortalError } = require('./service');

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
      if (err instanceof z.ZodError)         return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof UsuarioPortalError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[USUARIOS PORTAL CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createUsuariosPortalController({ service, schemas, helpers }) {
  if (!service || !schemas || !helpers) throw new Error('createUsuariosPortalController: deps required');
  const { listUsuariosPortalQuerySchema, vincularUsuarioSchema } = schemas;
  const { validUUID } = helpers;

  const list = _wrap(async (req) => service.listarUsuarios(listUsuariosPortalQuerySchema.parse(req.query)));

  const vincular = _wrap(async (req, res) => {
    if (!validUUID(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }
    const { clienteId } = vincularUsuarioSchema.parse(req.body ?? {});
    return service.vincularUsuario(req.params.id, clienteId, req.user, _extractReqMeta(req));
  });

  return { list, vincular };
}

module.exports = createUsuariosPortalController;
