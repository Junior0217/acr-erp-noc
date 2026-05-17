/**
 * backend/modules/crm/clientes/router.js
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

function createClientesRouter(deps) {
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
  // ─── Existing handlers ───────────────────────────────────────────
  router.get('/clientes', async (req, res) => {
    try {
      const { search, activo, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = { deletedAt: null };
      if (activo !== undefined) where.activo = activo === 'true';
      if (search) {
        where.OR = [
          { razonSocial:    { contains: search, mode: 'insensitive' } },
          { rnc:            { contains: search, mode: 'insensitive' } },
          { noCliente:      { contains: search, mode: 'insensitive' } },
          { nombreContacto: { contains: search, mode: 'insensitive' } },
        ];
      }
      const [clientes, total] = await Promise.all([
        prisma.cliente.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.cliente.count({ where }),
      ]);
      res.json({ data: clientes.map(formatCliente), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener clientes' });
    }
  });

  router.post('/clientes', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const { prospectoOrigenId, ...body } = req.body;
      const data = clienteSchema.parse(body);
      const cliente = await prisma.$transaction(async (tx) => {
        if (!data.noCliente) data.noCliente = await generarSiguienteCodigo('cliente', tx);
        const c = await tx.cliente.create({ data });
        if (prospectoOrigenId) {
          if (!validUUID(prospectoOrigenId)) throw Object.assign(new Error('prospectoOrigenId inválido.'), { status: 400 });
          await tx.prospecto.update({ where: { id: prospectoOrigenId }, data: { estado: 'Convertido' } });
        }
        return c;
      });
      res.status(201).json(formatCliente(cliente));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de cliente ya existe.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/clientes/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const data = clienteUpdateSchema.parse(req.body);
      const cliente = await prisma.cliente.update({ where: { id: req.params.id }, data });
      res.json(formatCliente(cliente));
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Cliente no encontrado.' });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC ya existe en otro registro.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.delete('/clientes/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const existing = await prisma.cliente.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Cliente no encontrado.' });
      await prisma.cliente.update({
        where: { id: req.params.id },
        data: { activo: false, deletedAt: new Date() },
      });
      auditReq('crm:cliente_eliminado', req, { clienteId: req.params.id });
      res.status(204).end();
    } catch {
      res.status(500).json({ error: 'Error al eliminar cliente.' });
    }
  });

  router.patch('/clientes/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const current = await prisma.cliente.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Cliente no encontrado.' });
      const updated = await prisma.cliente.update({
        where: { id: req.params.id },
        data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
      });
      res.json(formatCliente(updated));
    } catch {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  });




  return router;
}

module.exports = createClientesRouter;
