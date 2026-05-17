/**
 * backend/modules/inventario/uploads/router.js
 *
 * Rutas HTTP del sub-módulo Uploads. Aplica uploadLimiter + uploadMulter +
 * verificarJWT + requerirPermiso('catalogo:editar'). Compone factory.
 *
 * Factory: createUploadsRouter(deps) -> express.Router
 *
 * deps: prisma (no usado aquí, pero queda por contrato), middlewares,
 * limiters (uploadLimiter, uploadMulter), supabase, INVENTORY_BUCKET,
 * MIME_EXT, KINDS_INVENTARIO, detectMimeFromBuffer, svgSeguro,
 * comprimirImagen, esUrlPublicaSegura, auditReq.
 */

const express = require('express');
const createUploadsRepo        = require('./repo');
const createUploadsService     = require('./service');
const createUploadsController  = require('./controller');
const { buildSchemas }         = require('./schema');

function createUploadsRouter(deps) {
  const {
    middlewares, limiters, auditReq,
    supabase, INVENTORY_BUCKET, MIME_EXT, KINDS_INVENTARIO,
    detectMimeFromBuffer, svgSeguro, comprimirImagen, esUrlPublicaSegura,
  } = deps;
  if (!middlewares)        throw new Error('createUploadsRouter: middlewares required');
  if (!limiters)           throw new Error('createUploadsRouter: limiters required');
  if (typeof auditReq !== 'function') throw new Error('createUploadsRouter: auditReq required');
  if (!supabase)           console.warn('[UPLOADS] supabase no inyectado — endpoints responderán 503');

  const { verificarJWT, requerirPermiso }   = middlewares;
  const { uploadLimiter, uploadMulter }     = limiters;
  if (!uploadLimiter || !uploadMulter) throw new Error('createUploadsRouter: uploadLimiter + uploadMulter required');

  const repo       = createUploadsRepo({ supabase, INVENTORY_BUCKET });
  const service    = createUploadsService({
    repo, auditReq, supabase, INVENTORY_BUCKET, MIME_EXT, KINDS_INVENTARIO,
    detectMimeFromBuffer, svgSeguro, comprimirImagen, esUrlPublicaSegura,
  });
  const schemas    = buildSchemas(KINDS_INVENTARIO);
  const controller = createUploadsController({ service, schemas });

  const router = express.Router();

  router.post('/inventario/upload-image',
    uploadLimiter,
    verificarJWT,
    requerirPermiso('catalogo:editar'),
    uploadMulter.single('file'),
    controller.uploadImage,
  );

  router.post('/inventario/upload-url',
    uploadLimiter,
    verificarJWT,
    requerirPermiso('catalogo:editar'),
    controller.uploadFromUrl,
  );

  return router;
}

module.exports = createUploadsRouter;
