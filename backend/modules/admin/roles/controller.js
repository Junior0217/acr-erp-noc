/**
 * backend/modules/admin/roles/controller.js
 */

const { z } = require('zod');
const { RolesError } = require('./service');

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
      if (err instanceof RolesError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[ROLES CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function _intIdParam(req, res, key = 'id') {
  const id = parseInt(req.params[key], 10);
  if (!id || id < 1) {
    res.status(400).json({ error: 'ID inválido.' });
    return null;
  }
  return id;
}

function createRolesController({ service, schemas, sharedSchemas }) {
  if (!service || !schemas || !sharedSchemas) throw new Error('createRolesController: deps required');
  const { rolSchema, rolUpdateSchema, bloquearSchema } = schemas;
  const { passwordSchema } = sharedSchemas;
  const passwordBodySchema = z.object({ password: passwordSchema });

  const list = _wrap(async () => service.listarRoles());

  const create = _wrap(async (req) => {
    const data = rolSchema.parse(req.body);
    return service.crearRol(data, req.user, _extractReqMeta(req));
  });

  const update = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    const data = rolUpdateSchema.parse(req.body);
    return service.actualizarRol(id, data, req.user, _extractReqMeta(req));
  });

  const remove = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    return service.eliminarRol(id, req.user, _extractReqMeta(req));
  });

  const changePassword = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    const { password } = passwordBodySchema.parse(req.body);
    return service.cambiarPassword(id, password, req.user, _extractReqMeta(req));
  });

  const block = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    const { bloqueado } = bloquearSchema.parse(req.body);
    return service.bloquearEmpleado(id, bloqueado, req.user, _extractReqMeta(req));
  });

  const killSessions = _wrap(async (req, res) => {
    const id = _intIdParam(req, res, 'empleadoId'); if (id === null) return;
    return service.matarSesiones(id, req.user, _extractReqMeta(req));
  });

  return { list, create, update, remove, changePassword, block, killSessions };
}

module.exports = createRolesController;
