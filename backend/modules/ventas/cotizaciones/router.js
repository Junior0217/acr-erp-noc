/**
 * backend/modules/ventas/cotizaciones/router.js
 *
 * Rutas HTTP del módulo Cotizaciones. CERO lógica.
 *
 * Mantiene endpoints de Factura (list/get/estado) que viven históricamente
 * en este router por UI/UX legacy — no se mueven a facturas/ para no romper
 * el frontend.
 */

const express = require('express');
const { authenticator } = require('otplib');
const { decryptTOTP } = require('../../../shared/jwt-crypto');
let _syncMikrotik = null;
try { _syncMikrotik = require('../../../services/mikrotik').syncMikrotik; } catch {}

const createCotizacionesRepo       = require('./repo');
const createCotizacionesService    = require('./service');
const createCotizacionesController = require('./controller');
const cotizacionesSchemas          = require('./schema');
const createIdempotencyMiddleware  = require('../../../shared/middlewares/idempotency.middleware');

function createCotizacionesRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, limiters,
    persistirVerifyHash, pdfService, cotEventoSvc, ncfReservation,
  } = deps;
  if (!prisma)       throw new Error('createCotizacionesRouter: prisma required');
  if (!middlewares)  throw new Error('createCotizacionesRouter: middlewares required');
  if (typeof auditReq !== 'function') throw new Error('createCotizacionesRouter: auditReq required');

  const { verificarJWT, requerirPermiso } = middlewares;
  const { billingLimiter }                = limiters ?? {};

  // totalLinea + procesarFacturaPOS vienen via subDeps de ventas/_lib.js
  // (factory invocada por ventas/index.js). Fallback a null si no están —
  // los handlers de revivir-con-emisión devolverán 503.
  const totalLinea         = deps.totalLinea          || ((pu, pct, monto, cant) => Math.round(Math.max(0, pu * (1 - pct / 100) - monto) * cant * 100) / 100);
  const procesarFacturaPOS = deps.procesarFacturaPOS  || null;

  const repo       = createCotizacionesRepo(prisma);
  const service    = createCotizacionesService({
    repo, auditReq, decryptTOTP, authenticator,
    syncMikrotik:        _syncMikrotik,
    persistirVerifyHash, procesarFacturaPOS, pdfService,
    totalLinea, cotEventoSvc,
    ownerAlerts: deps.ownerAlerts,
  });
  const controller = createCotizacionesController({
    service, schemas: cotizacionesSchemas, helpers, cotEventoSvc,
  });

  const router = express.Router();

  // Mejora #4 — Idempotencia universal money-moving. Revivir cotización
  // puede emitir factura real (NCF + stock + verifyHash) → doble-clic del
  // cajero debe devolver la primera factura, no crear dos. required=false
  // por ahora hasta que el front pase Idempotency-Key; cuando el front
  // esté listo, subir a required:true.
  const idemRevivir = createIdempotencyMiddleware({
    scope: 'cotizacion-revivir',
    ncfReservation,
    required: false,
  });

  // ─── Cotizaciones ────────────────────────────────────────────────────────
  router.get('/cotizaciones',                  verificarJWT, requerirPermiso('factura:ver'),                  controller.listCotizaciones);
  router.post('/cotizaciones/:id/revivir',     verificarJWT, requerirPermiso('factura:emitir'), idemRevivir,  controller.postRevivir);

  // ─── Facturas (list/get/estado) — históricamente en este router ─────────
  router.get('/facturas/:id',                  verificarJWT, requerirPermiso('factura:ver'),                  controller.getFactura);
  router.get('/facturas',                      verificarJWT, requerirPermiso('factura:ver'),                  controller.listFacturas);
  router.patch('/facturas/:id/estado',         verificarJWT, billingLimiter, requerirPermiso('factura:editar'), controller.patchEstadoFactura);

  // ─── Pipeline Kanban (Fase 1.4) ─────────────────────────────────────────
  router.patch('/cotizaciones/:id/etapa',      verificarJWT, requerirPermiso('venta:editar_cotizaciones'),    controller.patchEtapaCotizacion);

  // ─── Mejora #4 — Historial hash-chain + verify ──────────────────────────
  if (cotEventoSvc && controller.getCotizacionHistorial) {
    router.get('/cotizaciones/:id/historial',
      verificarJWT, requerirPermiso('venta:ver_cotizaciones'),
      controller.getCotizacionHistorial);
  }

  return router;
}

module.exports = createCotizacionesRouter;
