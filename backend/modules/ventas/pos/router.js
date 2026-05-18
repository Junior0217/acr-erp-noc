/**
 * backend/modules/ventas/pos/router.js
 *
 * Rutas HTTP del módulo POS (Fase 2 Blueprint). Compone repo+service+
 * controller via factory y aplica middlewares (verificarJWT + billingLimiter
 * + pinVerifyLimiter LOCAL).
 *
 * Factory: createPosRouter(deps) -> express.Router
 *
 * CERO lógica de negocio. CERO Prisma. Si tocas este archivo y no es para
 * agregar/quitar una ruta o middleware, estás violando el Blueprint.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const createPosRepo        = require('./repo');
const createPosService     = require('./service');
const createPosController  = require('./controller');
const posSchemas           = require('./schema');

function createPosRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, limiters,
    generarSiguienteCodigo, persistirVerifyHash, bomService, stockHub, cotEventoSvc,
    ncfReservation,
  } = deps;
  if (!prisma)                                       throw new Error('createPosRouter: prisma required');
  if (!middlewares)                                  throw new Error('createPosRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createPosRouter: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createPosRouter: generarSiguienteCodigo required');
  if (typeof persistirVerifyHash !== 'function')    throw new Error('createPosRouter: persistirVerifyHash required');

  const { verificarJWT, requerirPermiso } = middlewares;
  const { billingLimiter }                = limiters ?? {};
  const { reqFingerprint }                = helpers ?? {};
  if (typeof reqFingerprint !== 'function') {
    throw new Error('createPosRouter: helpers.reqFingerprint requerido para pinVerifyLimiter (anti IPv6 bare-ip key).');
  }

  const repo       = createPosRepo(prisma);
  const service    = createPosService({ repo, auditReq, generarSiguienteCodigo, persistirVerifyHash, bomService, ownerAlerts: deps.ownerAlerts });
  const controller = createPosController({ service, schemas: posSchemas, prisma, stockHub, cotEventoSvc, ncfReservation });

  // pinVerifyLimiter LOCAL: 10 intentos por usuario (o fingerprint hash) en
  // 5 min. skipSuccessfulRequests=true → PIN correcto en flow del cajero no
  // consume cuota. CRÍTICO: reqFingerprint hashea IP+UA y devuelve hex,
  // satisface express-rate-limit v7 que rechaza keyGens basados en `req.ip`
  // crudo por riesgo IPv6 (ERR_ERL_KEY_GEN_IPV6).
  const pinVerifyLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max:      10,
    keyGenerator: (req) => req.user?.sub ? `pin:${req.user.sub}` : reqFingerprint(req),
    skipSuccessfulRequests: true,
    message: { valid: false, error: 'Demasiados intentos de PIN. Espera 5 minutos.' },
  });

  // Mejora #2: Rate-limit por cajero en venta POS. Bucket por req.user.sub
  // → si un user (sesión comprometida) intenta loop de facturas falsas, se
  // capa a 60/min. El billingLimiter global sigue activo como red secundaria.
  // skipSuccessfulRequests=false: cuenta TODOS los intentos (un atacante
  // exitoso es peor que uno fallido).
  const posVentaPorCajero = rateLimit({
    windowMs: 60 * 1000,
    max:      60,
    keyGenerator: (req) => req.user?.sub ? `pos:${req.user.sub}` : reqFingerprint(req),
    message: { error: 'Demasiadas ventas por minuto. Espera unos segundos.', code: 'POS_PER_USER_RL' },
  });

  const router = express.Router();

  router.post('/pos/verificar-pin', verificarJWT, pinVerifyLimiter,                                            controller.verifyPin);
  router.post('/pos/venta',         verificarJWT, billingLimiter, posVentaPorCajero,                           controller.postVenta);
  router.post('/facturas/manual',   verificarJWT, billingLimiter, posVentaPorCajero, requerirPermiso('factura:emitir'), controller.postFacturaManual);

  return router;
}

module.exports = createPosRouter;
