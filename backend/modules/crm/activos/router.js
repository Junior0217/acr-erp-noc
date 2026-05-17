/**
 * backend/modules/crm/activos/router.js
 *
 * CMDB (ActivoCliente) + Timeline routes. Todas protegidas con
 * verificarJWT + crm:ver/editar (no había leak previo).
 */

const express = require('express');
const createActivosRepo       = require('./repo');
const createActivosService    = require('./service');
const createActivosController = require('./controller');
const activosSchemas          = require('./schema');

function createActivosRouter(deps) {
  const { prisma, middlewares, auditReq, helpers } = deps;
  if (!prisma)                            throw new Error('createActivosRouter: prisma required');
  if (!middlewares)                       throw new Error('createActivosRouter: middlewares required');
  if (typeof auditReq !== 'function')     throw new Error('createActivosRouter: auditReq required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createActivosRepo(prisma);
  const service    = createActivosService({ repo, auditReq });
  const controller = createActivosController({ service, schemas: activosSchemas, helpers });

  const router = express.Router();

  router.get('/activos-cliente',                verificarJWT, requerirPermiso('crm:ver'),    controller.list);
  router.post('/activos-cliente',               verificarJWT, requerirPermiso('crm:editar'), controller.create);
  router.delete('/activos-cliente/:id',         verificarJWT, requerirPermiso('crm:editar'), controller.remove);
  router.get('/activos-cliente/:id/timeline',   verificarJWT, requerirPermiso('crm:ver'),    controller.timeline);
  router.post('/activos-cliente/:id/timeline',  verificarJWT, requerirPermiso('crm:editar'), controller.createTimeline);

  return router;
}

module.exports = createActivosRouter;
