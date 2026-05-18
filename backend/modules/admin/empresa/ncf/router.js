/**
 * backend/modules/admin/empresa/ncf/router.js
 *
 * Sub-router NCF dentro del dominio "Mi Empresa" (admin). Antes vivía en
 * ventas/ncf/ (error conceptual): la configuración de secuencias NCF es
 * dato de configuración de la EMPRESA, no operativo de ventas.
 *
 * Rutas:
 *   GET  /ncf-config  — lectura (factura:ver, owner)
 *   POST /ncf-config  — upsert (sistema:admin solamente)
 *
 * Factory: createNcfAdminRouter(deps) -> express.Router
 *
 * Requiere deps.ncfService (instanciado en server.js via
 * shared/services/ncf.service.js). El acceso directo a prisma.configuracionNCF
 * está PROHIBIDO desde acá — todo pasa por el shared service.
 */

const express = require('express');
const createNcfRepo       = require('./repo');
const createNcfAdminService = require('./service');
const createNcfAdminCtrl  = require('./controller');
const ncfSchemas          = require('./schema');

function createNcfAdminRouter(deps) {
  const { middlewares, auditReq, ncfService } = deps;
  if (!middlewares)                       throw new Error('createNcfAdminRouter: middlewares required');
  if (typeof auditReq !== 'function')     throw new Error('createNcfAdminRouter: auditReq required');
  if (!ncfService)                        throw new Error('createNcfAdminRouter: ncfService required (shared/services/ncf.service)');

  const { verificarJWT, requerirPermiso } = middlewares;
  const repo       = createNcfRepo({ ncfService });
  const service    = createNcfAdminService({ repo, auditReq });
  const controller = createNcfAdminCtrl({ service, schemas: ncfSchemas });

  const router = express.Router();
  router.get('/ncf-config',             verificarJWT, requerirPermiso('factura:ver'),    controller.listar);
  router.post('/ncf-config',            verificarJWT, requerirPermiso('sistema:admin'), controller.upsert);
  // Consolidación: cleanup destructivo (deletes rows). sistema:owner only.
  router.post('/ncf-config/consolidar', verificarJWT, requerirPermiso('sistema:owner'), controller.consolidar);
  return router;
}

module.exports = createNcfAdminRouter;
