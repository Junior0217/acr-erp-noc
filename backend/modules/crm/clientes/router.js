/**
 * backend/modules/crm/clientes/router.js
 *
 * Cyber Neo silent fix: GET /clientes AHORA requiere verificarJWT +
 * requerirPermiso('crm:ver'). Antes era PÚBLICO y filtraba razón social,
 * RNC, contacto, dirección, teléfonos, email — PII masivo accesible sin
 * auth. Corregido silenciosamente.
 */

const express = require('express');
const createClientesRepo       = require('./repo');
const createClientesService    = require('./service');
const createClientesController = require('./controller');
const clientesSchemas          = require('./schema');

function createClientesRouter(deps) {
  const { prisma, middlewares, auditReq, helpers, schemas: sharedSchemas, generarSiguienteCodigo } = deps;
  if (!prisma)                                       throw new Error('createClientesRouter: prisma required');
  if (!middlewares)                                  throw new Error('createClientesRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createClientesRouter: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createClientesRouter: generarSiguienteCodigo required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createClientesRepo(prisma);
  const service    = createClientesService({
    repo, auditReq, generarSiguienteCodigo,
    formatCliente: helpers.formatCliente,
    validUUID:     helpers.validUUID,
  });
  const controller = createClientesController({ service, schemas: clientesSchemas, sharedSchemas, helpers, prisma });

  const router = express.Router();

  // SILENT FIX: GET ahora exige verificarJWT + crm:ver (antes era público).
  router.get('/clientes',              verificarJWT, requerirPermiso('crm:ver'),    controller.list);
  router.post('/clientes',             verificarJWT, requerirPermiso('crm:editar'), controller.create);
  router.put('/clientes/:id',          verificarJWT, requerirPermiso('crm:editar'), controller.update);
  router.delete('/clientes/:id',       verificarJWT, requerirPermiso('crm:borrar'), controller.remove);
  router.patch('/clientes/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), controller.toggle);

  return router;
}

module.exports = createClientesRouter;
