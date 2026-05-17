/**
 * backend/modules/crm/portal-b2c/router.js
 *
 * Rutas HTTP del Portal B2C. CERO lógica.
 *
 * Limiters LOCALES (sensibles al ámbito público):
 *   - portalLoginLimiter: 5/15min (heredado de _routerDeps si está,
 *     fallback local para no romper si server.js no lo pasa).
 *   - forgotLimiter:  3/15min keyed por reqFingerprint (anti email-spam).
 *   - checkoutLimiter: 5/min (prevención abuso checkout).
 *
 * Webhook Azul usa express.raw para preservar el cuerpo crudo (HMAC verify).
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const createPortalRepo       = require('./repo');
const createPortalService    = require('./service');
const createPortalController = require('./controller');
const portalSchemas          = require('./schema');

function createPortalB2cRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, limiters,
    signPortalToken, persistirVerifyHash, nextNomenclatura,
    emailTransporter, buildFacturaPDFBuffer, redisClient,
  } = deps;
  if (!prisma)                                   throw new Error('createPortalB2cRouter: prisma required');
  if (!middlewares)                              throw new Error('createPortalB2cRouter: middlewares required');
  if (typeof auditReq !== 'function')            throw new Error('createPortalB2cRouter: auditReq required');
  if (typeof signPortalToken !== 'function')     throw new Error('createPortalB2cRouter: signPortalToken required');

  const { verificarJWT, verificarPortalJWT, requerirPermiso } = middlewares;
  const { reqFingerprint } = helpers ?? {};
  if (typeof reqFingerprint !== 'function') throw new Error('createPortalB2cRouter: helpers.reqFingerprint required (anti IPv6 keyGen)');

  // Limiters: prefer the ones passed via deps (single global instance),
  // fall back to local for tests/standalone factory invocation.
  const portalLoginLimiter = limiters?.portalLoginLimiter || rateLimit({
    windowMs: 15 * 60 * 1000, max: 5,
    keyGenerator: reqFingerprint, message: { error: 'Demasiados intentos. Intente en 15 minutos.' },
  });
  const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 3,
    keyGenerator: reqFingerprint,
    message: { error: 'Demasiadas solicitudes. Intente en 15 minutos.' },
  });
  const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });

  const repo       = createPortalRepo(prisma);
  const service    = createPortalService({
    repo, auditReq, signPortalToken, persistirVerifyHash, nextNomenclatura,
    emailTransporter, buildFacturaPDFBuffer, redisClient,
  });
  const controller = createPortalController({ service, schemas: portalSchemas });

  const router = express.Router();

  // Expose prisma en app.locals para que el webhook (que no recibe deps en el
  // wrap clásico) pueda abrir su $transaction. Trade-off pragmático.
  router.use((req, _res, next) => { req.app.locals.prisma = prisma; next(); });

  // ─── CSRF + Catalog público ─────────────────────────────────────────────
  router.get('/portal/auth/csrf',  verificarPortalJWT,                       controller.csrf);
  router.get('/portal/catalog',                                              controller.listCatalogPortal);

  // ─── Portal Settings ────────────────────────────────────────────────────
  router.get('/portal/settings',                                             controller.getSettings);
  router.put('/portal/settings',   verificarJWT, requerirPermiso('sistema:config'), controller.putSettings);

  // ─── Auth ──────────────────────────────────────────────────────────────
  router.post('/portal/auth/register',         portalLoginLimiter, controller.register);
  router.post('/portal/auth/login',            portalLoginLimiter, controller.login);
  router.post('/portal/auth/logout',                               controller.logout);
  router.get('/portal/auth/me',                verificarPortalJWT, controller.me);
  router.post('/portal/auth/forgot-password',  forgotLimiter,      controller.forgot);
  router.post('/portal/auth/reset-password',                       controller.reset);

  // ─── SOS + Cotización + Dashboard + PDF ────────────────────────────────
  router.post('/portal/sos',                   verificarPortalJWT, controller.sos);
  router.post('/portal/cotizacion',            verificarPortalJWT, controller.cotizacionPortal);
  router.get('/portal/cotizaciones',           verificarPortalJWT, controller.listCotizacionesPortal);
  router.get('/portal/dashboard',              verificarPortalJWT, controller.dashboard);
  router.get('/portal/facturas/:id/pdf',       verificarPortalJWT, controller.facturaPdfPortal);

  // ─── E-commerce: Checkout + Webhook ────────────────────────────────────
  router.post('/portal/checkout',              checkoutLimiter, verificarPortalJWT, controller.checkout);
  router.post('/webhooks/azul',                express.raw({ type: '*/*', limit: '50kb' }), controller.webhookAzul);

  return router;
}

module.exports = createPortalB2cRouter;
