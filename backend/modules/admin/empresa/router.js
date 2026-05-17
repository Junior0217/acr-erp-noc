/**
 * backend/modules/admin/empresa/router.js
 *
 * Blueprint 5-file MVC. Submódulo ncf/ mantiene su propio Blueprint.
 *
 * Cyber Neo:
 *   - GET /publico: rateLimit propio + SELECT explícito (no PII representante).
 *   - PATCH /configuracion/empresa: pinSupervisor + maxDescuentoCajero
 *     exigen sistema:owner (denial audit en intento de bypass).
 *   - PATCH /configuracion/secuencias: sistema:owner.
 *   - POST /admin/migrar-descripciones: sistema:owner.
 *   - POST /configuracion/empresa/upload: path = bucket/kind-ts-random.ext
 *     (cero req.params en path), MIME real por magic bytes, SVG safety.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const createEmpresaSchemas    = require('./schema');
const createEmpresaRepo       = require('./repo');
const createEmpresaService    = require('./service');
const createEmpresaController = require('./controller');
// ncf/ submódulo lo monta admin/index.js (mismo nivel que empresa) —
// no se duplica aquí para evitar doble-registro de routes.

function createEmpresaRouter(deps) {
  const {
    prisma, auditReq, middlewares, helpers, limiters,
    supabase, SUPABASE_BUCKET, pathFromSupabaseUrl,
    KINDS_VALIDOS, MIME_EXT, detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, SECUENCIA_DEFAULTS,
  } = deps;
  if (!prisma)                                       throw new Error('createEmpresaRouter: prisma required');
  if (!middlewares)                                  throw new Error('createEmpresaRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createEmpresaRouter: auditReq required');
  if (!helpers?.validarCedulaRD)                     throw new Error('createEmpresaRouter: helpers.validarCedulaRD required');
  if (typeof esAssetUrlSegura !== 'function')        throw new Error('createEmpresaRouter: esAssetUrlSegura required');

  const { verificarJWT, requerirPermiso } = middlewares;
  const { uploadLimiter, uploadMulter } = limiters || {};

  const schemas    = createEmpresaSchemas({
    validarCedulaRD: helpers.validarCedulaRD,
    esAssetUrlSegura,
  });
  const repo       = createEmpresaRepo(prisma);
  const service    = createEmpresaService({
    repo, auditReq, SECUENCIA_DEFAULTS,
    supabase, SUPABASE_BUCKET, pathFromSupabaseUrl,
    KINDS_VALIDOS, MIME_EXT, detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura,
  });
  const controller = createEmpresaController({ service, schemas });

  const router = express.Router();
  const empresaPublicLimiter = rateLimit({
    windowMs: 60_000, max: 60,
    standardHeaders: true, legacyHeaders: false,
  });

  // GET semi-público — solo membrete + logos. Sin PII representante.
  router.get('/configuracion/empresa/publico', empresaPublicLimiter, controller.getPublico);

  router.get('/configuracion/empresa', verificarJWT, requerirPermiso('empresa:ver'), controller.getEmpresa);

  router.get('/configuracion/secuencias',           verificarJWT, requerirPermiso('empresa:ver'),    controller.getSecuencias);
  router.patch('/configuracion/secuencias',         verificarJWT, requerirPermiso('sistema:owner'), controller.patchSecuencias);
  router.get('/configuracion/secuencias/preview/:entidad',
                                                    verificarJWT, requerirPermiso('empresa:ver'),    controller.previewSecuencia);

  router.post('/admin/migrar-descripciones', verificarJWT, requerirPermiso('sistema:owner'), controller.migrarDescripciones);

  router.patch('/configuracion/empresa', verificarJWT, requerirPermiso('empresa:editar'), controller.patchEmpresa);

  if (uploadMulter && uploadLimiter) {
    router.post('/configuracion/empresa/upload',
      uploadLimiter, verificarJWT, requerirPermiso('empresa:editar'),
      uploadMulter.single('file'), controller.upload);
  }

  return router;
}

module.exports = createEmpresaRouter;
