/**
 * backend/modules/crm/credenciales/router.js
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

function createCredencialesRouter(deps) {
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
    esPropietarioAbsoluto, } = middlewares;
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
// ─── MSP: Bóveda de Credenciales (PAM) ────────────────────────────────────────

const credencialSchema = z.object({
  clienteId: z.string().uuid(),
  tipo:      z.enum(['Router','Switch','AccessPoint','NVR','DVR','Camara','Server','Firewall','ControlAcceso','Otro']),
  nombre:    z.string().min(1).max(100),
  ip:        z.string().max(60).optional().nullable(),
  usuario:   z.string().min(1).max(80),
  password:  z.string().min(1).max(500),
  notas:     z.string().max(500).optional().nullable(),
})

router.get('/credenciales', verificarJWT, requerirPermiso('vault:ver'), async (req, res) => {
  try {
    const { clienteId } = req.query
    const where = clienteId ? { clienteId } : {}
    const data = await prisma.credencialCliente.findMany({
      where,
      select: { id: true, clienteId: true, tipo: true, nombre: true, ip: true, usuario: true, notas: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ data })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// Vault hardening: TOTP estricto (no opcional) + cooldown global por usuario + bulk alert.
const VAULT_COOLDOWN_MS    = 30_000
const VAULT_BULK_THRESHOLD = 5            // > 5 reveals/hora del mismo user = alerta
const VAULT_BULK_WINDOW_MS = 60 * 60_000
const _vaultLastReveal     = new Map()    // userId -> timestamp ms
const _vaultBulkTally      = new Map()    // userId -> [timestamps ms]

async function requerirTOTPEstricto(req, res, next) {
  try {
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorEnabled: true, twoFactorSecret: true } })
    if (!emp?.twoFactorEnabled || !emp?.twoFactorSecret) {
      return res.status(422).json({ error: 'Activa 2FA primero. La bóveda PAM exige TOTP en cada revelación.', code: 'TOTP_NOT_CONFIGURED' })
    }
    const code = req.headers['x-totp'] || req.body?.totp
    if (!code) return res.status(403).json({ error: 'Código TOTP requerido en header X-TOTP.', code: 'TOTP_REQUIRED' })
    const secret = decryptTOTP(emp.twoFactorSecret)
    if (!authenticator.verify({ token: String(code), secret })) {
      auditReq('vault:totp_invalid', req, { credencialId: req.params.id }, { userId: req.user.sub })
      return res.status(401).json({ error: 'Código TOTP inválido o expirado.', code: 'TOTP_INVALID' })
    }
    next()
  } catch (e) {
    console.error('[TOTP ESTRICTO]', e.message)
    res.status(500).json({ error: 'Error verificando 2FA.' })
  }
}

function vaultCooldownGuard(req, res, next) {
  const uid  = req.user.sub
  const now  = Date.now()
  const last = _vaultLastReveal.get(uid) ?? 0
  const wait = VAULT_COOLDOWN_MS - (now - last)
  if (wait > 0) {
    return res.status(429).json({
      error:        `Cool-down activo. Espera ${Math.ceil(wait / 1000)}s antes de otra revelación.`,
      code:         'VAULT_COOLDOWN',
      retryAfterMs: wait,
    })
  }
  next()
}

async function detectarBulkReveal(req) {
  const uid = req.user.sub
  const now = Date.now()
  const arr = (_vaultBulkTally.get(uid) ?? []).filter(t => now - t < VAULT_BULK_WINDOW_MS)
  arr.push(now)
  _vaultBulkTally.set(uid, arr)
  if (arr.length > VAULT_BULK_THRESHOLD) {
    // Solo alerta una vez por ventana (cuando cruzamos el umbral)
    if (arr.length === VAULT_BULK_THRESHOLD + 1) {
      auditReq('vault:bulk_reveal_alert', req, { count: arr.length, ventanaMin: 60 }, { userId: uid })
      try {
        await prisma.incidenciaReconciliacion.create({
          data: {
            tipo:        'BULK_VAULT_REVEAL',
            severidad:   'CRITICA',
            descripcion: `Usuario ${req.user.nombre} reveló > ${VAULT_BULK_THRESHOLD} credenciales en 60 min (${arr.length} totales). Posible exfiltración masiva.`,
            datos:       { userId: uid, nombre: req.user.nombre, count: arr.length, ip: req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress },
            asignadoA:   uid,
          },
        })
      } catch (e) { console.error('[BULK ALERT INSERT]', e.message) }
    }
  }
}

router.post('/credenciales', verificarJWT, requerirPermiso('vault:editar'), async (req, res) => {
  try {
    const data = credencialSchema.parse(req.body)
    if (!VAULT_KEY) return res.status(503).json({ error: 'Vault deshabilitado (VAULT_KEY no configurada).' })
    const { passwordEnc, passwordIv } = vaultEncrypt(data.password)
    const credencial = await prisma.credencialCliente.create({
      data: {
        clienteId: data.clienteId, tipo: data.tipo, nombre: data.nombre,
        ip: data.ip ?? null, usuario: data.usuario, passwordEnc, passwordIv, notas: data.notas ?? null,
      },
      select: { id: true, clienteId: true, tipo: true, nombre: true, ip: true, usuario: true, notas: true, createdAt: true },
    })
    auditReq('vault:crear', req, { credencialId: credencial.id, clienteId: data.clienteId, tipo: data.tipo })
    res.status(201).json(credencial)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    if (e.code === 'P2003')      return res.status(400).json({ error: 'Cliente no encontrado.' })
    console.error('[VAULT CREATE]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.get(
  '/credenciales/:id/reveal',
  verificarJWT,
  requerirPermiso('vault:reveal'),
  vaultCooldownGuard,
  requerirTOTPEstricto,
  async (req, res) => {
    if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
    try {
      const c = await prisma.credencialCliente.findUnique({ where: { id: req.params.id } })
      if (!c) return res.status(404).json({ error: 'Credencial no encontrada.' })
      const password = vaultDecrypt(c.passwordEnc, c.passwordIv)
      _vaultLastReveal.set(req.user.sub, Date.now())
      auditReq('vault:reveal', req, { credencialId: c.id, clienteId: c.clienteId, tipo: c.tipo, nombre: c.nombre })
      // Async fire-and-forget: detect bulk exfil, no await
      detectarBulkReveal(req).catch(e => console.error('[BULK DETECT]', e.message))
      res.json({ password })
    } catch (e) {
      console.error('[VAULT REVEAL]', e.message)
      res.status(500).json({ error: 'Error al descifrar.' })
    }
  }
)

router.delete('/credenciales/:id', verificarJWT, requerirPermiso('vault:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    await prisma.credencialCliente.delete({ where: { id: req.params.id } })
    auditReq('vault:eliminar', req, { credencialId: req.params.id })
    res.status(204).end()
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Credencial no encontrada.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})




  return router;
}

module.exports = createCredencialesRouter;
