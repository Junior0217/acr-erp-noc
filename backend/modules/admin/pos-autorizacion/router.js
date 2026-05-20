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
 *   - webhook/:id/approve: webhookApproveLimiter LOCAL (10/15min/IP) —
 *     superficie PÚBLICA, anula brute-force sobre challengeId + HMAC.
 */

const express     = require('express');
const rateLimit   = require('express-rate-limit');

const createPosAutorizacionRepo       = require('./repo');
const createPosAutorizacionService    = require('./service');
const createPosAutorizacionController = require('./controller');
const schemas                         = require('./schema');

function createPosAutorizacionRouter(deps) {
  const { prisma, middlewares, auditReq, limiters, helpers } = deps;
  if (!prisma)                        throw new Error('createPosAutorizacionRouter: prisma required');
  if (!middlewares)                   throw new Error('createPosAutorizacionRouter: middlewares required');
  if (typeof auditReq !== 'function') throw new Error('createPosAutorizacionRouter: auditReq required');

  const { verificarJWT } = middlewares;
  // Reusa el limiter de PIN si está disponible; si no, no-op middleware.
  const limiter = (limiters?.loginLimiter) || ((req, res, next) => next());

  // webhookApproveLimiter: 10 intentos por IP en 15 min. Endpoint PÚBLICO sin
  // JWT: la única defensa contra fuerza-bruta sobre challengeId+HMAC son los
  // bytes random (16) del challenge y el HMAC SHA-256, pero un atacante con
  // capacidad de generar miles de requests podría intentar colisiones o
  // fingerprinting de timing. El limiter cierra esa ventana. Usa reqFingerprint
  // si está disponible (hash IP+UA, mitiga NAT/IPv6); fallback a IP cruda.
  const keyGen = typeof helpers?.reqFingerprint === 'function'
    ? helpers.reqFingerprint
    : (req) => req.ip;
  const webhookApproveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      10,
    keyGenerator: keyGen,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Demasiados intentos de aprobación. Intente en 15 minutos.' },
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
