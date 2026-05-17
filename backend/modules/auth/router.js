/**
 * backend/modules/auth/router.js
 *
 * Único punto que conoce las rutas HTTP del módulo Auth. CERO lógica.
 * Solo declara:
 *   - Rutas y verbos.
 *   - Middlewares de protección (verificarJWT, rate limiters).
 *   - Composición router/controller/service/repo via factory.
 *
 * Factory: createAuthRouter(deps) -> express.Router
 *
 * deps esperados (inyectados desde server.js via _routerDeps):
 *   prisma, middlewares, schemas (compartidos), auditReq, limiters,
 *   twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS, PERMISSIONS_MAP.
 */

const express = require('express');
const createAuthRepo        = require('./repo');
const createAuthService     = require('./service');
const createAuthController  = require('./controller');
const authSchemas           = require('./schema');

function createAuthRouter(deps) {
  const {
    prisma, middlewares, auditReq, limiters,
    twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS, PERMISSIONS_MAP,
  } = deps;
  if (!prisma)            throw new Error('createAuthRouter: prisma required');
  if (!middlewares)       throw new Error('createAuthRouter: middlewares required');
  if (!auditReq)          throw new Error('createAuthRouter: auditReq required');
  if (!limiters)          throw new Error('createAuthRouter: limiters required');

  const { verificarJWT }                          = middlewares;
  const { loginLimiter, totpLimiter, backupCodeLimiter } = limiters;

  const repo       = createAuthRepo(prisma);
  const service    = createAuthService({
    repo, auditReq, twoFAStore, challengeStore, warmChallengeStore,
    IDLE_TTL_MS, PERMISSIONS_MAP,
  });
  const controller = createAuthController({ service, schemas: authSchemas });

  /**
   * Aplica backupCodeLimiter SOLO si el body trae un código largo (≥10 chars
   * tras quitar guiones/espacios). Códigos TOTP cortos pasan únicamente por
   * totpLimiter. H7: previene enumeración de backup codes con cuota separada.
   */
  function aplicarBackupLimiterSiAplica(req, res, next) {
    const candidate = String(req.body?.totp ?? '').replace(/[-\s]/g, '');
    if (candidate.length >= 10) return backupCodeLimiter(req, res, next);
    next();
  }

  const router = express.Router();

  // ─── Pre-login ────────────────────────────────────────────────────────────
  router.get('/auth/challenge',                                  controller.getChallenge);
  router.post('/auth/login',          loginLimiter,              controller.login);

  // ─── Sesión activa ────────────────────────────────────────────────────────
  router.get('/auth/me',              verificarJWT,              controller.getMe);
  router.get('/auth/permissions',     verificarJWT,              controller.permissions);
  router.get('/auth/csrf',            verificarJWT,              controller.csrf);
  router.post('/auth/logout',         verificarJWT,              controller.logout);
  router.post('/auth/refresh',                                   controller.refresh);

  // ─── 2FA (TOTP + backup codes) ────────────────────────────────────────────
  router.post('/auth/2fa/verify',     totpLimiter, aplicarBackupLimiterSiAplica, controller.verifyTwoFA);
  router.get('/auth/2fa/setup',       verificarJWT,              controller.setupTwoFA);
  router.post('/auth/2fa/enable',     verificarJWT,              controller.enableTwoFA);
  router.post('/auth/2fa/disable',    verificarJWT,              controller.disableTwoFA);
  router.post('/auth/2fa/backup-codes/regenerate', verificarJWT, controller.regenerateBackupCodes);
  router.get('/auth/2fa/backup-codes/count',       verificarJWT, controller.countBackupCodes);

  // ─── WebAuthn / Passkeys ──────────────────────────────────────────────────
  router.post('/auth/webauthn/register/options',  verificarJWT,  controller.webauthnRegOptions);
  router.post('/auth/webauthn/register/verify',   verificarJWT,  controller.webauthnRegVerify);
  router.post('/auth/webauthn/login/options',     loginLimiter,  controller.webauthnLoginOpts);
  router.post('/auth/webauthn/login/verify',      loginLimiter,  controller.webauthnLoginVerify);
  router.get('/auth/webauthn/credentials',        verificarJWT,  controller.listCredentials);
  router.delete('/auth/webauthn/credentials/:id', verificarJWT,  controller.deleteCredential);

  // ─── Self-service ─────────────────────────────────────────────────────────
  router.patch('/auth/me/password',               verificarJWT,  controller.changePassword);
  router.get('/auth/me/sessions',                 verificarJWT,  controller.listSessions);
  router.delete('/auth/me/sessions/:jti',         verificarJWT,  controller.revokeSession);
  router.delete('/auth/me/sessions',              verificarJWT,  controller.revokeAllOther);

  return router;
}

module.exports = createAuthRouter;
