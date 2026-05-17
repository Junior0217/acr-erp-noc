/**
 * backend/modules/crm/prospectos/router.js
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

function createProspectosRouter(deps) {
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
  // ─── Prospectos ───────────────────────────────────────────────────────────
  router.get('/prospectos', async (req, res) => {
    try {
      const { search, estado, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = {};
      if (estado) where.estado = estado;
      if (search) {
        where.OR = [
          { nombre:   { contains: search, mode: 'insensitive' } },
          { telefono: { contains: search, mode: 'insensitive' } },
        ];
      }
      const [prospectos, total] = await Promise.all([
        prisma.prospecto.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.prospecto.count({ where }),
      ]);
      res.json({ data: prospectos.map(formatProspecto), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener prospectos' });
    }
  });

  router.post('/prospectos', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const data = prospectoSchema.parse(req.body);
      res.status(201).json(formatProspecto(await prisma.prospecto.create({ data })));
    } catch {
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/prospectos/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const data = prospectoUpdateSchema.parse(req.body);
      const prospecto = await prisma.prospecto.update({ where: { id: req.params.id }, data });
      res.json(formatProspecto(prospecto));
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Prospecto no encontrado.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.delete('/prospectos/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      await prisma.prospecto.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Prospecto no encontrado.' });
      res.status(500).json({ error: 'Error al eliminar prospecto' });
    }
  });

  router.patch('/prospectos/:id/convertir', verificarJWT, async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const prospecto = await prisma.prospecto.findUnique({ where: { id: req.params.id } });
      if (!prospecto) return res.status(404).json({ error: 'Prospecto no encontrado.' });
      if (prospecto.estado === 'Convertido') return res.status(409).json({ error: 'Prospecto ya fue convertido.' });

      const count = await prisma.cliente.count({ where: { deletedAt: null } });
      const noCliente = `CLI-${String(count + 1).padStart(4, '0')}`;

      const resultado = await prisma.$transaction(async (tx) => {
        const cliente = await tx.cliente.create({
          data: {
            noCliente,
            razonSocial:       prospecto.nombre,
            telefonoPrincipal: prospecto.telefono,
            latitud:           prospecto.latitud  ?? undefined,
            longitud:          prospecto.longitud ?? undefined,
            notas:             prospecto.notas    ?? undefined,
            tipoCliente:       'Residencial',
          },
        });
        const updated = await tx.prospecto.update({
          where: { id: req.params.id },
          data:  { estado: 'Convertido' },
        });
        return { cliente, prospecto: updated };
      });

      res.json({
        cliente:   formatCliente(resultado.cliente),
        prospecto: formatProspecto(resultado.prospecto),
      });
    } catch (error) {
      console.error('[CONVERTIR PROSPECTO]', error.message);
      res.status(500).json({ error: 'Error al convertir prospecto' });
    }
  });




  return router;
}

module.exports = createProspectosRouter;
