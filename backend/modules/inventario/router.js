/**
 * backend/modules/inventario/router.js
 *
 * Rutas HTTP del módulo Inventario. Compone repo + service + controller via
 * factory. CERO lógica. Middlewares aplicados aquí (verificarJWT + permisos).
 *
 * Factory: createInventarioRouter(deps) -> express.Router
 *
 * Nota: el sub-módulo `uploads/` se monta desde index.js del módulo padre,
 * no aquí — esto mantiene cada router en una sola responsabilidad.
 */

const express = require('express');
const createInventarioRepo       = require('./repo');
const createInventarioService    = require('./service');
const createInventarioController = require('./controller');
const inventarioSchemas          = require('./schema');

function createInventarioRouter(deps) {
  const {
    prisma, middlewares, auditReq, schemas: sharedSchemas,
    generarSiguienteCodigo,
  } = deps;
  if (!prisma)                                       throw new Error('createInventarioRouter: prisma required');
  if (!middlewares)                                  throw new Error('createInventarioRouter: middlewares required');
  if (!auditReq)                                     throw new Error('createInventarioRouter: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createInventarioRouter: generarSiguienteCodigo required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const repo       = createInventarioRepo(prisma);
  const service    = createInventarioService({ repo, generarSiguienteCodigo, auditReq });
  const controller = createInventarioController({
    service,
    schemas: { ...inventarioSchemas, prestamoSchema: sharedSchemas?.prestamoSchema },
  });

  const router = express.Router();

  // ─── Categorias ───────────────────────────────────────────────────────────
  router.get('/categorias',         controller.listCategorias);
  router.post('/categorias',        verificarJWT, requerirPermiso('catalogo:editar'), controller.createCategoria);
  router.put('/categorias/:id',     verificarJWT, requerirPermiso('catalogo:editar'), controller.updateCategoria);
  router.delete('/categorias/:id',  verificarJWT, requerirPermiso('catalogo:editar'), controller.deleteCategoria);

  // ─── Productos ────────────────────────────────────────────────────────────
  router.get('/productos',          controller.listProductos);
  router.post('/productos',         verificarJWT, requerirPermiso('catalogo:editar'), controller.createProducto);
  router.put('/productos/:id',      verificarJWT, requerirPermiso('catalogo:editar'), controller.updateProducto);
  router.delete('/productos/:id',   verificarJWT, requerirPermiso('catalogo:editar'), controller.deleteProducto);
  router.get('/productos/:id/series', verificarJWT, controller.listSeries);

  // ─── Movimientos (Kardex) ─────────────────────────────────────────────────
  router.get('/movimientos',        controller.listMovimientos);

  // ─── Prestamos (MSP) ──────────────────────────────────────────────────────
  router.get('/prestamos',                  verificarJWT, requerirPermiso('ot:ver'),    controller.listPrestamos);
  router.post('/prestamos',                 verificarJWT, requerirPermiso('ot:editar'), controller.createPrestamo);
  router.patch('/prestamos/:id/devolver',   verificarJWT, requerirPermiso('ot:editar'), controller.devolverPrestamo);

  return router;
}

module.exports = createInventarioRouter;
