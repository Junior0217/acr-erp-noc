/**
 * backend/modules/admin/preferencias-pos/router.js
 *
 * Rutas HTTP:
 *   GET  /preferencias-pos    obtiene las preferencias visuales del empleado autenticado
 *   PUT  /preferencias-pos    actualiza (upsert) las preferencias visuales
 *
 * Sin permiso adicional — solo verificarJWT. Cada empleado solo lee/escribe
 * sus propias preferencias (empleadoId derivado de req.user.id).
 */

const express = require('express');

const createPreferenciasPosRepo       = require('./repo');
const createPreferenciasPosService    = require('./service');
const createPreferenciasPosController = require('./controller');
const schemas                         = require('./schema');

function createPreferenciasPosRouter(deps) {
  const { prisma, middlewares, auditReq } = deps;
  if (!prisma)                        throw new Error('createPreferenciasPosRouter: prisma required');
  if (!middlewares)                   throw new Error('createPreferenciasPosRouter: middlewares required');
  if (typeof auditReq !== 'function') throw new Error('createPreferenciasPosRouter: auditReq required');

  const { verificarJWT } = middlewares;

  const repo       = createPreferenciasPosRepo(prisma);
  const service    = createPreferenciasPosService({ repo, auditReq });
  const controller = createPreferenciasPosController({ service, schemas });

  const router = express.Router();

  router.get('/preferencias-pos', verificarJWT, controller.obtenerMias);
  router.put('/preferencias-pos', verificarJWT, controller.actualizarMias);

  return router;
}

module.exports = createPreferenciasPosRouter;
