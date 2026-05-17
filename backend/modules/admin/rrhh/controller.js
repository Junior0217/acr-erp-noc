/**
 * backend/modules/admin/rrhh/controller.js
 */

const { z } = require('zod');
const { RrhhError } = require('./service');

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
      if (err instanceof RrhhError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[RRHH CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function _intIdParam(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) {
    res.status(400).json({ error: 'ID inválido.' });
    return null;
  }
  return id;
}

function createRrhhController({ service, schemas, sharedSchemas }) {
  if (!service || !schemas || !sharedSchemas) throw new Error('createRrhhController: deps required');
  const { listEmpleadosQuerySchema, listAsistenciaQuerySchema, rolesUpdateSchema, permisosExtraSchema } = schemas;
  const { empleadoSchema, empleadoUpdateSchema, asistenciaSchema } = sharedSchemas;

  const createEmpleado = _wrap(async (req) => {
    const data = empleadoSchema.parse(req.body);
    return service.crearEmpleado(data, req.user, _extractReqMeta(req));
  });

  const listEmpleados = _wrap(async (req) =>
    service.listarEmpleados(listEmpleadosQuerySchema.parse(req.query))
  );

  const updateEmpleado = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    const data = empleadoUpdateSchema.parse(req.body);
    return service.actualizarEmpleado(id, data, req.user);
  });

  const deleteEmpleado = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    return service.eliminarEmpleado(id);
  });

  const listAsistencia = _wrap(async (req) =>
    service.listarAsistencia(req.user, listAsistenciaQuerySchema.parse(req.query))
  );

  const createAsistencia = _wrap(async (req) => {
    const data = asistenciaSchema.parse(req.body);
    return service.registrarAsistencia(req.user, data);
  });

  const adminListEmpleados = _wrap(async () => service.listarEmpleadosAdmin());

  const adminUpdateRoles = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    const { roleIds } = rolesUpdateSchema.parse(req.body);
    return service.actualizarRoles(id, roleIds, req.user, _extractReqMeta(req));
  });

  const adminUpdatePermisosExtra = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    const { permisosExtra } = permisosExtraSchema.parse(req.body);
    return service.actualizarPermisosExtra(id, permisosExtra, req.user, _extractReqMeta(req));
  });

  const offboard = _wrap(async (req, res) => {
    const id = _intIdParam(req, res); if (id === null) return;
    return service.offboard(id, req.user, _extractReqMeta(req));
  });

  return {
    createEmpleado, listEmpleados, updateEmpleado, deleteEmpleado,
    listAsistencia, createAsistencia,
    adminListEmpleados, adminUpdateRoles, adminUpdatePermisosExtra,
    offboard,
  };
}

module.exports = createRrhhController;
