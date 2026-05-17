/**
 * backend/modules/ventas/catalogo/router.js
 *
 * Rutas HTTP del módulo Catálogo. CERO lógica.
 *
 * catalogoPublicoLimiter LOCAL (60/min) protege el catálogo público de scraping.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const createCatalogoRepo       = require('./repo');
const createCatalogoService    = require('./service');
const createCatalogoController = require('./controller');
const catalogoSchemas          = require('./schema');

function createCatalogoRouter(deps) {
  const { prisma, middlewares, auditReq, helpers, generarSiguienteCodigo } = deps;
  if (!prisma)                                      throw new Error('createCatalogoRouter: prisma required');
  if (!middlewares)                                 throw new Error('createCatalogoRouter: middlewares required');
  if (typeof auditReq !== 'function')               throw new Error('createCatalogoRouter: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createCatalogoRouter: generarSiguienteCodigo required');

  const { verificarJWT, verificarPortalJWT, requerirPermiso } = middlewares;

  const catalogoPublicoLimiter = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  });

  const repo       = createCatalogoRepo(prisma);
  const service    = createCatalogoService({ repo, auditReq, generarSiguienteCodigo, CODIGO_PREFIJO: catalogoSchemas.CODIGO_PREFIJO });
  const controller = createCatalogoController({ service, schemas: catalogoSchemas, prisma, helpers });

  const router = express.Router();

  // ─── Búsqueda unificada ─────────────────────────────────────────────────
  router.get('/catalogo/buscar', verificarJWT,                                  controller.buscar);

  // ─── CRUD Items ─────────────────────────────────────────────────────────
  router.get('/catalogo',         verificarJWT,                                 controller.listCatalogo);
  router.post('/catalogo',        verificarJWT, requerirPermiso('catalogo:editar'), controller.postItem);
  router.put('/catalogo/:id',     verificarJWT, requerirPermiso('catalogo:editar'), controller.putItem);
  router.delete('/catalogo/:id',  verificarJWT, requerirPermiso('catalogo:editar'), controller.deleteItem);

  // ─── Planes ─────────────────────────────────────────────────────────────
  router.get('/planes',                                                         controller.listPlanes);
  router.get('/planes/:id',                                                     controller.getPlan);
  router.post('/planes',          verificarJWT, requerirPermiso('catalogo:editar'), controller.postPlan);
  router.put('/planes/:id',       verificarJWT, requerirPermiso('catalogo:editar'), controller.putPlan);
  router.patch('/planes/:id/toggle', verificarJWT, requerirPermiso('catalogo:editar'), controller.togglePlan);

  // ─── Catálogo público (anti-scraping) + portal ──────────────────────────
  router.get('/catalogo-publico', catalogoPublicoLimiter,                       controller.getCatalogoPublico);
  router.get('/portal/catalogo',  verificarPortalJWT,                           controller.getPortalCatalogo);

  // ─── Bundles cross-sell (Fase 1.4) ──────────────────────────────────────
  router.get('/productos/:id/bundles', verificarJWT,                            controller.getBundlesProducto);
  router.get('/catalogo/:id/bundles',  verificarJWT,                            controller.getBundlesItem);

  return router;
}

module.exports = createCatalogoRouter;
