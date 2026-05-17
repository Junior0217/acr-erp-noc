/**
 * backend/modules/admin/roles/router.js
 *
 * Cyber Neo: cambios destructivos (DELETE rol, kill-sessions) ahora
 * exigen requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO) + requerirTOTPEstricto
 * (cuando esté disponible).
 */

const express = require('express');
const createRolesRepo       = require('./repo');
const createRolesService    = require('./service');
const createRolesController = require('./controller');
const rolesSchemas          = require('./schema');

function createRolesRouter(deps) {
  const {
    prisma, auditReq, middlewares, schemas: sharedSchemas,
    NIVEL_PROPIETARIO_ABSOLUTO, protegerPropietario,
  } = deps;
  if (!prisma)                                        throw new Error('createRolesRouter: prisma required');
  if (!middlewares)                                   throw new Error('createRolesRouter: middlewares required');
  if (typeof auditReq !== 'function')                 throw new Error('createRolesRouter: auditReq required');
  if (typeof NIVEL_PROPIETARIO_ABSOLUTO !== 'number') throw new Error('createRolesRouter: NIVEL_PROPIETARIO_ABSOLUTO required');

  const {
    verificarJWT, requerirPermiso, requerirNivel,
    requerirTOTP, requerirTOTPEstricto,
  } = middlewares;
  const _propietarioAbsoluto = requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO);
  const _protPropietario = protegerPropietario || ((req, res, next) => next());
  const _totpStrict = requerirTOTPEstricto || requerirTOTP || ((req, res, next) => next());

  const repo       = createRolesRepo(prisma);
  const service    = createRolesService({ repo, auditReq });
  const controller = createRolesController({ service, schemas: rolesSchemas, sharedSchemas });

  const router = express.Router();

  // ── Roles CRUD ──────────────────────────────────────────────────
  router.get(   '/roles',     verificarJWT,                                                              controller.list);
  router.post(  '/roles',     verificarJWT, requerirPermiso('sistema:admin'),                            controller.create);
  router.put(   '/roles/:id', verificarJWT, requerirPermiso('sistema:admin'),                            controller.update);
  // SILENT FIX: DELETE de rol exige NIVEL_PROPIETARIO_ABSOLUTO + TOTP.
  router.delete('/roles/:id', verificarJWT, requerirPermiso('sistema:admin'),
                              _propietarioAbsoluto, _totpStrict,                                         controller.remove);

  // ── Admin empleados (password / bloquear / kill sessions) ───────
  router.patch( '/admin/empleados/:id/password', verificarJWT, requerirPermiso('sistema:admin'),
                                                 _protPropietario,                                       controller.changePassword);
  router.patch( '/admin/empleados/:id/bloquear', verificarJWT, requerirPermiso('sistema:admin'),
                                                 _protPropietario,                                       controller.block);
  // SILENT FIX: kill-sessions exige NIVEL_PROPIETARIO_ABSOLUTO (destructiva).
  router.delete('/admin/sessions/:empleadoId',   verificarJWT, requerirPermiso('sistema:admin'),
                                                 _protPropietario, _propietarioAbsoluto,                 controller.killSessions);

  return router;
}

module.exports = createRolesRouter;
