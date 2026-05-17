/**
 * backend/modules/crm/suplidores/router.js
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

function createSuplidoresRouter(deps) {
  const router = express.Router();

  const {
    prisma, auditReq, middlewares = {}, schemas = {}, helpers = {}, limiters = {},
    completarLogin, twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
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
  // ─── Suplidores ───────────────────────────────────────────────────────────
  router.get('/suplidores', async (req, res) => {
    try {
      const { search, activo, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = {};
      if (activo !== undefined) where.activo = activo === 'true';
      if (search) {
        where.OR = [
          { razonSocial:    { contains: search, mode: 'insensitive' } },
          { rnc:            { contains: search, mode: 'insensitive' } },
          { noSuplidor:     { contains: search, mode: 'insensitive' } },
          { nombreContacto: { contains: search, mode: 'insensitive' } },
        ];
      }
      const [suplidores, total] = await Promise.all([
        prisma.suplidor.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.suplidor.count({ where }),
      ]);
      res.json({ data: suplidores.map(formatSuplidor), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener suplidores' });
    }
  });

  router.post('/suplidores', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const data = suplidorSchema.parse(req.body);
      res.status(201).json(formatSuplidor(await prisma.suplidor.create({ data })));
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de suplidor ya existe.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/suplidores/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const data = suplidorUpdateSchema.parse(req.body);
      const suplidor = await prisma.suplidor.update({ where: { id: req.params.id }, data });
      res.json(formatSuplidor(suplidor));
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Suplidor no encontrado.' });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC ya existe en otro registro.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.patch('/suplidores/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const current = await prisma.suplidor.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Suplidor no encontrado.' });
      const updated = await prisma.suplidor.update({
        where: { id: req.params.id },
        data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
      });
      res.json(formatSuplidor(updated));
    } catch {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  });




  return router;
}

module.exports = createSuplidoresRouter;
