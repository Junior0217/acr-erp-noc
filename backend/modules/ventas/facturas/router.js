/**
 * backend/modules/ventas/facturas/router.js
 *
 * Rutas HTTP del módulo Facturas. Compone repo + service + controller via
 * factory. CERO lógica. Cero NCF directo (siempre via deps.ncfService).
 *
 * Rutas:
 *   POST   /facturas                       — emisión desde OT (billingLimiter)
 *   POST   /facturas/:id/revertir          — God Mode (sistema:owner)
 *   POST   /facturas/:id/nota-credito      — DGII B04 (factura:anular + PIN)
 *   POST   /facturas/:id/nota-debito       — DGII B03 (factura:anular + PIN)
 *   PATCH  /facturas/:id/condiciones       — edición rápida de condiciones
 *
 * Factory: createFacturasRouter(deps) -> express.Router
 *
 * deps esperados (subDeps de ventas/index.js):
 *   prisma, middlewares, auditReq, helpers, limiters,
 *   ncfService, generarSiguienteCodigo, persistirVerifyHash,
 *   pdfService (opcional para invalidar cache),
 *   buildFacturaPDFBuffer + sendFacturaPDF (opcionales para email FF).
 */

const express = require('express');
const createFacturasRepo       = require('./repo');
const createFacturasService    = require('./service');
const createFacturasController = require('./controller');
const facturasSchemas          = require('./schema');

function createFacturasRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, limiters,
    ncfService, generarSiguienteCodigo, persistirVerifyHash,
    pdfService, buildFacturaPDFBuffer, sendFacturaPDF,
  } = deps;
  if (!prisma)                                          throw new Error('createFacturasRouter: prisma required');
  if (!middlewares)                                     throw new Error('createFacturasRouter: middlewares required');
  if (typeof auditReq !== 'function')                   throw new Error('createFacturasRouter: auditReq required');
  if (!ncfService)                                      throw new Error('createFacturasRouter: ncfService required (shared/services/ncf.service)');
  if (typeof generarSiguienteCodigo !== 'function')     throw new Error('createFacturasRouter: generarSiguienteCodigo required');
  if (typeof persistirVerifyHash !== 'function')        throw new Error('createFacturasRouter: persistirVerifyHash required');

  const { verificarJWT, requerirPermiso } = middlewares;
  const { billingLimiter }                = limiters ?? {};

  const repo       = createFacturasRepo(prisma);
  const service    = createFacturasService({
    repo, auditReq, ncfService,
    generarSiguienteCodigo, persistirVerifyHash,
    buildFacturaPDFBuffer, sendFacturaPDF, pdfService,
  });
  const controller = createFacturasController({ service, schemas: facturasSchemas, prisma, helpers });

  const router = express.Router();

  router.post('/facturas',                  verificarJWT, billingLimiter, requerirPermiso('factura:emitir'),  controller.postFactura);
  router.post('/facturas/:id/revertir',     verificarJWT, billingLimiter, requerirPermiso('sistema:owner'),   controller.postRevertir);
  router.post('/facturas/:id/nota-credito', verificarJWT, billingLimiter,                                      controller.postNotaCredito);
  router.post('/facturas/:id/nota-debito',  verificarJWT, billingLimiter,                                      controller.postNotaDebito);
  router.patch('/facturas/:id/condiciones', verificarJWT,                  requerirPermiso('factura:editar'), controller.patchCondiciones);

  return router;
}

module.exports = createFacturasRouter;
