/**
 * backend/modules/servicios/ordenes/router.js
 *
 * Rutas HTTP del módulo Órdenes de Servicio Técnico. CERO lógica.
 * Aplica verificarJWT + requerirPermiso('servicios:gestionar') a todas.
 *
 * Endpoints expuestos (prefijo del padre: /api/servicios/ordenes):
 *   GET    /servicios/ordenes                   listar paginado
 *   GET    /servicios/ordenes/:id               detalle
 *   POST   /servicios/ordenes                   crear (estado inicial)
 *   PATCH  /servicios/ordenes/:id               editar campos (no terminal)
 *   PATCH  /servicios/ordenes/:id/estado        transicionar estado (state machine)
 *   POST   /servicios/ordenes/:id/facturar      cierre + factura POS (NCF B01/B02)
 *   GET    /servicios/ordenes/:id/conduce.pdf   conduce/recibo técnico PDF
 */

const express = require('express');

const createServiciosOrdenesRepo       = require('./repo');
const createServiciosOrdenesService    = require('./service');
const createServiciosOrdenesController = require('./controller');
const schemas                          = require('./schema');

function createServiciosOrdenesRouter(deps) {
  const { prisma, middlewares, auditReq } = deps;
  if (!prisma)                        throw new Error('createServiciosOrdenesRouter: prisma required');
  if (!middlewares)                   throw new Error('createServiciosOrdenesRouter: middlewares required');
  if (typeof auditReq !== 'function') throw new Error('createServiciosOrdenesRouter: auditReq required');

  const { verificarJWT, requerirPermiso } = middlewares;

  // procesarVentaPOS se inyecta vía deps cuando server.js lo expone en
  // _routerDeps. Si no está presente, el endpoint /facturar devolverá 503
  // — el resto del flujo (recepción, diagnóstico, conduce) sigue operando.
  const procesarVentaPOS = deps.procesarVentaPOS || null;

  const repo       = createServiciosOrdenesRepo(prisma);
  const service    = createServiciosOrdenesService({ repo, auditReq, procesarVentaPOS });
  const controller = createServiciosOrdenesController({ service, schemas });

  const router = express.Router();
  const permiso = requerirPermiso('servicios:gestionar');

  router.get   ('/servicios/ordenes',                   verificarJWT, permiso, controller.listar);
  router.post  ('/servicios/ordenes',                   verificarJWT, permiso, controller.crear);
  router.get   ('/servicios/ordenes/:id',               verificarJWT, permiso, controller.obtener);
  router.patch ('/servicios/ordenes/:id',               verificarJWT, permiso, controller.actualizar);
  router.patch ('/servicios/ordenes/:id/estado',        verificarJWT, permiso, controller.cambiarEstado);
  router.post  ('/servicios/ordenes/:id/facturar',      verificarJWT, permiso, controller.facturar);
  router.get   ('/servicios/ordenes/:id/conduce.pdf',   verificarJWT, permiso, controller.conducePdf);

  return router;
}

module.exports = createServiciosOrdenesRouter;
