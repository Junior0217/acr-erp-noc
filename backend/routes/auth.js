/**
 * backend/routes/auth.js
 *
 * Auth router: login, logout, refresh, sesiones, 2FA TOTP, backup codes,
 * WebAuthn (passkeys), challenge RSA, CSRF endpoint.
 *
 * Factory pattern: server.js inyecta prisma + middlewares + helpers + stores
 * compartidos para preservar singletons (cache de sesiones, throttles, etc.).
 *
 * NOTA DE MIGRACIÓN: las definiciones legacy permanecen en server.js mientras
 * se migran por fases. Cada handler movido aquí debe eliminarse del monolito
 * para evitar duplicación. Express toma la PRIMERA ruta registrada que matchea
 * el path, así que este router se monta DESPUÉS del bloque inline durante la
 * transición — los handlers en server.js ganan hasta que se borren.
 */

const express = require('express');

/**
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {object} deps.middlewares - createMiddlewares(...) result
 * @param {object} deps.schemas
 * @param {Function} deps.auditReq
 * @param {object} deps.limiters - { loginLimiter, totpLimiter, backupCodeLimiter, ... }
 * @returns {express.Router}
 */
function createAuthRouter(deps) {
  const router = express.Router();
  // const { prisma, middlewares, schemas, auditReq, limiters } = deps;
  // const { verificarJWT, requerirPermiso } = middlewares;

  // Marker para introspección /api/_meta/endpoints — sin handlers todavía.
  router.get('/_meta/auth-router', (req, res) => res.json({ ok: true, router: 'auth', migrated: 0 }));

  return router;
}

module.exports = createAuthRouter;
