/**
 * backend/modules/crm/activos/router.js
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

function createActivosRouter(deps) {
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
// ─── MSP: CMDB (ActivoCliente) ────────────────────────────────────────────────

const activoSchema = z.object({
  clienteId:        z.string().uuid(),
  productoId:       z.number().int().positive(),
  cantidad:         z.number().int().min(1).default(1),
  fechaInstalacion: z.coerce.date().optional(),
  finGarantia:      z.coerce.date().optional().nullable(),
  numeroSerie:      z.string().max(80).optional().nullable(),
  ubicacion:        z.string().max(150).optional().nullable(),
  notas:            z.string().max(500).optional().nullable(),
})

router.get('/activos-cliente', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
  try {
    const { clienteId } = req.query
    const where = clienteId ? { clienteId } : {}
    const data = await prisma.activoCliente.findMany({
      where,
      include: {
        producto: { select: { id: true, sku: true, nombre: true } },
        orden:    { select: { id: true, noOT: true } },
      },
      orderBy: { fechaInstalacion: 'desc' },
    })
    res.json({ data })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

router.post('/activos-cliente', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
  try {
    const data = activoSchema.parse(req.body)
    const activo = await prisma.activoCliente.create({ data })
    auditReq('cmdb:crear', req, { activoId: activo.id, clienteId: data.clienteId, productoId: data.productoId })
    res.status(201).json(activo)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    if (e.code === 'P2003')      return res.status(400).json({ error: 'Cliente o producto inválido.' })
    console.error('[CMDB CREATE]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.delete('/activos-cliente/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    await prisma.activoCliente.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Activo no encontrado.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})


// ─── ActivoTimeline (historial vida de cada equipo) ──────────────────────────

router.get('/activos-cliente/:id/timeline', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const eventos = await prisma.activoTimeline.findMany({
      where:   { activoId: req.params.id },
      include: { tecnico: { select: { id: true, nombre: true } }, orden: { select: { id: true, noOT: true } } },
      orderBy: { fecha: 'desc' },
      take:    100,
    })
    res.json({ data: eventos })
  } catch { res.json({ data: [], _error: 'Error obteniendo historial.' }) }
})

const timelineEventoSchema = z.object({
  evento:         z.enum(['instalado','reparado','trasladado','retirado','garantia_reclamada','mantenimiento','inspeccion']),
  ordenTrabajoId: z.string().uuid().optional().nullable(),
  notas:          z.string().max(500).optional().nullable(),
})

router.post('/activos-cliente/:id/timeline', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const data = timelineEventoSchema.parse(req.body)
    const ev = await prisma.activoTimeline.create({
      data: {
        activoId:       req.params.id,
        evento:         data.evento,
        tecnicoId:      req.user.sub,
        ordenTrabajoId: data.ordenTrabajoId ?? null,
        notas:          data.notas ?? null,
      },
      include: { tecnico: { select: { id: true, nombre: true } } },
    })
    auditReq('cmdb:timeline', req, { activoId: req.params.id, evento: data.evento })
    res.status(201).json(ev)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})



  return router;
}

module.exports = createActivosRouter;
