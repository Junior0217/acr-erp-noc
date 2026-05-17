/**
 * backend/modules/crm/prospectos/router.js
 *
 * Cyber Neo silent fixes:
 *   1) GET /prospectos ahora requiere verificarJWT + crm:ver.
 *      Antes era PÚBLICO y leak de nombres, teléfonos y notas.
 *   2) Conversión usa generarSiguienteCodigo atómico (anti race).
 */

const express = require('express');
const createProspectosRepo       = require('./repo');
const createProspectosService    = require('./service');
const createProspectosController = require('./controller');
const prospectosSchemas          = require('./schema');

function createProspectosRouter(deps) {
  const { prisma, middlewares, helpers, schemas: sharedSchemas, generarSiguienteCodigo } = deps;
  if (!prisma)                                       throw new Error('createProspectosRouter: prisma required');
  if (!middlewares)                                  throw new Error('createProspectosRouter: middlewares required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createProspectosRouter: generarSiguienteCodigo required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createProspectosRepo(prisma);
  const service    = createProspectosService({
    repo,
    formatProspecto: helpers.formatProspecto,
    formatCliente:   helpers.formatCliente,
    generarSiguienteCodigo,
  });
  const controller = createProspectosController({ service, schemas: prospectosSchemas, sharedSchemas, helpers, prisma });

  const router = express.Router();

  router.get('/prospectos',                 verificarJWT, requerirPermiso('crm:ver'),    controller.list);
  router.post('/prospectos',                verificarJWT, requerirPermiso('crm:editar'), controller.create);
  router.put('/prospectos/:id',             verificarJWT, requerirPermiso('crm:editar'), controller.update);
  router.delete('/prospectos/:id',          verificarJWT, requerirPermiso('crm:borrar'), controller.remove);
  router.patch('/prospectos/:id/convertir', verificarJWT, requerirPermiso('crm:editar'), controller.convert);

  return router;
}

module.exports = createProspectosRouter;
