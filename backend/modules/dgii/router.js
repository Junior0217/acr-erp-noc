/**
 * backend/modules/dgii/router.js
 *
 * F1 — CRUD Compras (feed del reporte 606).
 * F2/F3 (próximas) añadirán: /606/preview, /606/download, /607/preview, /607/download.
 *
 * Cyber Neo:
 *   - Todas las rutas exigen verificarJWT + dgii:reportar.
 *   - DELETE exige NIVEL_PROPIETARIO_ABSOLUTO + TOTP estricto (Norma DGII —
 *     borrar compras altera el 606 declarado y debe quedar trail inmutable).
 */

const express = require('express');
const createDgiiRepo       = require('./repo');
const createDgiiService    = require('./service');
const createDgiiController = require('./controller');
const dgiiSchemas          = require('./schema');

function createDgiiRouter(deps) {
  const {
    prisma, auditReq, middlewares, helpers,
    generarSiguienteCodigo, NIVEL_PROPIETARIO_ABSOLUTO,
  } = deps;
  if (!prisma)                                        throw new Error('createDgiiRouter: prisma required');
  if (!middlewares)                                   throw new Error('createDgiiRouter: middlewares required');
  if (typeof auditReq !== 'function')                 throw new Error('createDgiiRouter: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createDgiiRouter: generarSiguienteCodigo required');
  if (typeof NIVEL_PROPIETARIO_ABSOLUTO !== 'number') throw new Error('createDgiiRouter: NIVEL_PROPIETARIO_ABSOLUTO required');

  const {
    verificarJWT, requerirPermiso, requerirNivel,
    requerirTOTP, requerirTOTPEstricto,
  } = middlewares;
  const _propietarioAbsoluto = requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO);
  const _totpStrict = requerirTOTPEstricto || requerirTOTP || ((req, res, next) => next());

  const repo       = createDgiiRepo(prisma);
  const service    = createDgiiService({ repo, prisma, auditReq, generarSiguienteCodigo, helpers });
  const controller = createDgiiController({ service, schemas: dgiiSchemas, helpers });

  const router = express.Router();

  // ── Compras CRUD (F1) ─────────────────────────────────────────────────
  router.get(   '/dgii/compras',     verificarJWT, requerirPermiso('dgii:reportar'),                                          controller.listCompras);
  router.get(   '/dgii/compras/:id', verificarJWT, requerirPermiso('dgii:reportar'),                                          controller.getCompra);
  router.post(  '/dgii/compras',     verificarJWT, requerirPermiso('dgii:reportar'),                                          controller.createCompra);
  router.put(   '/dgii/compras/:id', verificarJWT, requerirPermiso('dgii:reportar'),                                          controller.updateCompra);
  router.delete('/dgii/compras/:id', verificarJWT, requerirPermiso('dgii:reportar'), _propietarioAbsoluto, _totpStrict,        controller.deleteCompra);

  // ── Historial reportes (vista) ────────────────────────────────────────
  router.get(   '/dgii/historial',   verificarJWT, requerirPermiso('dgii:reportar'),                                          controller.listHistorial);

  return router;
}

module.exports = createDgiiRouter;
