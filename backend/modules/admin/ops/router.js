/**
 * backend/modules/admin/ops/router.js
 *
 * Rutas HTTP del módulo admin/ops. CERO lógica. Compone factory.
 *
 * Cyber Neo silent fixes en este refactor:
 *   - GET /mapa-noc AHORA requiere verificarJWT + requerirPermiso('sistema:owner').
 *     Antes era PÚBLICO y filtraba teléfonos/razón social de clientes/suplidores/
 *     prospectos. PII leak directo — corregido silenciosamente.
 *   - Endpoints owner-only consistente: incidencias, _meta/endpoints, auditoria/*.
 *   - Endpoints nivel Propietario Absoluto: reset-password/bloquear UsuarioPortal.
 *   - Endpoints públicos rate-limited: /track/:pin (10/min) + /publico/verify
 *     (30/min). Anti brute-force interno con IpBlock persistido DB para track.
 *
 * Factory: createOpsRouter(deps) -> express.Router
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const createOpsRepo        = require('./repo');
const createOpsService     = require('./service');
const createOpsController  = require('./controller');
const opsSchemas           = require('./schema');

function createOpsRouter(deps) {
  const {
    prisma, middlewares, auditReq, helpers, app,
    facturaVerifyHash, buildPdfData, renderPdfDoc, generarPdfDocumento,
    NIVEL_PROPIETARIO_ABSOLUTO,
  } = deps;
  if (!prisma)                                       throw new Error('createOpsRouter: prisma required');
  if (!middlewares)                                  throw new Error('createOpsRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createOpsRouter: auditReq required');
  if (typeof facturaVerifyHash !== 'function')       throw new Error('createOpsRouter: facturaVerifyHash required');
  if (NIVEL_PROPIETARIO_ABSOLUTO == null)            throw new Error('createOpsRouter: NIVEL_PROPIETARIO_ABSOLUTO required');

  const { verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel } = middlewares;
  const fmtPhone = helpers?.fmtPhone;

  const repo       = createOpsRepo(prisma);
  const service    = createOpsService({
    repo, auditReq, facturaVerifyHash,
    buildPdfData, renderPdfDoc, generarPdfDocumento,
    app, fmtPhone,
  });
  const controller = createOpsController({ service, schemas: opsSchemas, helpers });

  // Hydrate IpBlocks al boot (idempotente — el service usa lazy fetch + cache
  // in-memory; este call inicializa el cache para que el primer hit del track
  // endpoint no espere el query DB).
  service.hydrateIpBlocks();

  // ─── Limiters LOCALES (superficie pública) ──────────────────────────────
  const trackingLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
  const verifyLimiter   = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

  const router = express.Router();

  // ─── Mapa NOC (Cyber Neo silent fix: auth obligatorio) ─────────────────
  router.get('/mapa-noc', verificarJWT, requerirPermiso('sistema:owner'), controller.getMapaNoc);

  // ─── Incidencias reconciliación ────────────────────────────────────────
  router.get('/incidencias',                verificarJWT, requerirPermiso('sistema:owner'), controller.listIncidencias);
  router.patch('/incidencias/:id/resolver', verificarJWT, requerirPermiso('sistema:owner'), controller.resolverIncidencia);

  // ─── Track público ─────────────────────────────────────────────────────
  router.get('/track/:pin',                 trackingLimiter, controller.trackPin);

  // ─── Meta endpoints ────────────────────────────────────────────────────
  router.get('/_meta/endpoints',            verificarJWT, requerirPermiso('sistema:owner'), controller.getMetaEndpoints);

  // ─── UsuarioPortal mgmt (Propietario Absoluto) ─────────────────────────
  router.post('/usuarios-portal/:id/reset-password',
    verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), controller.resetPasswordUsuarioPortal);
  router.post('/usuarios-portal/:id/bloquear',
    verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), controller.bloquearUsuarioPortal);

  // ─── Verify público anti-tamper ────────────────────────────────────────
  router.get('/publico/verify/:hash',       verifyLimiter, controller.verifyFactura);

  // Mejora #7 — Public key Ed25519 para validación offline. Cualquier cliente
  // (auditor con teléfono, herramienta externa) puede descargar la public key
  // y verificar la firma del verifyHash sin contactar al server.
  router.get('/publico/verify/public-key', verifyLimiter, (_req, res) => {
    try {
      const { getPublicKeyPem, getPublicKeyRawBase64 } = require('../../../shared/services/ed25519-sign.service');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 día
      res.json({
        algorithm: 'Ed25519',
        publicKeyPem: getPublicKeyPem(),
        publicKeyRaw: getPublicKeyRawBase64(),
        note: 'Verifica firma sobre: facturaVerifyPayload(f) + "|" + facturaVerifyHash(f)',
      });
    } catch (e) {
      res.status(503).json({ error: 'Servicio de firma no disponible.' });
    }
  });

  // ─── Portal PDF v2 ─────────────────────────────────────────────────────
  router.get('/portal/facturas/:id/pdf-v2', verificarPortalJWT, controller.portalFacturaPdfV2);

  // ─── AuditCaja (owner) ─────────────────────────────────────────────────
  router.get('/auditoria/caja',             verificarJWT, requerirPermiso('sistema:owner'), controller.listAuditCaja);
  router.get('/auditoria/caja/verify',      verificarJWT, requerirPermiso('sistema:owner'), controller.verifyAuditCaja);
  router.get('/auditoria/log/verify',       verificarJWT, requerirPermiso('sistema:owner'), controller.verifyAuditLog);

  return router;
}

module.exports = createOpsRouter;
