/**
 * backend/modules/crm/credenciales/router.js
 *
 * Rutas HTTP del Vault PAM. Aplica los middlewares MÁS estrictos del sistema:
 *   - verificarJWT          : autenticación obligatoria.
 *   - requerirPermiso('vault:ver'|'vault:editar'|'vault:reveal').
 *   - vaultCooldownGuard    : 30s entre reveals por usuario (compartido con
 *                              service vía vaultLastReveal Map inyectado en
 *                              ambos desde server.js — fix de Map duplicado).
 *   - requerirTOTPEstricto  : TOTP en cada reveal (header X-TOTP). Sin
 *                              2FA configurado → 422 TOTP_NOT_CONFIGURED.
 *
 * Cyber Neo silent fix: el monolito original re-implementaba localmente
 * requerirTOTPEstricto y vaultCooldownGuard con SU PROPIO Map _vaultLastReveal,
 * mientras shared/middlewares.js también tenía sus copias con OTRO Map. Eso
 * permitía bypass del cooldown si las requests pasaban por uno u otro path.
 * Ahora: ambos comparten el Map inyectado desde server.js via _routerDeps.
 *
 * Factory: createCredencialesRouter(deps) -> express.Router
 */

const express = require('express');
const createCredencialesRepo       = require('./repo');
const createCredencialesService    = require('./service');
const createCredencialesController = require('./controller');
const credencialesSchemas          = require('./schema');

function createCredencialesRouter(deps) {
  const { prisma, middlewares, auditReq, helpers, vaultLastReveal } = deps;
  if (!prisma)                                       throw new Error('createCredencialesRouter: prisma required');
  if (!middlewares)                                  throw new Error('createCredencialesRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createCredencialesRouter: auditReq required');
  if (!(vaultLastReveal instanceof Map))             throw new Error('createCredencialesRouter: vaultLastReveal Map required (shared con shared/middlewares)');

  const { verificarJWT, requerirPermiso, requerirTOTPEstricto, vaultCooldownGuard } = middlewares;
  if (typeof requerirTOTPEstricto !== 'function') throw new Error('createCredencialesRouter: middlewares.requerirTOTPEstricto required');
  if (typeof vaultCooldownGuard   !== 'function') throw new Error('createCredencialesRouter: middlewares.vaultCooldownGuard required');

  const repo       = createCredencialesRepo(prisma);
  const service    = createCredencialesService({ repo, auditReq, vaultLastReveal });
  const controller = createCredencialesController({ service, schemas: credencialesSchemas, helpers });

  const router = express.Router();

  // GET list — solo metadata, vault:ver.
  router.get('/credenciales',     verificarJWT, requerirPermiso('vault:ver'),    controller.list);

  // POST create — encrypt + persist, vault:editar.
  router.post('/credenciales',    verificarJWT, requerirPermiso('vault:editar'), controller.create);

  // GET reveal — el endpoint MÁS protegido del sistema:
  //   1. JWT válido.
  //   2. Permiso vault:reveal (separado de vault:ver/editar a propósito).
  //   3. vaultCooldownGuard: 30s entre reveals del mismo user.
  //   4. requerirTOTPEstricto: TOTP en cada reveal (sin excepción).
  router.get('/credenciales/:id/reveal',
    verificarJWT,
    requerirPermiso('vault:reveal'),
    vaultCooldownGuard,
    requerirTOTPEstricto,
    controller.reveal,
  );

  // DELETE — vault:editar (mismo nivel que crear; el delete no expone password).
  router.delete('/credenciales/:id', verificarJWT, requerirPermiso('vault:editar'), controller.remove);

  return router;
}

module.exports = createCredencialesRouter;
