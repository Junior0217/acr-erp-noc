/**
 * backend/modules/crm/usuarios-portal/router.js
 *
 * Cyber Neo silent fix: body de POST /:id/vincular pasa por Zod
 * (vincularUsuarioSchema). Antes se extraía clienteId crudo del body sin
 * validación de schema — riesgo de prototype pollution + tipos confusos.
 */

const express = require('express');
const createUsuariosPortalRepo       = require('./repo');
const createUsuariosPortalService    = require('./service');
const createUsuariosPortalController = require('./controller');
const usuariosPortalSchemas          = require('./schema');

function createUsuariosPortalRouter(deps) {
  const { prisma, middlewares, auditReq, helpers } = deps;
  if (!prisma)                            throw new Error('createUsuariosPortalRouter: prisma required');
  if (!middlewares)                       throw new Error('createUsuariosPortalRouter: middlewares required');
  if (typeof auditReq !== 'function')     throw new Error('createUsuariosPortalRouter: auditReq required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createUsuariosPortalRepo(prisma);
  const service    = createUsuariosPortalService({ repo, auditReq });
  const controller = createUsuariosPortalController({ service, schemas: usuariosPortalSchemas, helpers });

  const router = express.Router();

  router.get('/usuarios-portal',               verificarJWT, requerirPermiso('crm:ver'),    controller.list);
  router.post('/usuarios-portal/:id/vincular', verificarJWT, requerirPermiso('crm:editar'), controller.vincular);

  return router;
}

module.exports = createUsuariosPortalRouter;
