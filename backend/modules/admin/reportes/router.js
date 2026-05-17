/**
 * backend/modules/admin/reportes/router.js
 */

const express = require('express');
const createReportesRepo       = require('./repo');
const createReportesService    = require('./service');
const createReportesController = require('./controller');
const reportesSchemas          = require('./schema');

function createReportesRouter(deps) {
  const { prisma, middlewares } = deps;
  if (!prisma)      throw new Error('createReportesRouter: prisma required');
  if (!middlewares) throw new Error('createReportesRouter: middlewares required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createReportesRepo(prisma);
  const service    = createReportesService({ repo });
  const controller = createReportesController({ service, schemas: reportesSchemas });

  const router = express.Router();

  router.get('/dashboard',            verificarJWT,                                       controller.dashboard);
  router.get('/reportes/semanal',     verificarJWT, requerirPermiso('sistema:owner'),    controller.semanal);
  router.get('/reportes/comisiones',  verificarJWT, requerirPermiso('sistema:owner'),    controller.comisiones);

  return router;
}

module.exports = createReportesRouter;
