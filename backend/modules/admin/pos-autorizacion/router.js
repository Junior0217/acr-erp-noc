/**
 * backend/modules/admin/pos-autorizacion/router.js
 *
 * Endpoints:
 *   POST   /api/pos/authorize-totp               JWT requerido — valida TOTP del usuario actual
 *   POST   /api/pos/authorize-webhook/request    JWT requerido — genera challenge + POST a webhook
 *   GET    /api/pos/authorize-webhook/:id/status JWT requerido — polling de estado (solo dueño del challenge)
 *   POST   /api/pos/authorize-webhook/:id/approve PÚBLICO       — recibe aprobación firmada HMAC
 *
 * Rate-limit:
 *   - TOTP + webhook/request: loginLimiter (reusado) — usuario autenticado.
 *   - webhook/:id/approve: webhookApproveLimiter compartido (10/15min/IP) —
 *     proviene de _routerDeps.limiters (definido en shared/limiters.js,
 *     instanciado en server.js con Redis store si está disponible). Endpoint
 *     PÚBLICO sin JWT: el limiter es la barrera anti-brute-force HMAC.
 */

const express = require('express');

const createPosAutorizacionRepo       = require('./repo');
const createPosAutorizacionService    = require('./service');
const createPosAutorizacionController = require('./controller');
const { createWebhookApproveLimiter } = require('../../../shared/limiters');
const schemas                         = require('./schema');

function createPosAutorizacionRouter(deps) {
  const { prisma, middlewares, auditReq, limiters, helpers } = deps;
  if (!prisma)                        throw new Error('createPosAutorizacionRouter: prisma required');
  if (!middlewares)                   throw new Error('createPosAutorizacionRouter: middlewares required');
  if (typeof auditReq !== 'function') throw new Error('createPosAutorizacionRouter: auditReq required');

  const { verificarJWT } = middlewares;
  // Reusa el limiter de PIN si está disponible; si no, no-op middleware.
  const limiter = (limiters?.loginLimiter) || ((req, res, next) => next());

  // webhookApproveLimiter: viene de _routerDeps.limiters (cross-pod via Redis
  // si REDIS_URL está set). Fallback local con MemoryStore por si el wiring
  // global no lo expuso (compat tests / scripts standalone).
  const webhookApproveLimiter = limiters?.webhookApproveLimiter
    ?? createWebhookApproveLimiter({
      keyGenerator: typeof helpers?.reqFingerprint === 'function'
        ? helpers.reqFingerprint
        : undefined,
    });

  const repo       = createPosAutorizacionRepo(prisma);
  const service    = createPosAutorizacionService({ repo, auditReq });
  const controller = createPosAutorizacionController({ service, schemas });

  const router = express.Router();

  router.post('/pos/authorize-totp',
    verificarJWT, limiter,
    controller.postTotp);

  router.post('/pos/authorize-webhook/request',
    verificarJWT, limiter,
    controller.postWebhookRequest);

  router.get('/pos/authorize-webhook/:id/status',
    verificarJWT,
    controller.getWebhookStatus);

  // PÚBLICO: la autenticación es por HMAC del body (no JWT). Rate-limit
  // estricto por IP — la única barrera anti brute-force.
  router.post('/pos/authorize-webhook/:id/approve',
    webhookApproveLimiter,
    controller.postWebhookApprove);

  return router;
}

module.exports = createPosAutorizacionRouter;
