/**
 * backend/modules/ventas/ordenes/router.js
 *
 * Rutas HTTP del módulo Ordenes (OT + OrdenInstalacion + Servicio + Foto).
 * Compone repo+service+controller via factory. CERO lógica.
 *
 * Factory: createOrdenesRouter(deps) -> express.Router
 *
 * Middleware stack:
 *   - verificarJWT en todas (autenticación obligatoria)
 *   - requerirPermiso fino (ot:ver, ot:crear, ot:editar, servicios:crear)
 *   - billingLimiter en /ordenes POST (operación costosa)
 *   - uploadLimiter + uploadMulter.single('file') en /ordenes/:id/fotos/upload
 */

const express = require('express');

const createOrdenesRepo       = require('./repo');
const createOrdenesService    = require('./service');
const createOrdenesController = require('./controller');
const ordenesSchemas          = require('./schema');

function createOrdenesRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, limiters,
    nextNomenclatura, generarSiguienteCodigo,
    supabase, detectMimeFromBuffer, comprimirImagen,
  } = deps;
  if (!prisma)                                       throw new Error('createOrdenesRouter: prisma required');
  if (!middlewares)                                  throw new Error('createOrdenesRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createOrdenesRouter: auditReq required');
  if (typeof nextNomenclatura !== 'function')        throw new Error('createOrdenesRouter: nextNomenclatura required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createOrdenesRouter: generarSiguienteCodigo required');

  const { verificarJWT, requerirPermiso } = middlewares;
  const { billingLimiter, uploadLimiter, uploadMulter } = limiters ?? {};

  // Bucket dedicado a fotos de OT (separado de catálogo/inventario). Env
  // override permite redirigir a bucket de QA sin cambiar código.
  const OT_FOTOS_BUCKET = process.env.SUPABASE_OT_FOTOS_BUCKET ?? 'ot-fotos';

  const repo       = createOrdenesRepo(prisma);
  const service    = createOrdenesService({
    repo, auditReq,
    supabase, OT_FOTOS_BUCKET,
    detectMimeFromBuffer, comprimirImagen,
    nextNomenclatura, generarSiguienteCodigo,
  });
  const controller = createOrdenesController({
    service, schemas: ordenesSchemas, prisma, helpers,
  });

  const router = express.Router();

  // ─── Orden de Trabajo (canónico /api/ordenes) ───────────────────────────
  router.get('/ordenes',           verificarJWT, requerirPermiso('ot:ver'),    controller.listOrdenesTrabajo);
  router.post('/ordenes',          verificarJWT, billingLimiter, requerirPermiso('ot:crear'),  controller.createOrdenTrabajo);
  router.delete('/ordenes/:id',    verificarJWT, requerirPermiso('ot:editar'), controller.deleteOrdenTrabajo);
  router.patch('/ordenes/:id/estado', verificarJWT, requerirPermiso('ot:editar'), controller.patchEstadoOT);

  // ─── Orden de Instalación (legacy /ordenes-instalacion) ─────────────────
  router.get('/ordenes-instalacion',                  controller.listOrdenesInstalacion);
  router.post('/ordenes-instalacion',                 verificarJWT, requerirPermiso('ot:crear'),  controller.createOrdenInstalacion);
  router.put('/ordenes-instalacion/:id',              verificarJWT, requerirPermiso('ot:editar'), controller.updateOrdenInstalacion);
  router.patch('/ordenes-instalacion/:id/completar',  verificarJWT, requerirPermiso('ot:editar'), controller.completarOrdenInstalacion);

  // ─── Servicios ──────────────────────────────────────────────────────────
  router.get('/servicios',               controller.listServicios);
  router.post('/servicios',              verificarJWT, requerirPermiso('servicios:crear'), controller.createServicio);
  router.put('/servicios/:id',           verificarJWT, requerirPermiso('servicios:crear'), controller.updateServicio);
  router.patch('/servicios/:id/estado',  verificarJWT, requerirPermiso('servicios:crear'), controller.patchEstadoServicio);

  // ─── Fotos de OT (evidencia anti-fraude) ────────────────────────────────
  router.get('/ordenes/:id/fotos',                verificarJWT, requerirPermiso('ot:ver'),    controller.listFotos);
  router.post('/ordenes/:id/fotos/upload',
    uploadLimiter,
    verificarJWT,
    requerirPermiso('ot:editar'),
    uploadMulter.single('file'),
    controller.uploadFoto,
  );
  router.post('/ordenes/:id/fotos',                verificarJWT, requerirPermiso('ot:editar'), controller.registrarFotoUrl);
  router.delete('/ordenes/:ordenId/fotos/:fotoId', verificarJWT, requerirPermiso('ot:editar'), controller.deleteFoto);

  return router;
}

module.exports = createOrdenesRouter;
