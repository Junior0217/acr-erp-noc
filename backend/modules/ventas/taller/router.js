/**
 * backend/modules/ventas/taller/router.js
 *
 * Auto-extraido de routes/ventas.js (Stage 4 split DDD).
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


function createTallerRouter(deps) {
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
    nextNomenclatura, buildFacturaPDFBuffer,
  } = deps;
  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTPEstricto, vaultCooldownGuard,
  } = middlewares;
  const {
    passwordSchema, empleadoSchema, asistenciaSchema,
    clienteSchema, suplidorSchema, prospectoSchema,
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

  // === ROUTES (extraidas del monolito) ==================================
// ─── MSP: Taller (TicketTaller / RMA) ─────────────────────────────────────────

const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generarPin() {
  let pin = ''
  for (let i = 0; i < 6; i++) pin += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)]
  return pin
}

const ticketTallerSchema = z.object({
  clienteId:     z.string().uuid(),
  tecnicoId:     z.number().int().optional().nullable(),
  equipo:        z.string().min(1).max(150),
  marca:         z.string().max(80).optional().nullable(),
  modelo:        z.string().max(80).optional().nullable(),
  numeroSerie:   z.string().max(80).optional().nullable(),
  falla:         z.string().min(1).max(1000),
  notas:         z.string().max(1000).optional().nullable(),
  costoEstimado: z.coerce.number().nonnegative().optional().nullable(),
})

const ticketEstadoSchema = z.object({
  estado:       z.enum(['Recibido','Diagnostico','EsperandoPieza','Listo','Entregado','Cancelado']),
  diagnostico:  z.string().max(2000).optional().nullable(),
  costoEstimado: z.coerce.number().nonnegative().optional().nullable(),
  notas:        z.string().max(1000).optional().nullable(),
})

router.get('/taller', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
  try {
    const { estado, search } = req.query
    const where = {}
    if (estado) where.estado = estado
    if (search) where.OR = [
      { noTicket:    { contains: search, mode: 'insensitive' } },
      { codigoPin:   { contains: search, mode: 'insensitive' } },
      { equipo:      { contains: search, mode: 'insensitive' } },
      { numeroSerie: { contains: search, mode: 'insensitive' } },
    ]
    const tickets = await prisma.ticketTaller.findMany({
      where,
      include: {
        cliente: { select: { id: true, noCliente: true, razonSocial: true, telefonoPrincipal: true } },
        tecnico: { select: { id: true, nombre: true } },
      },
      orderBy: { recibidoEn: 'desc' },
      take: 200,
    })
    res.json({ data: tickets })
  } catch (e) {
    console.error('[TALLER LIST]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.post('/taller', verificarJWT, requerirPermiso('ot:crear'), async (req, res) => {
  try {
    const data = ticketTallerSchema.parse(req.body)
    let pin, intento = 0
    while (intento < 5) {
      pin = generarPin()
      const colide = await prisma.ticketTaller.findUnique({ where: { codigoPin: pin } })
      if (!colide) break
      intento++
    }
    if (intento >= 5) return res.status(503).json({ error: 'No se pudo generar PIN único. Reintenta.' })
    const ticket = await prisma.$transaction(async (tx) => {
      // Auto-secuenciador centralizado: prefijo + número configurables por owner.
      const noTicket = await generarSiguienteCodigo('rma', tx)
      return tx.ticketTaller.create({
        data: { ...data, noTicket, codigoPin: pin },
        include: { cliente: { select: { razonSocial: true } } },
      })
    })
    auditReq('taller:crear', req, { ticketId: ticket.id, clienteId: data.clienteId })
    res.status(201).json(ticket)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    if (e.code === 'P2003')     return res.status(400).json({ error: 'Cliente no encontrado.' })
    console.error('[TALLER CREATE]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

const ESTADOS_FINALES_TALLER = new Set(['Entregado', 'Cancelado'])

async function bloquearSiTallerFinal(id) {
  const prev = await prisma.ticketTaller.findUnique({ where: { id }, select: { estado: true } })
  if (!prev) return { status: 404, error: 'Ticket no encontrado.' }
  if (ESTADOS_FINALES_TALLER.has(prev.estado)) return { status: 423, error: `Ticket ${prev.estado}. Datos inmutables.` }
  return null
}

router.patch('/taller/:id/estado', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  const bloqueo = await bloquearSiTallerFinal(req.params.id)
  if (bloqueo) return res.status(bloqueo.status).json({ error: bloqueo.error })
  try {
    const data = ticketEstadoSchema.parse(req.body)
    const update = { estado: data.estado }
    if (data.diagnostico  != null) update.diagnostico  = data.diagnostico
    if (data.costoEstimado != null) update.costoEstimado = data.costoEstimado
    if (data.notas        != null) update.notas        = data.notas
    const now = new Date()
    if (data.estado === 'Diagnostico' && !update.diagnosticadoEn) update.diagnosticadoEn = now
    if (data.estado === 'Listo')       update.listoEn      = now
    if (data.estado === 'Entregado')   update.entregadoEn  = now
    const ticket = await prisma.ticketTaller.update({ where: { id: req.params.id }, data: update })
    auditReq('taller:estado', req, { ticketId: ticket.id, estado: ticket.estado })
    res.json(ticket)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    if (e.code === 'P2025')      return res.status(404).json({ error: 'Ticket no encontrado.' })
    console.error('[TALLER ESTADO]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.patch('/taller/:id', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  const bloqueo = await bloquearSiTallerFinal(req.params.id)
  if (bloqueo) return res.status(bloqueo.status).json({ error: bloqueo.error })
  try {
    const data = ticketTallerSchema.partial().parse(req.body)
    const ticket = await prisma.ticketTaller.update({ where: { id: req.params.id }, data })
    res.json(ticket)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    if (e.code === 'P2025')      return res.status(404).json({ error: 'Ticket no encontrado.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.patch('/taller/:id/reabrir', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const prev = await prisma.ticketTaller.findUnique({ where: { id: req.params.id }, select: { estado: true } })
    if (!prev) return res.status(404).json({ error: 'Ticket no encontrado.' })
    if (!ESTADOS_FINALES_TALLER.has(prev.estado)) return res.status(409).json({ error: 'Ticket no está en estado final.' })
    const t = await prisma.ticketTaller.update({
      where: { id: req.params.id },
      data:  { estado: 'Diagnostico', entregadoEn: null },
    })
    auditReq('taller:reabrir', req, { ticketId: t.id, estadoPrevio: prev.estado })
    res.json(t)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// Public tracking by PIN (no auth, no leaks of clienteId)



  return router;
}

module.exports = createTallerRouter;
