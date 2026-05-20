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
const createFacturasRepo          = require('./repo');
const createFacturasService       = require('./service');
const createFacturasController    = require('./controller');
const facturasSchemas             = require('./schema');
const createIdempotencyMiddleware = require('../../../shared/middlewares/idempotency.middleware');

function createFacturasRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, limiters,
    ncfService, generarSiguienteCodigo, persistirVerifyHash,
    pdfService, buildFacturaPDFBuffer, sendFacturaPDF, ncfReservation,
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
    ownerAlerts: deps.ownerAlerts,
    // L1.1 RLS wrapper — bound al prisma extendido (server.js). Si no existe
    // (tests con prisma mock), el service refleja el error vía RLS_WRAPPER_MISSING.
    withCurrentUserRls: typeof prisma.withCurrentUserRls === 'function'
      ? prisma.withCurrentUserRls.bind(prisma)
      : undefined,
  });
  const controller = createFacturasController({ service, schemas: facturasSchemas, prisma, helpers });

  const router = express.Router();

  // Mejora #4 — Idempotencia universal. Cualquier botón que mueva NCF,
  // stock o dinero debe protegerse contra doble-clic. Aplica a:
  //   - POST /facturas              (emisión desde OT)
  //   - POST /facturas/:id/nota-credito (B04 — afecta NCF + stock)
  //   - POST /facturas/:id/nota-debito  (B03 — afecta NCF)
  // required=false durante migración; subir a true cuando el front mande
  // crypto.randomUUID() como Idempotency-Key en cada submit.
  const idemEmision = createIdempotencyMiddleware({ scope: 'factura-emit',   ncfReservation, required: false });
  const idemNC      = createIdempotencyMiddleware({ scope: 'nota-credito',   ncfReservation, required: false });
  const idemND      = createIdempotencyMiddleware({ scope: 'nota-debito',    ncfReservation, required: false });

  router.post('/facturas',                  verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), idemEmision,  controller.postFactura);
  router.post('/facturas/:id/revertir',     verificarJWT, billingLimiter, requerirPermiso('sistema:owner'),                controller.postRevertir);
  router.post('/facturas/:id/nota-credito', verificarJWT, billingLimiter, idemNC,                                           controller.postNotaCredito);
  router.post('/facturas/:id/nota-debito',  verificarJWT, billingLimiter, idemND,                                           controller.postNotaDebito);
  router.patch('/facturas/:id/condiciones', verificarJWT,                  requerirPermiso('factura:editar'),               controller.patchCondiciones);

  return router;
}

module.exports = createFacturasRouter;
