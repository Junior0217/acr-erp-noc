/**
 * backend/modules/admin/rrhh/router.js
 *
 * Cyber Neo silent fixes:
 *   1) Acciones destructivas (DELETE, offboard) ahora exigen
 *      requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO) + requerirTOTPEstricto.
 *   2) Cambios de permisos (roles, permisos-extra) ahora exigen
 *      requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO).
 *   3) repo.js usa SELECT explícito — passwordHash NUNCA sale al frontend.
 *   4) POST empleados / PUT empleados validan subset-perms + nivel guard.
 */

const express = require('express');
const createRrhhRepo       = require('./repo');
const createRrhhService    = require('./service');
const createRrhhController = require('./controller');
const rrhhSchemas          = require('./schema');

function createRrhhRouter(deps) {
  const {
    prisma, auditReq, middlewares, schemas: sharedSchemas,
    NIVEL_PROPIETARIO_ABSOLUTO, protegerPropietario,
  } = deps;
  if (!prisma)                                       throw new Error('createRrhhRouter: prisma required');
  if (!middlewares)                                  throw new Error('createRrhhRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createRrhhRouter: auditReq required');
  if (typeof NIVEL_PROPIETARIO_ABSOLUTO !== 'number') throw new Error('createRrhhRouter: NIVEL_PROPIETARIO_ABSOLUTO required');

  const {
    verificarJWT, requerirPermiso, requerirNivel,
    requerirTOTP, requerirTOTPEstricto,
  } = middlewares;
  const _propietarioAbsoluto = requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO);
  const _protPropietario = protegerPropietario || ((req, res, next) => next());

  const repo       = createRrhhRepo(prisma);
  const service    = createRrhhService({ repo, auditReq, prisma });
  const controller = createRrhhController({ service, schemas: rrhhSchemas, sharedSchemas });

  const router = express.Router();

  // ── Empleados CRUD ───────────────────────────────────────────────
  router.post(  '/empleados',     verificarJWT, requerirPermiso('rrhh:editar'),                       controller.createEmpleado);
  router.get(   '/empleados',     verificarJWT,                                                       controller.listEmpleados);
  router.put(   '/empleados/:id', verificarJWT, requerirPermiso('rrhh:editar'), _protPropietario,     controller.updateEmpleado);

  // SILENT FIX: DELETE exige NIVEL_PROPIETARIO_ABSOLUTO + TOTP estricto.
  router.delete('/empleados/:id', verificarJWT, _protPropietario, _propietarioAbsoluto,
                                  requerirTOTPEstricto || requerirTOTP,                                controller.deleteEmpleado);

  // ── Asistencia ──────────────────────────────────────────────────
  router.get( '/asistencia', verificarJWT, controller.listAsistencia);
  router.post('/asistencia', verificarJWT, controller.createAsistencia);

  // ── Admin: permisos / sesiones ──────────────────────────────────
  router.get(  '/admin/empleados',                    verificarJWT, requerirPermiso('sistema:admin'),   controller.adminListEmpleados);

  // SILENT FIX: cambios de roles + permisos extra exigen NIVEL_PROPIETARIO_ABSOLUTO.
  router.patch('/admin/empleados/:id/roles',          verificarJWT, requerirPermiso('sistema:admin'),
                                                      _protPropietario, _propietarioAbsoluto,
                                                      controller.adminUpdateRoles);
  router.patch('/admin/empleados/:id/permisos-extra', verificarJWT, requerirPermiso('sistema:admin'),
                                                      _protPropietario, _propietarioAbsoluto,
                                                      controller.adminUpdatePermisosExtra);

  // ── Offboarding (destructivo: bloquea + revoca sesiones + libera OTs) ──
  // SILENT FIX: además de sistema:owner, exige NIVEL_PROPIETARIO_ABSOLUTO + TOTP estricto.
  router.post('/empleados/:id/offboard', verificarJWT, requerirPermiso('sistema:owner'),
                                          _propietarioAbsoluto,
                                          requerirTOTPEstricto || requerirTOTP,
                                          controller.offboard);

  return router;
}

module.exports = createRrhhRouter;
