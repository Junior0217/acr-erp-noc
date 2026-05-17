/**
 * backend/modules/crm/suplidores/router.js
 *
 * Cyber Neo silent fix: GET /suplidores ahora requiere verificarJWT +
 * requerirPermiso('crm:ver'). Antes era PÚBLICO y filtraba razón social,
 * RNC, contacto y datos de proveedores.
 */

const express = require('express');
const createSuplidoresRepo       = require('./repo');
const createSuplidoresService    = require('./service');
const createSuplidoresController = require('./controller');
const suplidoresSchemas          = require('./schema');

function createSuplidoresRouter(deps) {
  const { prisma, middlewares, helpers, schemas: sharedSchemas } = deps;
  if (!prisma)      throw new Error('createSuplidoresRouter: prisma required');
  if (!middlewares) throw new Error('createSuplidoresRouter: middlewares required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createSuplidoresRepo(prisma);
  const service    = createSuplidoresService({ repo, formatSuplidor: helpers.formatSuplidor });
  const controller = createSuplidoresController({ service, schemas: suplidoresSchemas, sharedSchemas, helpers });

  const router = express.Router();

  // SILENT FIX: GET ahora exige verificarJWT + crm:ver.
  router.get('/suplidores',              verificarJWT, requerirPermiso('crm:ver'),    controller.list);
  router.post('/suplidores',             verificarJWT, requerirPermiso('crm:editar'), controller.create);
  router.put('/suplidores/:id',          verificarJWT, requerirPermiso('crm:editar'), controller.update);
  router.patch('/suplidores/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), controller.toggle);

  return router;
}

module.exports = createSuplidoresRouter;
