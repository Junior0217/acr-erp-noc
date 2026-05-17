/**
 * backend/modules/ventas/taller/router.js
 */

const express = require('express');
const createTallerRepo       = require('./repo');
const createTallerService    = require('./service');
const createTallerController = require('./controller');
const tallerSchemas          = require('./schema');

function createTallerRouter(deps) {
  const { prisma, auditReq, middlewares, helpers, generarSiguienteCodigo } = deps;
  if (!prisma)                                       throw new Error('createTallerRouter: prisma required');
  if (!middlewares)                                  throw new Error('createTallerRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createTallerRouter: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createTallerRouter: generarSiguienteCodigo required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createTallerRepo(prisma);
  const service    = createTallerService({ repo, auditReq, generarSiguienteCodigo, prisma });
  const controller = createTallerController({ service, schemas: tallerSchemas, helpers });

  const router = express.Router();

  router.get('/taller',                  verificarJWT, requerirPermiso('ot:ver'),       controller.list);
  router.post('/taller',                 verificarJWT, requerirPermiso('ot:crear'),     controller.create);
  router.patch('/taller/:id/estado',     verificarJWT, requerirPermiso('ot:editar'),    controller.updateEstado);
  router.patch('/taller/:id',            verificarJWT, requerirPermiso('ot:editar'),    controller.update);
  router.patch('/taller/:id/reabrir',    verificarJWT, requerirPermiso('sistema:owner'), controller.reabrir);

  return router;
}

module.exports = createTallerRouter;
