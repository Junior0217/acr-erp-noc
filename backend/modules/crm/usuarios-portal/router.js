/**
 * backend/modules/crm/usuarios-portal/router.js
 *
 * Auto-extraido de routes/crm.js (Stage 4 DDD split).
 * Factory recibe deps + helpers compartidos del modulo padre.
 */

const express   = require('express');
const { z }     = require('zod');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const QRCode    = require('qrcode');
const util      = require('util');
const { authenticator } = require('otplib');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');
const { wrapJWT, unwrapJWT, encryptTOTP, decryptTOTP, PORTAL_JWT_SECRET } = require('../../../shared/jwt-crypto');
let archiver = null; try { archiver = require('archiver'); } catch {}

function makeRateLimitStore() { return undefined; }

const stripTags = v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;
const descripcionEstructuradaSchema = z.object({
  v:         z.literal(1),
  titulo:    z.string().min(1).max(200),
  bullets:   z.array(z.string().min(1).max(200)).max(30).default([]),
  imagenUrl: z.string().max(500).nullable().optional(),
});
const descripcionFlexSchema = z.union([
  z.string().max(2000),
  descripcionEstructuradaSchema,
]).nullable().optional();
function descripcionToRaw(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.v === 1) {
    return JSON.stringify({
      v: 1,
      titulo:    String(value.titulo ?? '').slice(0, 200),
      bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
      imagenUrl: value.imagenUrl ? String(value.imagenUrl).slice(0, 500) : null,
    });
  }
  return null;
}

function createUsuariosPortalRouter(deps) {
  const router = express.Router();

  const {
    prisma, auditReq, middlewares = {}, schemas = {}, helpers = {}, limiters = {},
    twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
    generarSiguienteCodigo, generarPdfDeFactura, buildPdfData, subirPdfAlStorage,
    invalidarPdfCache, renderPdfDoc, generarPdfDocumento, persistirVerifyHash,
    facturaVerifyHash, PUBLIC_VERIFY_BASE, emailTransporter, sendFacturaPDF,
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt,
    supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, OT_FOTOS_BUCKET,
    KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
    detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
    signPortalToken, NIVEL_PROPIETARIO_ABSOLUTO, protegerPropietario,
    SECUENCIA_DEFAULTS,
  } = deps;
  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTPEstricto, vaultCooldownGuard,
  } = middlewares;
  const {
    passwordSchema, empleadoSchema, empleadoUpdateSchema, asistenciaSchema,
    clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema,
    prospectoSchema, prospectoUpdateSchema,
  } = schemas;
  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, getClientIp, reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
    nullStr, optIdent, emptyStr, optCedulaRD,
  } = helpers;
  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) =================================
// ─── Usuarios Portal (NOC Admin) ──────────────────────────────────────────────

router.get('/usuarios-portal', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
  try {
    const { search, page = '1', limit = '50' } = req.query;
    const take    = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const where   = {};
    if (search) {
      where.OR = [
        { nombre:    { contains: search, mode: 'insensitive' } },
        { email:     { contains: search, mode: 'insensitive' } },
        { noUsuario: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [usuarios, total] = await Promise.all([
      prisma.usuarioPortal.findMany({
        where,
        select: {
          id: true, noUsuario: true, nombre: true, email: true,
          telefono: true, activo: true, clienteId: true, createdAt: true,
          cliente: { select: { id: true, noCliente: true, razonSocial: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.usuarioPortal.count({ where }),
    ]);
    res.json({ data: usuarios, meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
  } catch (e) {
    console.error('[USUARIOS PORTAL]', e.message);
    res.status(500).json({ error: 'Error interno.' });
  }
});

router.post('/usuarios-portal/:id/vincular', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' });
  const { clienteId } = req.body;
  if (clienteId !== null && !validUUID(clienteId)) return res.status(400).json({ error: 'clienteId inválido.' });
  try {
    if (clienteId) {
      const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });
    }
    const usuario = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { clienteId: clienteId ?? null },
      select: {
        id: true, noUsuario: true, nombre: true, email: true, activo: true, clienteId: true,
        cliente: { select: { id: true, noCliente: true, razonSocial: true } },
      },
    });
    auditReq('portal:vincular', req, { usuarioId: req.params.id, clienteId });
    res.json({ usuario });
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' });
    console.error('[VINCULAR PORTAL]', e.message);
    res.status(500).json({ error: 'Error interno.' });
  }
});




  return router;
}

module.exports = createUsuariosPortalRouter;
