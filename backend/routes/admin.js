/**
 * backend/routes/admin.js
 *
 * Admin router: empleados, asistencia, roles, configuración (empresa,
 * secuencias, NCF), reportes (semanal, comisiones), dashboard, auditoría,
 * incidencias de reconciliación, _meta/endpoints.
 */

const express = require('express');

function createAdminRouter(deps) {
  const router = express.Router();
  // const { prisma, middlewares, schemas, auditReq } = deps;
  // const { verificarJWT, requerirPermiso, requerirNivel, protegerPropietario, requerirTOTP } = middlewares;
  // const { empleadoSchema, empleadoUpdateSchema, asistenciaSchema } = schemas;

  router.get('/_meta/admin-router', (req, res) => res.json({ ok: true, router: 'admin', migrated: 0 }));

  return router;
}

module.exports = createAdminRouter;
