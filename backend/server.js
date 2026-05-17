require('dotenv').config();
console.log('[RENDER SYNC] Backend API v2.1 started — Prisma Client regenerated');
const util         = require('util');
const fs           = require('fs');
const path         = require('path');
const express      = require('express');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const { z }        = require('zod');
const { PrismaClient } = require('@prisma/client');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const { authenticator } = require('otplib');
const QRCode       = require('qrcode');
const cron         = require('node-cron');
const PDFDocument  = require('pdfkit');
const nodemailer   = require('nodemailer');
const multer       = require('multer');
const sharp        = require('sharp');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const { generarPdfDocumento, inlineAssets } = require('./services/pdf-generator');
const { renderDocumento: renderPdfDoc } = require('./services/pdf-templates');
const PERMISSIONS_MAP  = require('./shared/permissions.map.js');
const { syncMikrotik } = require('./services/mikrotik');

// ─── Refactor modular (Stage 1) ───────────────────────────────────────────────
// shared/ contiene helpers, schemas, jwt-crypto y la factory de middlewares
// reusables por backend/routes/*.js. server.js sigue siendo el orquestador:
// inicializa Prisma, configura Express+CORS+rate-limit+CRON, monta los routers
// y arranca el server. Los handlers legacy permanecen inline hasta migrarse
// router-por-router; mientras tanto Express usa el PRIMER match registrado,
// así que las definiciones inline ganan sobre los stubs de routes/.
const createMiddlewares      = require('./shared/middlewares');
const sharedSchemas          = require('./shared/schemas');
const sharedHelpers          = require('./shared/helpers');
const { wrapJWT, unwrapJWT, encryptTOTP, decryptTOTP, PORTAL_JWT_SECRET }
  = require('./shared/jwt-crypto');
const createAuditService      = require('./shared/services/audit.service');
const createSequencesService  = require('./shared/services/sequences.service');
const createVerifyHashService = require('./shared/services/verify-hash.service');
// Helpers + Schemas destructurados al scope global para que los handlers legacy
// inline que aún viven en server.js sigan funcionando sin tocarlos uno por uno.
// A medida que cada handler migre a routes/*.js, esta lista se irá vaciando.
const {
  UUID_RE, validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
  emptyStr, nullStr, optIdent, optCedulaRD, fmtPhone, fmtCedula, fmtRNC,
  formatCliente, formatSuplidor, formatProspecto, reqFingerprint,
  computeDeviceHash, labelFromUA, _stripPollutionKeys, bodyLimit, getClientIp,
} = sharedHelpers;
const {
  passwordSchema, empleadoSchema, empleadoUpdateSchema, asistenciaSchema,
  clienteBaseShape, clienteSchema, clienteUpdateSchema,
  suplidorBaseShape, suplidorSchema, suplidorUpdateSchema,
  prospectoSchema, prospectoUpdateSchema,
  portalRegisterSchema, portalLoginSchema, credencialSchema, activoSchema,
  prestamoSchema, ticketTallerSchema, ticketEstadoSchema, ordenFotoSchema,
  timelineEventoSchema, checkoutSchema, azulWebhookSchema,
} = sharedSchemas;
// Infra extraida — Supabase storage helpers + CRON jobs nocturnos.
const SUPA_INFRA = require('./shared/infra/supabase');
const {
  supabase, SUPABASE_BUCKET, INVENTORY_BUCKET,
  KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
  esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
  detectMimeFromBuffer, svgSeguro, comprimirImagen,
} = SUPA_INFRA;
const startCronJobs = require('./jobs/cron');
const createAuthRouter       = require('./modules/auth/router');
const createCrmRouter        = require('./routes/crm');
const createInventarioRouter = require('./routes/inventario');
const createVentasRouter     = require('./routes/ventas');
const createAdminRouter      = require('./routes/admin');
const Redis            = (() => { try { return require('ioredis') } catch { return null } })()
const { RedisStore }   = (() => { try { return require('rate-limit-redis') } catch { return {} } })()

let redisClient = null
if (process.env.REDIS_URL && Redis) {
  redisClient = new Redis(process.env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false })
  redisClient.on('error', err => console.warn('[REDIS]', err.message))
  console.log('[REDIS] Client configured')
}

function makeRateLimitStore() {
  if (!redisClient || !RedisStore) return undefined
  return new RedisStore({ sendCommand: (...args) => redisClient.call(...args) })
}

// ─── Sentry (descomenta en producción: npm install @sentry/node) ──────────────
// const Sentry = require('@sentry/node')
// Sentry.init({
//   dsn: process.env.SENTRY_DSN,
//   environment: process.env.NODE_ENV || 'development',
//   tracesSampleRate: 0.1,
// })

// ─── Email (nodemailer) ───────────────────────────────────────────────────────

const emailTransporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
})

async function sendFacturaPDF(factura, pdfBuffer) {
  if (!process.env.SMTP_USER || !factura.cliente?.email) return
  try {
    await emailTransporter.sendMail({
      from:        `"ACR Networks" <${process.env.SMTP_USER}>`,
      to:          factura.cliente.email,
      subject:     `Factura ${factura.noFactura} — ACR Networks & Solutions`,
      html: `<p>Estimado/a <strong>${factura.cliente.razonSocial}</strong>,</p>
             <p>Adjuntamos su factura <strong>${factura.noFactura}</strong> (NCF: ${factura.ncf}) por un total de <strong>RD$ ${Number(factura.total).toLocaleString('es-DO', { minimumFractionDigits: 2 })}</strong>.</p>
             <p>Fecha de vencimiento: ${factura.fechaVence ? new Date(factura.fechaVence).toLocaleDateString('es-DO') : '—'}</p>
             <p>Gracias por su preferencia.<br><em>ACR Networks & Solutions</em></p>`,
      attachments: [{ filename: `factura-${factura.noFactura}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }],
    })
    console.log(`[EMAIL] Factura ${factura.noFactura} enviada a ${factura.cliente.email}`)
  } catch (err) {
    console.error(`[EMAIL] Error enviando a ${factura.cliente.email}:`, err.message)
  }
}

// ─── JWE-equivalent: AES-256-GCM wrappers viven en shared/jwt-crypto.js ───────

// ─── 2FA temp token store (TTL 5 min, one-time use) ──────────────────────────
const twoFAStore = new Map()
setInterval(() => { const n = Date.now(); for (const [k,v] of twoFAStore) if (v.exp < n) twoFAStore.delete(k) }, 5 * 60_000)

// ─── Dashboard cache (in-memory, 60 s TTL) ────────────────────────────────────
let dashCache    = null
let dashCacheExp = 0

// ─── Ephemeral RSA challenge store (TTL 2 min, one-time use) ─────────────────
const challengeStore = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [cid, e] of challengeStore) if (e.exp < now) challengeStore.delete(cid)
}, 5 * 60_000)

// AuditLog is append-only. This extension blocks all mutations at the ORM layer.
// The only permitted write path is prisma.auditLog.create (and $executeRaw for retention cleanup).
const prismaBase = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
prismaBase.$on('query', e => {
  if (e.duration > 500) console.warn(`[SLOW QUERY] ${e.duration}ms — ${e.query.slice(0, 200)}`)
})
const prisma = prismaBase.$extends({
  query: {
    auditLog: {
      update:     () => { throw new Error('AuditLog es inmutable: update no permitido.') },
      updateMany: () => { throw new Error('AuditLog es inmutable: updateMany no permitido.') },
      delete:     () => { throw new Error('AuditLog es inmutable: delete no permitido.') },
      deleteMany: () => { throw new Error('AuditLog es inmutable: deleteMany no permitido.') },
    },
  },
});

// ─── Core services (audit / sequences / verify-hash) ─────────────────────────
// Factories que cierran sobre el prisma extendido. AuditLog ORM-immutable via
// $extends arriba: solo prisma.auditLog.create + $executeRaw (retención) escriben.
const { _canonicalizarLog, appendAuditLog, auditReq } = createAuditService({ prisma });
const { SECUENCIA_DEFAULTS, generarSiguienteCodigo }  = createSequencesService({ prisma });
const { _normStr, _normMoney, _normDateYMD, facturaVerifyHash, persistirVerifyHash }
  = createVerifyHashService({ prisma });

// ─── Middlewares (shared/middlewares.js factory) ──────────────────────────────
// auditReq se inyecta para que verificarJWT/protegerPropietario puedan loguear
// eventos sin acoplarse a la implementación. Destructuramos al scope global
// para que los handlers legacy inline sigan refiriéndose a `verificarJWT` etc.
const _sharedMw = createMiddlewares({ prisma, auditReq });
const {
  NIVEL_PROPIETARIO_ABSOLUTO,
  verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
  esPropietarioAbsoluto, protegerPropietario, requerirTOTP,
  requerirTOTPEstricto, vaultCooldownGuard,
} = _sharedMw;

// Rolling 12-month retention cleanup (raw SQL bypasses the ORM immutability guard intentionally)
setInterval(async () => {
  try {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12)
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "creadoEn" < ${cutoff}`
  } catch {}
}, 24 * 60 * 60_000)

const app = express();

// CSP baseline: API responds JSON pero también sirve imágenes/PDFs de OrdenFoto,
// y los headers viajan al frontend. Política permisiva para activos legítimos.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'"],
      styleSrc:        ["'self'", "'unsafe-inline'"], // Tailwind inline + React style
      imgSrc:          ["'self'", "data:", "blob:", "https://*.supabase.co", "https://placehold.co"],
      connectSrc:      ["'self'"],
      fontSrc:         ["'self'", "data:"],
      objectSrc:       ["'none'"],
      mediaSrc:        ["'self'"],
      frameSrc:        ["'none'"],
      formAction:      ["'self'"],
      frameAncestors:  ["'none'"],     // anti-clickjacking
      baseUri:         ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 15552000, includeSubDomains: true, preload: false }
    : false,
  crossOriginOpenerPolicy:    { policy: 'same-origin' },
  crossOriginResourcePolicy:  { policy: 'cross-origin' },
  crossOriginEmbedderPolicy:  false,
  referrerPolicy:             { policy: 'strict-origin-when-cross-origin' },
}));
app.use(cookieParser(process.env.COOKIE_SECRET));

// ─── NAMESPACE ALIASES (REGLA: zero break — handlers existentes via rewrite) ──
// /api/ventas/*, /api/crm/*, /api/servicios/*, /api/inventario/*, /api/taller/*
// se mapean al handler legacy correspondiente. Frontend puede migrar gradual;
// el viejo path sigue funcionando para no romper integraciones.
const NAMESPACE_REWRITES = {
  // CRM
  '/api/crm/clientes':         '/api/clientes',
  '/api/crm/suplidores':       '/api/suplidores',
  '/api/crm/prospectos':       '/api/prospectos',
  '/api/crm/usuarios-portal':  '/api/usuarios-portal',
  '/api/crm/credenciales':     '/api/credenciales',
  '/api/crm/activos-cliente':  '/api/activos-cliente',
  // Ventas
  '/api/ventas/ordenes':       '/api/ordenes',
  '/api/ventas/facturas':      '/api/facturas',
  '/api/ventas/cotizaciones':  '/api/cotizaciones',
  '/api/ventas/items-catalogo':'/api/items-catalogo',
  // Servicios
  '/api/servicios/planes':     '/api/planes',
  '/api/servicios/ordenes':    '/api/ordenes-instalacion',
  // Inventario
  '/api/inventario/productos':   '/api/productos',
  '/api/inventario/categorias':  '/api/categorias',
  '/api/inventario/kardex':      '/api/movimientos',
  '/api/inventario/movimientos': '/api/movimientos',
  '/api/inventario/prestamos':   '/api/prestamos',
  // Taller
  '/api/taller/tickets':       '/api/taller',
}

app.use((req, res, next) => {
  for (const [alias, real] of Object.entries(NAMESPACE_REWRITES)) {
    if (req.url === alias || req.url.startsWith(alias + '/') || req.url.startsWith(alias + '?')) {
      req.url = real + req.url.slice(alias.length)
      break
    }
  }
  next()
})

const DEV_ORIGINS     = ['http://localhost:5173', 'http://127.0.0.1:5173']
const PROD_ORIGINS    = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean)
const CORS_WILDCARD   = process.env.NODE_ENV !== 'production' && (PROD_ORIGINS.includes('*') || PROD_ORIGINS.length === 0)
const ALLOWED_ORIGINS = new Set([...DEV_ORIGINS, ...PROD_ORIGINS.filter(o => o !== '*')])

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (CORS_WILDCARD) return cb(null, true)
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    console.warn(`[CORS BLOCKED] ${origin}. Set CORS_ORIGIN env var on Render.`)
    cb(new Error(`CORS: origen no permitido → ${origin}`))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders:  ['Content-Type', 'Authorization', 'Accept', 'X-CSRF-Token'],
  exposedHeaders:  ['X-CSRF-Token', 'X-App-Version', 'X-Boot-At'],
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// reqFingerprint vive en shared/helpers.js — SHA-256(IP + UA) mitiga NAT-collision
// en buckets de rate-limit. /api/health DEBE ir antes del limiter global — Render
// lo golpea cada 30s y con 200 req/15min se agotaba la cuota en pruebas de carga
// ligera → 429. Sin rate-limit aquí; queda como liveness probe puro.
// y con 200 req/15min se agotaba la cuota en pruebas de carga ligera -> 429.
// Sin rate-limit aquí; queda como liveness probe puro.
// Versión de la app: se computa al boot y se sirve en /api/health + header
// X-App-Version en cada respuesta. El frontend compara y dispara recarga si
// detecta drift entre el bundle cacheado y el backend desplegado.
const APP_VERSION = (process.env.APP_VERSION
  || process.env.RENDER_GIT_COMMIT?.slice(0, 7)
  || `local-${Date.now()}`).trim()
const APP_BOOT_AT = Date.now()
console.log(`[VERSION] APP_VERSION=${APP_VERSION} boot=${new Date(APP_BOOT_AT).toISOString()}`)

// Middleware: inyecta X-App-Version + X-Boot-At en TODAS las /api/*. Cheap.
// Además: respuestas JSON de la API NUNCA deben quedar en cache del browser
// ni de proxies intermedios — un response cacheado con permisos viejos podría
// servir datos stale tras un cambio de rol o un re-deploy. Las imágenes /
// PDFs binarios que pasan por endpoints separados ponen su propio Cache-Control.
app.use('/api/', (req, res, next) => {
  res.setHeader('X-App-Version', APP_VERSION)
  res.setHeader('X-Boot-At',     String(APP_BOOT_AT))
  // Por defecto: no cachear nada del API. Endpoints que sí permitan cache
  // (PDFs servidos desde Supabase, /api/health, etc) sobrescriben esto explícito.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  next()
})

app.get('/api/health', async (req, res) => {
  let dbConnected = false
  try { await prisma.$queryRaw`SELECT 1`; dbConnected = true } catch (_) {}
  res.json({
    status: 'ok',
    version: APP_VERSION,
    bootAt: APP_BOOT_AT,
    timestamp: Date.now(),
    dbConnected,
    uptime: Math.floor(process.uptime()),
  })
})

// /api/auth/challenge genera RSA cryptochallenge para login. Es idempotente y
// no expone PII. IPs con NAT (oficinas) gastaban cuota global -> 429 al primer
// usuario. Se exime del limiter global; loginLimiter cubre el abuso real (login).
const RATE_LIMIT_SKIP = new Set(['/api/health', '/api/auth/challenge', '/api/auth/csrf'])

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,                          // Subido de 200 → 500 (margen NAT)
  keyGenerator: reqFingerprint,      // fingerprint = ip+UA hash (mitiga NAT)
  store: makeRateLimitStore(),
  skip: (req) => RATE_LIMIT_SKIP.has(req.path),
  message: { error: 'Demasiadas peticiones, intente de nuevo más tarde.' }
});
app.use('/api/', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: reqFingerprint,
  store: makeRateLimitStore(),
  message: { error: 'Demasiados intentos. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
});

const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: reqFingerprint,
  store: makeRateLimitStore(),
  message: { error: 'Demasiados intentos de PIN. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
});

// H7: limitador AISLADO para backup codes — más estricto que totpLimiter porque
// los códigos no rotan automáticamente y son objetivo prioritario de brute-force.
// 3 intentos por hora por fingerprint; sí cuenta los exitosos (para evitar enum).
const backupCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: reqFingerprint,
  store: makeRateLimitStore(),
  message: { error: 'Demasiados intentos con código de respaldo. Intente en 1 hora.' },
  skipSuccessfulRequests: false,
});

const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.sub ? `billing:${req.user.sub}` : reqFingerprint(req),
  store: makeRateLimitStore(),
  message: { error: 'Límite de operaciones de facturación alcanzado. Intente en 1 minuto.' },
});

// uploadLimiter + uploadMulter: declarados aquí (con el resto de limiters globales)
// para evitar TDZ. Antes vivían junto a las rutas de upload (~línea 2780) pero
// endpoints nuevos los referencian en líneas anteriores -> ReferenceError al boot.
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
const uploadMulter  = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024 },     // 2MB
})

// ─── Security: CSP nonce dinámico + Trusted Types header inyectado por request
// Nonce SHA-256 truncado (24 chars). El frontend lee res.locals.cspNonce si fuera
// SSR. Para SPA estática es información para que el navegador rechace scripts
// inline no marcados con este nonce.
function cspNonceMiddleware(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(18).toString('base64url')
  next()
}
app.use(cspNonceMiddleware)
app.use((req, res, next) => {
  const nonce = res.locals.cspNonce
  // CSP relativamente estricta — preserva 'unsafe-inline' solo en style por Tailwind compilado.
  // Para producción full-strict: precompila Tailwind y elimina unsafe-inline aquí también.
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; ` +
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data: blob: https:; ` +
    `font-src 'self' data:; ` +
    `connect-src 'self' https://*.supabase.co https:; ` +
    `frame-ancestors 'none'; ` +
    `base-uri 'self'; ` +
    `object-src 'none'; ` +
    `require-trusted-types-for 'script'`
  )
  // Hardening adicional (OWASP):
  //  Permissions-Policy: cierra puerta a APIs sensibles del browser que la app
  //    no usa. Si en el futuro un XSS lograra inyectar JS, no podría activar
  //    cámara/mic/geolocation/USB/payment ni en iframes embebidos.
  //  X-Permitted-Cross-Domain-Policies: 'none' bloquea legacy Adobe Flash/PDF
  //    cross-domain policies. Cero impacto operacional, cierra vector AS-CDP.
  res.setHeader('Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), ' +
    'encrypted-media=(), fullscreen=(self), geolocation=(self), gyroscope=(), ' +
    'magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
    'publickey-credentials-get=(self), screen-wake-lock=(), sync-xhr=(), ' +
    'usb=(), web-share=(), xr-spatial-tracking=()'
  )
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')
  next()
})

// Helpers de body/seguridad (_stripPollutionKeys, bodyLimit, sendErr, sendOk)
// viven en shared/helpers.js. Reviver inline para el parser global mantiene la
// defensa-en-profundidad contra prototype pollution sin importar el helper.
app.use(express.json({
  limit: '50kb',
  reviver: (k, v) => (k === '__proto__' || k === 'prototype' || k === 'constructor') ? undefined : v,
}));
app.use((req, _res, next) => { if (req.body) _stripPollutionKeys(req.body); next() });

// ─── CSRF Double-Submit Cookie ────────────────────────────────────────────────
const CSRF_SKIP = new Set([
  '/api/auth/login', '/api/auth/challenge', '/api/auth/2fa/verify', '/api/auth/logout',
  '/api/portal/auth/register', '/api/portal/auth/login', '/api/portal/auth/logout',
  '/api/portal/auth/forgot-password', '/api/portal/auth/reset-password',
  '/api/portal/settings',
  '/api/webhooks/azul',  // webhook firmado HMAC, no necesita CSRF
])
function csrfMiddleware(req, res, next) {
  const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'
  if (!mutating) return next()
  const p = req.path
  if ([...CSRF_SKIP].some(s => p === s || p.startsWith(s + '/'))) return next()

  // Rutas portal autenticadas → validan contra cookie pct-csrf
  if (p.startsWith('/api/portal/') || p.startsWith('/api/track/')) {
    const header = req.headers['x-portal-csrf']
    const cookie = req.cookies?.['pct-csrf']
    if (!header || !cookie || header !== cookie) {
      return res.status(403).json({ error: 'CSRF token de portal inválido.', code: 'PORTAL_CSRF_INVALID' })
    }
    return next()
  }

  // Rutas admin → cookie csrf
  const header = req.headers['x-csrf-token']
  const cookie = req.cookies?.csrf
  if (!header || !cookie || header !== cookie) {
    return res.status(403).json({ error: 'CSRF token inválido.', code: 'CSRF_INVALID' })
  }
  next()
}
app.use(csrfMiddleware);

// Zod helpers + schemas + UUID validator + formateadores RD + middlewares de
// auth/permisos/nivel + device fingerprint helpers viven en shared/helpers.js,
// shared/schemas.js y shared/middlewares.js. completarLogin (sesión + cookies +
// device fingerprint) migró a backend/modules/auth/service.js. server.js solo
// retiene IDLE_TTL_MS porque otros middlewares lo consumen via _routerDeps.

// Idle timeout: 30 min sliding session. JWT TTL = 30 min; renewed on activity
// via sliding refresh in verificarJWT. RememberMe extends to 30d but keeps idle.
const IDLE_TTL_MS = 30 * 60 * 1000

// ─── Portal JWT ───────────────────────────────────────────────────────────────
// PORTAL_JWT_SECRET + verificarPortalJWT viven en shared/jwt-crypto.js y
// shared/middlewares.js. signPortalToken se queda aquí porque es trivial y solo
// se usa desde el flow de portal-b2c.

function signPortalToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, email: usuario.email, nombre: usuario.nombre, clienteId: usuario.clienteId ?? null, type: 'portal' },
    PORTAL_JWT_SECRET,
    { expiresIn: '30d' }
  )
}

const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    try {
      const raw = req.cookies?.pct
      if (raw) { const p = jwt.decode(raw); if (p?.sub) return `portal:${p.sub}` }
    } catch {}
    return reqFingerprint(req)
  },
  store: makeRateLimitStore(),
  message: { error: 'Demasiados intentos. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
})

// ─── Health Check (movido arriba del rate-limiter para que Render no se 429) ──
// Stub: legacy block. Mantengo para no romper rutas que esperan headers extras.
app.get('/api/health/legacy', async (req, res) => {
  let dbConnected = false
  try { await prisma.$queryRaw`SELECT 1`; dbConnected = true } catch (_) {}
  res.json({
    status:    'ok',
    version:   '3.0.0-HARD-RESET',
    timestamp: Date.now(),
    dbConnected,
  });
});

// ─── MSP: Vault PAM (AES-256-GCM) ─────────────────────────────────────────────

const VAULT_KEY_B64 = process.env.VAULT_KEY || ''
if (!VAULT_KEY_B64) console.warn('[VAULT] WARNING: VAULT_KEY not set — credential vault disabled.')
const VAULT_KEY = VAULT_KEY_B64 ? Buffer.from(VAULT_KEY_B64, 'base64') : null

function vaultEncrypt(plaintext) {
  if (!VAULT_KEY) throw new Error('VAULT_KEY missing.')
  const iv     = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv)
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return { passwordEnc: Buffer.concat([enc, tag]).toString('base64'), passwordIv: iv.toString('base64') }
}

function vaultDecrypt(passwordEnc, passwordIv) {
  if (!VAULT_KEY) throw new Error('VAULT_KEY missing.')
  const data = Buffer.from(passwordEnc, 'base64')
  const tag  = data.subarray(data.length - 16)
  const enc  = data.subarray(0, data.length - 16)
  const iv   = Buffer.from(passwordIv, 'base64')
  const dec  = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv)
  dec.setAuthTag(tag)
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8')
}

// ─── Supabase Storage + Validación URL whitelist (anti tracking-pixel) ──────

app.post(
  '/api/configuracion/empresa/upload',
  uploadLimiter,
  verificarJWT,
  requerirPermiso('empresa:editar'),
  uploadMulter.single('file'),
  async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'Storage no configurado. Falta SUPABASE_SERVICE_ROLE_KEY.', code: 'STORAGE_DISABLED' })
      if (!req.file) return res.status(400).json({ error: 'Archivo requerido (campo "file").' })
      const kind = String(req.body.kind || req.query.kind || '')
      if (!KINDS_VALIDOS.includes(kind)) {
        return res.status(400).json({ error: `Parámetro "kind" debe ser uno de: ${KINDS_VALIDOS.join(', ')}.` })
      }
      const inputMime = detectMimeFromBuffer(req.file.buffer)
      if (!inputMime) return res.status(415).json({ error: 'Tipo de archivo no reconocido o corrupto.', code: 'INVALID_MIME' })
      if (!MIME_EXT[inputMime]) return res.status(415).json({ error: `Mime ${inputMime} no permitido.` })
      if (inputMime === 'image/svg+xml' && !svgSeguro(req.file.buffer)) {
        auditReq('empresa:upload_svg_malicioso', req, { kind, size: req.file.size })
        return res.status(422).json({ error: 'SVG contiene contenido peligroso.', code: 'SVG_UNSAFE' })
      }
      let buffer, finalMime, ext
      try {
        const compressed = await comprimirImagen(req.file.buffer, inputMime)
        buffer = compressed.buffer; finalMime = compressed.mime; ext = compressed.ext
      } catch (e) {
        console.error('[SHARP COMPRESS]', e.message)
        return res.status(422).json({ error: 'Imagen corrupta o formato no procesable.', code: 'COMPRESS_FAIL' })
      }
      const filename = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
      const path     = `acr/${filename}`
      const { error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buffer, {
        contentType: finalMime, cacheControl: '3600', upsert: false,
      })
      if (upErr) {
        console.error('[UPLOAD ERROR]', upErr.message)
        return res.status(502).json({ error: `Error al subir: ${upErr.message}`, code: 'STORAGE_UPLOAD_FAIL' })
      }
      const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path)
      const publicUrl = pub?.publicUrl
      if (!publicUrl || !esAssetUrlSegura(publicUrl)) {
        return res.status(500).json({ error: 'URL pública generada inválida.', code: 'URL_INVALID' })
      }
      const ahorroPct = ((req.file.size - buffer.length) / req.file.size * 100)
      auditReq('empresa:upload', req, {
        kind, inputMime, finalMime,
        sizeOriginal: req.file.size, sizeComprimido: buffer.length,
        ahorroPct: Number(ahorroPct.toFixed(1)), url: publicUrl,
      })
      res.status(201).json({
        kind, url: publicUrl, mime: finalMime,
        size: buffer.length, sizeOriginal: req.file.size,
        ahorroPct: Number(ahorroPct.toFixed(1)),
      })
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' })
      console.error('[EMPRESA UPLOAD]', e.message)
      res.status(500).json({ error: 'Error interno al procesar el archivo.' })
    }
  }
)

app.post('/api/inventario/upload-image',
  uploadLimiter,
  verificarJWT,
  requerirPermiso('catalogo:editar'),
  uploadMulter.single('file'),
  async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'Storage no configurado.', code: 'STORAGE_DISABLED' })
      if (!req.file) return res.status(400).json({ error: 'Archivo requerido (campo "file").' })
      const kind = String(req.body.kind || req.query.kind || 'producto')
      if (!KINDS_INVENTARIO.includes(kind)) {
        return res.status(400).json({ error: `Parámetro "kind" debe ser uno de: ${KINDS_INVENTARIO.join(', ')}.` })
      }
      const inputMime = detectMimeFromBuffer(req.file.buffer)
      if (!inputMime) return res.status(415).json({ error: 'Tipo no reconocido.', code: 'INVALID_MIME' })
      if (!MIME_EXT[inputMime]) return res.status(415).json({ error: `Mime ${inputMime} no permitido.` })
      if (inputMime === 'image/svg+xml' && !svgSeguro(req.file.buffer)) {
        return res.status(422).json({ error: 'SVG con contenido peligroso.', code: 'SVG_UNSAFE' })
      }
      let buffer, finalMime, ext
      try {
        const c = await comprimirImagen(req.file.buffer, inputMime)
        buffer = c.buffer; finalMime = c.mime; ext = c.ext
      } catch {
        return res.status(422).json({ error: 'Imagen corrupta.', code: 'COMPRESS_FAIL' })
      }
      const filename = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
      const path = `${kind}/${filename}`
      const { error: upErr } = await supabase.storage.from(INVENTORY_BUCKET).upload(path, buffer, {
        contentType: finalMime, cacheControl: '3600', upsert: false,
      })
      if (upErr) {
        console.error('[INV UPLOAD]', upErr.message)
        return res.status(502).json({ error: `Error al subir: ${upErr.message}` })
      }
      const { data: pub } = supabase.storage.from(INVENTORY_BUCKET).getPublicUrl(path)
      auditReq('inventario:upload_imagen', req, { kind, mime: finalMime, size: buffer.length })
      res.status(201).json({ kind, url: pub?.publicUrl ?? null, mime: finalMime, size: buffer.length })
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' })
      console.error('[INV UPLOAD]', e.message)
      res.status(500).json({ error: 'Error interno.' })
    }
  }
)

// ─── Upload por URL externa (mismo pipeline) ─────────────────────────────────
// El usuario pega URL de Google/proveedor, backend descarga + valida MIME real
// (magic bytes) + comprime con sharp + sube a Supabase. NUNCA se guarda la URL
// externa directamente — siempre se rehospeda para evitar:
//   - Hotlinking que rompe cuando el server externo borra la imagen
//   - SSRF: backend rechaza esquemas no-http(s), IPs privadas, localhost
//   - Tracking pixels disfrazados de imagen
const urlUploadSchema = z.object({
  url:  z.string().url().max(2048),
  kind: z.enum(KINDS_INVENTARIO).default('producto'),
})

app.post('/api/inventario/upload-url',
  uploadLimiter,
  verificarJWT,
  requerirPermiso('catalogo:editar'),
  async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'Storage no configurado.', code: 'STORAGE_DISABLED' })
      const { url, kind } = urlUploadSchema.parse(req.body)
      if (!esUrlPublicaSegura(url)) return res.status(400).json({ error: 'URL no válida o bloqueada por seguridad.', code: 'URL_BLOCKED' })

      // Descarga con timeout 8s + cap de tamaño 5MB (más generoso que upload local
      // porque las imágenes externas suelen venir sin optimizar; sharp las recorta).
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      let buf
      try {
        // H1: redirect:'error' bloquea SSRF chains tipo bit.ly -> 169.254.169.254/metadata
        const r = await fetch(url, { signal: controller.signal, redirect: 'error' })
        if (!r.ok) return res.status(422).json({ error: `Servidor remoto devolvió ${r.status}.`, code: 'REMOTE_FAIL' })
        const len = Number(r.headers.get('content-length') ?? 0)
        if (len > 5 * 1024 * 1024) return res.status(413).json({ error: 'Imagen remota excede 5MB.', code: 'TOO_LARGE' })
        const ab = await r.arrayBuffer()
        if (ab.byteLength > 5 * 1024 * 1024) return res.status(413).json({ error: 'Imagen remota excede 5MB.', code: 'TOO_LARGE' })
        buf = Buffer.from(ab)
      } catch (e) {
        if (e.name === 'AbortError') return res.status(504).json({ error: 'Descarga remota timeout (8s).', code: 'TIMEOUT' })
        return res.status(502).json({ error: `No se pudo descargar: ${e.message}`, code: 'FETCH_FAIL' })
      } finally { clearTimeout(timer) }

      // Validación MIME por magic bytes (no por header Content-Type, que puede mentir).
      const inputMime = detectMimeFromBuffer(buf)
      if (!inputMime) return res.status(415).json({ error: 'Contenido no es una imagen válida.', code: 'INVALID_MIME' })
      if (!MIME_EXT[inputMime]) return res.status(415).json({ error: `Mime ${inputMime} no permitido.` })
      if (inputMime === 'image/svg+xml' && !svgSeguro(buf)) {
        return res.status(422).json({ error: 'SVG remoto con contenido peligroso.', code: 'SVG_UNSAFE' })
      }

      // Pipeline idéntico al upload local (resize 800x800 + PNG).
      let buffer, finalMime, ext
      try {
        const c = await comprimirImagen(buf, inputMime)
        buffer = c.buffer; finalMime = c.mime; ext = c.ext
      } catch {
        return res.status(422).json({ error: 'Imagen remota corrupta o ilegible.', code: 'COMPRESS_FAIL' })
      }
      const filename = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
      const path = `${kind}/${filename}`
      const { error: upErr } = await supabase.storage.from(INVENTORY_BUCKET).upload(path, buffer, {
        contentType: finalMime, cacheControl: '3600', upsert: false,
      })
      if (upErr) {
        console.error('[INV UPLOAD URL]', upErr.message)
        return res.status(502).json({ error: `Error al subir: ${upErr.message}` })
      }
      const { data: pub } = supabase.storage.from(INVENTORY_BUCKET).getPublicUrl(path)
      auditReq('inventario:upload_imagen_url', req, { kind, sourceUrl: url, mime: finalMime, size: buffer.length })
      res.status(201).json({ kind, url: pub?.publicUrl ?? null, mime: finalMime, size: buffer.length, sourceUrl: url })
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'URL inválida.' })
      console.error('[INV UPLOAD URL]', e.message)
      res.status(500).json({ error: 'Error interno.' })
    }
  }
)

// ─── Generación de PDF server-side (Cotización + Factura) ────────────────────

// ─── Anti-tamper hash (HMAC) ──────────────────────────────────────────────────
// _normStr/_normMoney/_normDateYMD/facturaVerifyHash/persistirVerifyHash viven
// en shared/services/verify-hash.service.js. La normalización rígida es load-
// bearing — ver docs ahí. Aquí solo conservamos PUBLIC_VERIFY_BASE (URL del
// frontend para el QR) y la lógica de invalidación de cache PDF post-template.

// PUBLIC_URL para verificación (frontend host). Cadena de fallbacks para que
// el QR del PDF SIEMPRE tenga URL que apuntar. Antes: si PUBLIC_FRONTEND_URL
// no estaba seteado en prod, verifyQrDataUri quedaba null y el QR no se
// imprimía. Ahora derivamos en orden:
//   1. PUBLIC_FRONTEND_URL — preferida, configurada explícitamente.
//   2. CORS_ORIGIN — primer origen de la lista (típicamente el frontend prod).
//   3. localhost:5173 — último recurso para no romper dev.
function resolverVerifyBase() {
  const explicit = (process.env.PUBLIC_FRONTEND_URL ?? '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  const corsList = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const httpsCors = corsList.find(o => /^https:\/\//i.test(o))
  if (httpsCors) return httpsCors.replace(/\/+$/, '')
  if (corsList[0]) return corsList[0].replace(/\/+$/, '')
  return 'http://localhost:5173'
}
const PUBLIC_VERIFY_BASE = resolverVerifyBase()
console.log(`[VERIFY] PUBLIC_VERIFY_BASE=${PUBLIC_VERIFY_BASE}`)

// ─── Invalidación auto de PDFs cacheados por versión de template ──────────────
// Cuando cambia la plantilla (paleta, layout, QR, etc), las copias en Supabase
// quedan desfasadas. Persistimos la versión activa en EmpresaPerfil.secuenciasConfig
// bajo la clave reservada `_pdfCacheVersion` y, al boot, comparamos. Si difiere,
// vaciamos pdfUrl masivamente — al siguiente request el endpoint regenera con
// el template nuevo. Cero intervención manual, cero migración de schema.
const PDF_TEMPLATE_VERSION = 'v11-2026-05-17-qr-url-natural-wrap'
let _pdfCacheVersionChecked = false
async function invalidarPdfsSiCambioTemplate() {
  if (_pdfCacheVersionChecked) return
  _pdfCacheVersionChecked = true
  try {
    const emp = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { secuenciasConfig: true },
    })
    const cfg = (emp?.secuenciasConfig && typeof emp.secuenciasConfig === 'object') ? emp.secuenciasConfig : {}
    if (cfg._pdfCacheVersion === PDF_TEMPLATE_VERSION) {
      console.log(`[PDF] template ${PDF_TEMPLATE_VERSION} ya activa, sin cambios`)
      return
    }
    // v8: el algoritmo de verifyHash cambió (normalización rígida). Hashes
    // antiguos en DB son obsoletos — los limpiamos para que el endpoint
    // /verify recalcule con la nueva función y self-heal backfillea.
    const r = await prisma.factura.updateMany({
      where: { OR: [{ pdfUrl: { not: null } }, { verifyHash: { not: null } }] },
      data:  { pdfUrl: null, verifyHash: null, pdfInvalidatedAt: new Date(), pdfRenderAttempts: 0 },
    })
    // Si el record empresa no existe (DB virgen) o el update falla, NO abortamos
    // la invalidación masiva — la próxima cold-start lo intentará otra vez. Lo
    // importante es que los pdfUrl quedaron null y el siguiente render
    // regenerará con el template nuevo.
    if (emp) {
      try {
        await prisma.empresaPerfil.update({
          where: { id: 1 },
          data:  { secuenciasConfig: { ...cfg, _pdfCacheVersion: PDF_TEMPLATE_VERSION } },
        })
      } catch (eUp) { console.warn('[PDF] no se pudo persistir versión activa:', eUp.message) }
    } else {
      console.warn('[PDF] empresa(id=1) no existe — invalidación corrió igual, marker se persistirá tras crear la empresa')
    }
    console.log(`[PDF] template ${PDF_TEMPLATE_VERSION} activa — invalidados ${r.count} PDFs cacheados`)
  } catch (e) { console.warn('[PDF] cache-version check fail:', e.message) }
}
// Disparamos asíncrono al boot — no bloquea el listen ni la rate-limit warmup.
invalidarPdfsSiCambioTemplate().catch(() => {})

// ─── Cache PDF en Supabase Storage ────────────────────────────────────────────
const PDF_CACHE_BUCKET = process.env.SUPABASE_PDF_BUCKET ?? 'documentos-pdf'

async function subirPdfAlStorage(buf, factura) {
  if (!supabase) return null
  const fecha = new Date(factura.fechaEmision ?? Date.now())
  const path = `${fecha.getFullYear()}/${String(fecha.getMonth() + 1).padStart(2, '0')}/${factura.id}.pdf`
  const { error } = await supabase.storage.from(PDF_CACHE_BUCKET).upload(path, buf, {
    contentType:  'application/pdf',
    cacheControl: '604800', // 7 días en CDN
    upsert:       true,     // regeneración sobrescribe
  })
  if (error) { console.error('[PDF CACHE upload]', error.message); return null }
  const { data } = supabase.storage.from(PDF_CACHE_BUCKET).getPublicUrl(path)
  return data?.publicUrl ?? null
}

async function invalidarPdfCache(facturaId) {
  if (!facturaId) return
  try {
    const f = await prisma.factura.findUnique({ where: { id: facturaId }, select: { pdfUrl: true, fechaEmision: true } })
    // M8: SIEMPRE actualizar pdfInvalidatedAt para que el cron sepa que hubo
    // cambio mid-flight aunque no hubiera PDF previo (ej. factura mutada antes
    // del primer render).
    const ahora = new Date()
    await prisma.factura.update({
      where: { id: facturaId },
      data:  { pdfUrl: null, pdfInvalidatedAt: ahora, pdfRenderAttempts: 0 },
    })
    if (f?.pdfUrl && supabase) {
      const fecha = new Date(f.fechaEmision ?? Date.now())
      const path = `${fecha.getFullYear()}/${String(fecha.getMonth() + 1).padStart(2, '0')}/${facturaId}.pdf`
      await supabase.storage.from(PDF_CACHE_BUCKET).remove([path]).catch(() => {})
    }
  } catch (e) { console.error('[PDF CACHE invalidate]', e.message) }
}

// Merge per-doc condiciones sobre EmpresaPerfil defaults.
// Cada campo del doc puede ser:
//   string             → incluir si no vacío
//   {incluir, texto}   → toggle explícito (UI nueva): incluir=false oculta la fila
//   null/undefined     → fall-through al default empresa
// Default empresa es siempre string. Si el doc dice incluir=false, NUNCA cae al default
// (el usuario decidió ocultarla en este documento concreto).
function mergeCondiciones(empresa, factura) {
  const defs = empresa?.condicionesDefault ?? {}
  const obligatorios = defs?._obligatorio ?? {}
  const own  = factura?.condiciones ?? {}
  const defaultText = (k) => {
    const d = defs?.[k]
    return typeof d === 'string' && d.trim() ? d.trim() : null
  }
  const pick = (k) => {
    // Términos marcados obligatorios en MiEmpresa NO se pueden ocultar a nivel
    // de documento. Cualquier override que diga `incluir:false` es ignorado y
    // siempre cae al texto default de empresa. Si no hay default, retornamos
    // null para no imprimir una fila vacía con el label suelto.
    if (obligatorios[k]) return defaultText(k)
    const v = own?.[k]
    if (v !== undefined && v !== null) {
      if (typeof v === 'string') {
        const s = v.trim()
        return s || null
      }
      if (typeof v === 'object') {
        if (!v.incluir) return null
        const s = String(v.texto ?? '').trim()
        return s || null
      }
    }
    // No override -> default empresa.
    return defaultText(k)
  }
  return {
    validez:  pick('validez'),
    pago:     pick('pago'),
    entrega:  pick('entrega'),
    garantia: pick('garantia'),
  }
}

// Clasifica la composición de una factura según sus líneas. Si tiene SOLO
// productos físicos (con productoId vinculado) → 'Artículos'. Si tiene SOLO
// servicios/líneas sin producto → 'Servicio'. Si mezcla ambos → 'Mixto'.
function _composicionFactura(lineas) {
  let hasArt = false, hasSrv = false
  for (const l of lineas) {
    const tipo = l.producto?.tipoItem
    if (l.productoId && tipo !== 'SERVICIO') hasArt = true
    else hasSrv = true
    if (hasArt && hasSrv) break
  }
  if (hasArt && hasSrv) return 'Mixto'
  if (hasArt) return 'Artículos'
  return 'Servicio'
}

async function buildPdfData(facturaOrCotizacion) {
  const f = facturaOrCotizacion
  // Si la factura tiene snapshot fiscal (emitida con el sistema nuevo), USA esa data
  // congelada en vez del estado vivo de EmpresaPerfil/Cliente. Garantiza que un PDF
  // re-generado hoy muestre los datos que tenía el día que se emitió (DGII compliance).
  const snap = f.snapshot && typeof f.snapshot === 'object' ? f.snapshot : null
  const empresa = snap?.empresa
    ? { ...snap.empresa, condicionesDefault: snap.empresa.condicionesDefault ?? {} }
    : await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
  const empresaConAssets = empresa
    ? { ...empresa, assets: await inlineAssets(empresa.assets ?? {}) }
    : { razonSocial: '', rnc: '', assets: {} }
  const c = snap?.cliente ?? f.cliente ?? {}
  // M7: cotizaciones NO son documento fiscal. La cédula es PII sensible; si el
  // PDF se filtra (compartido por WhatsApp/email), el RNC empresarial basta.
  // Personas físicas sin RNC -> cédula enmascarada (últimos 4 dígitos).
  const cedulaParaPDF = f.esCotizacion
    ? (c.rnc ? null : (c.cedula ? `***-*******-${String(c.cedula).replace(/\D/g, '').slice(-4)}` : null))
    : c.cedula
  // Hash computado UNA sola vez sobre la lectura DB de la factura — mismo valor
  // viaja al QR (image) y a la sección verify (texto debajo del QR). Antes se
  // recomputaba en dos puntos y, si f mutaba mid-build (caso raro pero posible
  // con relations lazy-loaded), las dos llamadas divergían.
  const verifyHashFinal = facturaVerifyHash(f, 'pdf-build')
  const verifyUrl = `${PUBLIC_VERIFY_BASE}/verify/${verifyHashFinal}`
  return {
    empresa: empresaConAssets,
    cliente: {
      razonSocial: c.razonSocial,
      noCliente:   c.noCliente,
      rnc:         c.rnc,
      contacto:    c.nombreContacto ?? c.contacto ?? null,
      cedula:      cedulaParaPDF,
      direccion:   c.direccion,
      sector:      c.sector,
      provincia:   c.provincia,
      telefono:    c.telefono ?? c.telefonoPrincipal ?? c.telefonoContacto ?? null,
      email:       c.email,
    },
    // LineaFactura SOLO tiene relación con producto (no con itemCatalogo).
    // Fallback a orden.lineas para facturas OT-based (sin LineaFactura propia).
    // Excluye consumoInterno (materiales gastados en instalación no facturables).
    items: ((f.lineas?.length ? f.lineas : (f.orden?.lineas ?? []))
      .filter(l => !l.consumoInterno)
      .map(l => ({
        codigo:         l.producto?.sku ?? (l.producto?.id ? `ART-${String(l.producto.id).padStart(3, '0')}` : null),
        descripcion:    l.descripcion,
        detalle:        l.producto?.nombre && l.producto.nombre !== l.descripcion ? l.producto.nombre : null,
        sku:            l.producto?.sku ?? null,
        cantidad:       l.cantidad,
        precioUnitario: Number(l.precioUnitario),
      }))),
    // Tipo de composición DINÁMICO: cuenta productos físicos vs servicios para
    // mostrar al cliente si está pagando algo tangible, intangible o mixto.
    tipoComposicion: _composicionFactura((f.lineas?.length ? f.lineas : (f.orden?.lineas ?? [])).filter(l => !l.consumoInterno)),
    ncf:          f.ncf ?? null,
    tipoNcf:      f.tipoNcf ?? null,
    subtotal:     Number(f.subtotal),
    itbis:        Number(f.itbis ?? 0),
    total:        Number(f.total),
    fechaEmision: f.fechaEmision,
    fechaVence:   f.fechaVence,
    estado:       f.estado,
    notas:        f.notas,
    condiciones:  mergeCondiciones(empresa, f),
    // Datos exclusivos de comprobantes modificatorios DGII (NC B04 / ND B03).
    // El template renderiza el título correcto y la línea "Modifica al
    // Comprobante:" + el motivo debajo del cliente.
    esNotaCredito:           !!f.esNotaCredito,
    esNotaDebito:            !!f.esNotaDebito,
    facturaOrigen:           f.facturaOrigen
      ? { noFactura: f.facturaOrigen.noFactura, ncf: f.facturaOrigen.ncf, tipoNcf: f.facturaOrigen.tipoNcf }
      : null,
    motivoNotaModificatoria: f.motivoNotaModificatoria ?? null,
    verify: { hash: verifyHashFinal, url: verifyUrl },
    // QR pre-renderizado como data:image/png;base64 — SIEMPRE generado. El
    // destinatario escanea con cualquier cámara y aterriza en /verify/:hash.
    // Si edita el PDF con Photoshop, el hash en pantalla deja de matchear con
    // el calculado por el backend y la página marca el documento como ALTERADO.
    verifyQrDataUri: await renderVerifyQr(verifyUrl),
  }
}

// Genera un QR PNG de tamaño fijo y bajo overhead. errorCorrectionLevel 'M'
// tolera ~15% de daño del impreso (huellas, manchas) sin romper el escaneo.
// Cache en memoria por URL — los PDFs masivos reutilizan el mismo QR sin
// re-renderizar.
const _qrCache = new Map() // url -> dataURI
const QR_CACHE_MAX = 256
async function renderVerifyQr(url) {
  if (!url) return null
  if (_qrCache.has(url)) return _qrCache.get(url)
  try {
    const dataUri = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      width: 256,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
    if (_qrCache.size >= QR_CACHE_MAX) _qrCache.delete(_qrCache.keys().next().value)
    _qrCache.set(url, dataUri)
    return dataUri
  } catch (e) {
    console.warn('[QR] fallo generar:', e.message)
    return null
  }
}

// Registrado en el path REAL (el middleware NAMESPACE_REWRITES rewrites
// /api/ventas/cotizaciones/* → /api/cotizaciones/* antes de llegar aquí).
app.get('/api/cotizaciones/:id/pdf', verificarJWT, requerirPermiso('venta:ver_cotizaciones'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    // Fast path: si está cacheado en Supabase, redirige (latencia <50ms vs ~1500ms con Puppeteer).
    const cached = await prisma.factura.findUnique({ where: { id: req.params.id }, select: { pdfUrl: true, esCotizacion: true, deletedAt: true, noFactura: true } })
    if (cached?.deletedAt) return res.status(404).json({ error: 'Cotización no encontrada.' })
    if (cached && !cached.esCotizacion) return res.status(400).json({ error: 'Este documento es una factura, usa /facturas/:id/pdf.' })
    if (cached?.pdfUrl && req.query.fresh !== '1') {
      auditReq('pdf:cotizacion:cache_hit', req, { id: req.params.id, noFactura: cached.noFactura })
      // Si el cliente pide JSON (apiFetch desde SPA), devuelve la URL Supabase
      // y el frontend hace fetch directo sin credenciales -> evita CORS por
      // el redirect 302 cuando el browser propaga credentials: include.
      const wantsJson = req.query.json === '1' || (req.headers.accept ?? '').includes('application/json')
      if (wantsJson) return res.json({ url: cached.pdfUrl, cached: true })
      return res.redirect(302, cached.pdfUrl)
    }

    const cot = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: {
        cliente: true,
        lineas:  { include: { producto: { select: { sku: true, nombre: true } } } },
      },
    })
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada.' })

    const data = await buildPdfData(cot)
    const html = renderPdfDoc({ tipo: 'cotizacion', numero: cot.noFactura, ...data })
    const pdfBuf = await generarPdfDocumento(html)

    // Fire-and-forget: sube al cache de Storage (sin bloquear respuesta al user).
    setImmediate(async () => {
      const url = await subirPdfAlStorage(pdfBuf, cot)
      if (url) await prisma.factura.update({ where: { id: cot.id }, data: { pdfUrl: url } }).catch(() => {})
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="cotizacion-${cot.noFactura}.pdf"`)
    res.setHeader('Content-Length', pdfBuf.length)
    auditReq('pdf:cotizacion', req, { id: cot.id, noFactura: cot.noFactura })
    res.end(pdfBuf)
  } catch (e) {
    console.error('[PDF COTIZACION]', e.code, e.message, e.stack)
    res.status(500).json({ error: 'Error generando PDF.', detail: e.message })
  }
})

// Path real (rewrite alias /api/ventas/facturas/:id/pdf -> aquí)
app.get('/api/facturas/:id/pdf', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const cached = await prisma.factura.findUnique({ where: { id: req.params.id }, select: { pdfUrl: true, esCotizacion: true, deletedAt: true, noFactura: true, ncf: true } })
    if (!cached || cached.deletedAt) return res.status(404).json({ error: 'Factura no encontrada.' })
    if (cached.esCotizacion)         return res.status(400).json({ error: 'Este documento es cotización, usa /cotizaciones/:id/pdf.' })
    if (cached.pdfUrl && req.query.fresh !== '1') {
      auditReq('pdf:factura:cache_hit', req, { id: req.params.id, noFactura: cached.noFactura, ncf: cached.ncf })
      const wantsJson = req.query.json === '1' || (req.headers.accept ?? '').includes('application/json')
      if (wantsJson) return res.json({ url: cached.pdfUrl, cached: true })
      return res.redirect(302, cached.pdfUrl)
    }

    const fact = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: {
        cliente:       true,
        lineas:        { include: { producto: { select: { sku: true, nombre: true } } } },
        facturaOrigen: { select: { noFactura: true, ncf: true, tipoNcf: true } },
      },
    })
    if (!fact) return res.status(404).json({ error: 'Factura no encontrada.' })

    const data = await buildPdfData(fact)
    const tipoDoc = fact.esNotaCredito ? 'nota-credito'
                  : fact.esNotaDebito  ? 'nota-debito'
                  : 'factura'
    const html = renderPdfDoc({ tipo: tipoDoc, numero: fact.noFactura, ...data })
    const pdfBuf = await generarPdfDocumento(html)

    setImmediate(async () => {
      const url = await subirPdfAlStorage(pdfBuf, fact)
      if (url) await prisma.factura.update({ where: { id: fact.id }, data: { pdfUrl: url } }).catch(() => {})
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${tipoDoc}-${fact.noFactura}.pdf"`)
    res.setHeader('Content-Length', pdfBuf.length)
    auditReq('pdf:factura', req, { id: fact.id, noFactura: fact.noFactura, ncf: fact.ncf })
    res.end(pdfBuf)
  } catch (e) {
    console.error('[PDF FACTURA]', e.code, e.message, e.stack)
    res.status(500).json({ error: 'Error generando PDF.', detail: e.message })
  }
})

// ─── Bulk PDF export (ZIP stream) ─────────────────────────────────────────────
// Genera múltiples PDFs y los empaqueta en un archivo ZIP, escribiendo
// directamente al stream de respuesta (sin acumular en RAM). Limita 50 docs
// por request + concurrencia 4 Puppeteer pages -> evita OOM en Free Tier.
const archiver = require('archiver')

const BULK_PDF_MAX     = 50
const BULK_PDF_PARALLEL = 4
const bulkPdfLimiter   = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })

const bulkPdfSchema = z.object({
  ids:  z.array(z.string().uuid()).min(1).max(BULK_PDF_MAX),
  tipo: z.enum(['factura', 'cotizacion']),
})

async function generarPdfDeFactura(id, tipo) {
  const f = await prisma.factura.findUnique({
    where: { id },
    include: {
      cliente:       true,
      lineas:        { include: { producto: { select: { sku: true, nombre: true } } } },
      facturaOrigen: { select: { noFactura: true, ncf: true, tipoNcf: true } },
    },
  })
  if (!f || f.deletedAt) return null
  if (tipo === 'cotizacion' && !f.esCotizacion) return null
  if (tipo === 'factura'    && f.esCotizacion)  return null
  const data = await buildPdfData(f)
  // Si la factura ES nota de crédito, fuerza la variante 'nota-credito' en el render.
  const tipoFinal = (tipo === 'factura' && f.esNotaCredito) ? 'nota-credito'
                  : (tipo === 'factura' && f.esNotaDebito)  ? 'nota-debito'
                  : tipo
  const html = renderPdfDoc({ tipo: tipoFinal, numero: f.noFactura, ...data })
  const buf  = await generarPdfDocumento(html)
  return { buf, noFactura: f.noFactura }
}

// Ejecuta promesas con concurrencia controlada. Devuelve resultados en orden.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) } }
      catch (err) { results[i] = { status: 'rejected', reason: err } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Ruta neutra (sin alias) para evitar el rewrite /api/ventas/* -> /api/*.
// Soporta tipo=factura|cotizacion vía body. Frontend llama directo a este path.
app.post('/api/pdf/bulk',
  bulkPdfLimiter,
  verificarJWT,
  requerirPermiso('factura:ver'),
  async (req, res) => {
    let archive
    try {
      const { ids, tipo } = bulkPdfSchema.parse(req.body)
      // Permisos finos por tipo
      const permReq = tipo === 'cotizacion' ? 'venta:ver_cotizaciones' : 'factura:ver'
      const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
      if (!permisos.includes('sistema:owner') && !permisos.includes(permReq))
        return res.status(403).json({ error: `Se requiere permiso "${permReq}".` })

      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const filename = `${tipo === 'cotizacion' ? 'cotizaciones' : 'facturas'}-${stamp}.zip`

      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      // No usar transfer-encoding manual; Node/archiver lo maneja en streaming
      archive = archiver('zip', { zlib: { level: 6 } })
      archive.on('error', err => { console.error('[BULK ZIP]', err.message); try { res.destroy(err) } catch {} })
      archive.pipe(res)

      const resultados = await mapWithConcurrency(ids, BULK_PDF_PARALLEL, id => generarPdfDeFactura(id, tipo))

      let ok = 0, fail = 0
      for (let i = 0; i < resultados.length; i++) {
        const r = resultados[i]
        if (r.status !== 'fulfilled' || !r.value) {
          fail++
          archive.append(`ID solicitado: ${ids[i]}\nMotivo: ${r.reason?.message ?? 'no encontrado o tipo incorrecto'}\n`, { name: `_fallidas/${ids[i]}.txt` })
          continue
        }
        const { buf, noFactura } = r.value
        archive.append(buf, { name: `${tipo === 'cotizacion' ? 'cotizacion' : 'factura'}-${noFactura}.pdf` })
        ok++
      }
      archive.append(`Generación masiva ACR ERP\nFecha: ${new Date().toISOString()}\nSolicitadas: ${ids.length}\nGeneradas: ${ok}\nFallidas: ${fail}\n`, { name: 'RESUMEN.txt' })
      auditReq('pdf:bulk', req, { tipo, solicitadas: ids.length, generadas: ok, fallidas: fail })
      await archive.finalize()
    } catch (e) {
      if (archive) { try { archive.abort() } catch {} }
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? `Mínimo 1, máximo ${BULK_PDF_MAX} documentos por exportación.` })
      console.error('[BULK PDF]', e.message)
      if (!res.headersSent) res.status(500).json({ error: 'Error generando exportación masiva.' })
      else try { res.end() } catch {}
    }
  }
)

// ─── Bundles cross-sell ──────────────────────────────────────────────────────
// Lookup rápido: dado un producto, devuelve sugerencias ordenadas por score.
app.get('/api/productos/:id/bundles', verificarJWT, async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10)
    if (!pid) return res.json({ data: [] })
    const bundles = await prisma.productoBundle.findMany({
      where:   { padreId: pid },
      orderBy: { score: 'desc' },
      include: { hijo: { select: { id: true, sku: true, nombre: true, precio: true, stockActual: true, imagenUrl: true } } },
      take:    8,
    })
    res.json({ data: bundles.map(b => ({ ...b.hijo, score: b.score, motivo: b.motivo })) })
  } catch (e) {
    console.error('[GET bundles]', e.code, e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Variante para item de catálogo: si está vinculado a un producto físico,
// retorna los bundles de ese producto. Sino vacío.
app.get('/api/catalogo/:id/bundles', verificarJWT, async (req, res) => {
  try {
    if (!validUUID(req.params.id)) return res.json({ data: [] })
    const item = await prisma.itemCatalogo.findUnique({
      where: { id: req.params.id }, select: { productoId: true },
    })
    if (!item?.productoId) return res.json({ data: [] })
    const bundles = await prisma.productoBundle.findMany({
      where:   { padreId: item.productoId },
      orderBy: { score: 'desc' },
      include: { hijo: { select: { id: true, sku: true, nombre: true, precio: true, stockActual: true, imagenUrl: true } } },
      take:    8,
    })
    res.json({ data: bundles.map(b => ({ ...b.hijo, score: b.score, motivo: b.motivo })) })
  } catch (e) {
    console.error('[GET catalogo bundles]', e.code, e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Series disponibles para un producto (captura en POS) ────────────────────
app.get('/api/productos/:id/series', verificarJWT, async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10)
    if (!pid) return res.json({ data: [] })
    const series = await prisma.productoSerial.findMany({
      where:   { productoId: pid, estado: 'Disponible' },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, serie: true, ubicacion: true, garantiaHasta: true },
    })
    res.json({ data: series })
  } catch (e) {
    console.error('[GET series]', e.code, e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Mover cotización entre etapas del pipeline (Kanban).
// Si la etapa nueva es 'Perdida' -> libera inmediatamente las reservas de stock
// asociadas (en lugar de esperar las 72h del TTL). Stock vuelve a estar
// disponible en el POS al instante para evitar bloqueo de inventario activo.
app.patch('/api/cotizaciones/:id/etapa',
  verificarJWT,
  requerirPermiso('venta:editar_cotizaciones'),
  async (req, res) => {
    if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
    const etapas = ['Borrador', 'Enviada', 'Negociacion', 'Aceptada', 'Convertida', 'Perdida']
    const { etapa } = req.body ?? {}
    if (!etapas.includes(etapa)) return res.status(400).json({ error: `Etapa inválida. Permitidas: ${etapas.join(', ')}.` })
    try {
      // RBAC adicional: cajeros normales solo mueven cotizaciones propias.
      // Owners/managers (permiso global venta:gestionar_todas) pasan a cualquier etapa.
      const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
      const puedeGestionarTodas = permisos.includes('sistema:owner') || permisos.includes('venta:gestionar_todas')
      const factura = await prisma.factura.findUnique({
        where:  { id: req.params.id },
        select: { id: true, esCotizacion: true, etapaPipeline: true, empleadoId: true },
      })
      if (!factura) return res.status(404).json({ error: 'Cotización no encontrada.' })
      if (!factura.esCotizacion) return res.status(400).json({ error: 'Solo cotizaciones tienen etapa pipeline.' })
      if (!puedeGestionarTodas && factura.empleadoId && factura.empleadoId !== req.user.sub) {
        auditReq('cotizacion:etapa_denied', req, { id: factura.id, owner: factura.empleadoId, etapaIntento: etapa })
        return res.status(403).json({ error: 'No puedes mover cotizaciones de otros vendedores.' })
      }

      const f = await prisma.factura.update({
        where: { id: req.params.id },
        data:  { etapaPipeline: etapa },
        select:{ id: true, etapaPipeline: true, noFactura: true },
      })
      let reservasLiberadas = 0
      // Libera reservas en etapas terminales: Perdida (rechazo), Aceptada (conversión inminente),
      // Convertida (ya facturada -> stock se descuenta vía Factura, reservar duplica).
      if (etapa === 'Perdida' || etapa === 'Aceptada' || etapa === 'Convertida') {
        const r = await prisma.reservaInventario.deleteMany({ where: { facturaId: f.id } })
        reservasLiberadas = r.count
        if (reservasLiberadas > 0) {
          auditReq('cotizacion:reservas_liberadas', req, { id: f.id, etapa, count: reservasLiberadas })
        }
      }
      auditReq('cotizacion:etapa', req, { id: f.id, etapa, reservasLiberadas })
      res.json({ ...f, reservasLiberadas })
    } catch (e) {
      console.error('[PATCH ETAPA]', e.code, e.message)
      res.status(500).json({ error: 'Error interno.' })
    }
  }
)

// AuditCaja: visible solo a sistema:owner
app.get('/api/auditoria/caja', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const { tipo, limit = '100' } = req.query
    const where = {}
    if (tipo) where.tipo = tipo
    const rows = await prisma.auditCaja.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(parseInt(limit) || 100, 500),
    })
    res.json({ data: rows })
  } catch (e) {
    console.error('[GET /api/auditoria/caja]', e.code, e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Edición rápida de condiciones comerciales por documento.
// Cada campo acepta:
//   - string (legacy)         → incluir si no vacío
//   - { incluir, texto }      → incluir solo si incluir === true Y texto no vacío
//   - null                    → no override, usa default empresa
const condFieldSchema = z.union([
  z.string().max(280).nullable(),
  z.object({
    incluir: z.boolean().default(true),
    texto:   z.string().max(280).optional().nullable().transform(v => v ?? ''),
  }),
]).optional().nullable()

const condicionesSchema = z.object({
  validez:  condFieldSchema,
  pago:     condFieldSchema,
  entrega:  condFieldSchema,
  garantia: condFieldSchema,
}).partial()

function condFieldIsEmpty(v) {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (typeof v === 'object') return !v.incluir || !String(v.texto ?? '').trim()
  return true
}

app.patch('/api/facturas/:id/condiciones',
  verificarJWT,
  requerirPermiso('factura:editar'),
  async (req, res) => {
    if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
    try {
      const data = condicionesSchema.parse(req.body)
      // Si todos los campos son null/vacíos/incluir=false, limpia override (cae al default).
      const allEmpty = Object.values(data).every(condFieldIsEmpty)
      const factura = await prisma.factura.update({
        where: { id: req.params.id },
        // Invalida pdfUrl al editar condiciones — fuerza regeneración con datos nuevos.
        data:  { condiciones: allEmpty ? null : data, pdfUrl: null },
        select:{ id: true, condiciones: true },
      })
      auditReq('factura:condiciones', req, { id: factura.id, cleared: allEmpty })
      // Cleanup del archivo viejo en Storage (fire-and-forget).
      invalidarPdfCache(factura.id).catch(() => {})
      res.json(factura)
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
      console.error('[PATCH CONDICIONES]', e.message)
      res.status(500).json({ error: 'Error interno.' })
    }
  }
)

// ─── Inventario: Schemas ─────────────────────────────────────────────────────

const stripTags = v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;

// ─── Descripción estructurada (compartida por productos/servicios/items) ─────
// Definida AQUÍ (antes que cualquier schema que la use) para evitar TDZ —
// las const declarations no se hoistan, y zod las evalúa al construir el schema.
const descripcionEstructuradaSchema = z.object({
  v:         z.literal(1),
  titulo:    z.string().min(1).max(200),
  bullets:   z.array(z.string().min(1).max(200)).max(30).default([]),
  imagenUrl: z.string().max(500).nullable().optional(),
})
const descripcionFlexSchema = z.union([
  z.string().max(2000),
  descripcionEstructuradaSchema,
]).nullable().optional()

// Normaliza descripcion: string legacy se pasa tal cual, objeto {v:1, ...} se
// serializa como JSON dentro de la columna TEXT — el renderer PDF detecta v=1.
function descripcionToRaw(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    if (value.v === 1) {
      const limpio = {
        v: 1,
        titulo:    String(value.titulo ?? '').slice(0, 200),
        bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
        imagenUrl: value.imagenUrl ? String(value.imagenUrl).slice(0, 500) : null,
      }
      return JSON.stringify(limpio)
    }
  }
  return null
}

const categoriaSchema = z.object({
  nombre: z.string().min(2).max(100).transform(stripTags),
});

const productoSchema = z.object({
  // sku ahora es OPCIONAL — backend autogenera si no viene (recomendado).
  // Si viene, se respeta para permitir importación con SKUs externos legacy.
  sku:            z.string().min(1).max(50).transform(stripTags).optional(),
  nombre:         z.string().min(2).max(200).transform(stripTags),
  precio:         z.coerce.number().nonnegative(),
  categoriaId:    z.number().int().positive(),
  tipoItem:       z.enum(['ARTICULO', 'SERVICIO']).optional(),
  esCanibalizado: z.boolean().optional(),
  // M1-2: acepta string legacy O objeto estructurado {v:1, titulo, bullets[], imagenUrl?}.
  descripcion:    descripcionFlexSchema,
  imagenUrl:      z.string().max(500).url().optional().nullable().or(z.literal('').transform(() => null)),
});

const productoUpdateSchema = productoSchema.omit({ sku: true }).partial();

function formatProducto(p) { return { ...p, precio: Number(p.precio) }; }

// ─── Reconciliación nocturna stock vs movimientos (sugerencia #2) ────────────
// 03:00 AM RD: detecta drift entre Producto.stockActual y la suma neta de


// ─── Server ───────────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ─── Dev Seed ─────────────────────────────────────────────────────────────────

app.post('/api/dev/seed-portal', async (req, res) => {
  const secret = req.headers['x-seed-secret']
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
      return res.status(403).json({ error: 'Forbidden.' })
    }
  }
  try {
    const catalogItems = await prisma.$transaction(async tx => {
      const cats = await Promise.all([
        tx.itemCatalogo.upsert({ where: { id: 'seed-cam-hd' },    update: {}, create: { id: 'seed-cam-hd',    nombre: 'Cámara IP HD 1080p Exterior', tipo: 'VentaUnica', categoria: 'CCTV',  precio: 8500,  costo: 4800, tipoItem: 'ARTICULO', activo: true } }),
        tx.itemCatalogo.upsert({ where: { id: 'seed-cam-4k' },    update: {}, create: { id: 'seed-cam-4k',    nombre: 'Cámara IP 4K Analíticas IA',   tipo: 'VentaUnica', categoria: 'CCTV',  precio: 18000, costo: 9500, tipoItem: 'ARTICULO', activo: true } }),
        tx.itemCatalogo.upsert({ where: { id: 'seed-router-ent'}, update: {}, create: { id: 'seed-router-ent',nombre: 'Router Mikrotik RB4011',        tipo: 'VentaUnica', categoria: 'Redes', precio: 22000, costo: 13000,tipoItem: 'ARTICULO', activo: true } }),
        tx.itemCatalogo.upsert({ where: { id: 'seed-ap-unifi' },  update: {}, create: { id: 'seed-ap-unifi',  nombre: 'AP UniFi U6 Pro WiFi 6',        tipo: 'VentaUnica', categoria: 'Redes', precio: 14500, costo: 8200, tipoItem: 'ARTICULO', activo: true } }),
        tx.itemCatalogo.upsert({ where: { id: 'seed-audit-red' }, update: {}, create: { id: 'seed-audit-red', nombre: 'Auditoría de Red Corporativa',   tipo: 'Servicio',   categoria: 'Redes', precio: 35000, costo: 8000, tipoItem: 'SERVICIO', activo: true } }),
        tx.itemCatalogo.upsert({ where: { id: 'seed-mant-mens' }, update: {}, create: { id: 'seed-mant-mens', nombre: 'Mantenimiento Mensual Preventivo',tipo: 'Recurrente', categoria: 'Redes', precio: 5500,  costo: 1500, tipoItem: 'SERVICIO', activo: true } }),
      ])
      return cats
    })

    const planFibra = await prisma.plan.upsert({
      where:  { id: 'seed-plan-fibra' },
      update: {},
      create: { id: 'seed-plan-fibra', nombre: 'Fibra Empresarial 200 Mbps', tipo: 'WISP', precioMensualBase: 9500, precioInstalBase: 5000, activo: true },
    })
    const planCCTV = await prisma.plan.upsert({
      where:  { id: 'seed-plan-cctv' },
      update: {},
      create: { id: 'seed-plan-cctv',  nombre: 'Videovigilancia Corporativa 8 Cámaras', tipo: 'CCTV', precioMensualBase: 3500, precioInstalBase: 42000, activo: true },
    })

    const count   = await prisma.cliente.count()
    const noCliente = `EMP-${String(count + 1).padStart(4, '0')}`
    const hash    = await bcrypt.hash('Demo2026!', 12)
    const cliente = await prisma.cliente.upsert({
      where:  { email: 'demo.empresa@acrtest.do' },
      update: { passwordHash: hash },
      create: {
        noCliente,
        razonSocial:       'Corporación Demo S.R.L.',
        email:             'demo.empresa@acrtest.do',
        passwordHash:      hash,
        tipoEmpresa:       'Sociedad de Responsabilidad Limitada',
        tipoCliente:       'Corporativo',
        nombreContacto:    'Carlos Empresario',
        apellidoContacto:  'Demo',
        cargo:             'Gerente de TI',
        telefono:          '809-555-1234',
        telefonoPrincipal: '809-555-1234',
        direccion:         'Av. Winston Churchill #55, Torre Empresarial, Piso 8',
        sector:            'Piantini',
        provincia:         'Distrito Nacional',
        limiteCredito:     100000,
        diasCredito:       30,
        itbis:             true,
      },
    })

    const [svc1, svc2] = await Promise.all([
      prisma.servicio.upsert({
        where:  { id: 'seed-svc-fibra' },
        update: {},
        create: { id: 'seed-svc-fibra', clienteId: cliente.id, planId: planFibra.id, estado: 'Activo',     precioMensual: 9500,  precioInstalacion: 5000,  notasTecnicas: 'Fibra óptica FTTH instalada el 2026-01-15', direccionInstalacion: 'Torre Empresarial Piso 8' },
      }),
      prisma.servicio.upsert({
        where:  { id: 'seed-svc-cctv' },
        update: {},
        create: { id: 'seed-svc-cctv',  clienteId: cliente.id, planId: planCCTV.id,  estado: 'Activo',     precioMensual: 3500,  precioInstalacion: 42000, notasTecnicas: '8 cámaras IP 4K instaladas, NVR configurado con retención 30 días', direccionInstalacion: 'Torre Empresarial — todas las plantas' },
      }),
    ])

    const factBase = { clienteId: cliente.id, subtotal: 9500, itbis: 1235, total: 10735, tipoNcf: 'Crédito Fiscal', esCotizacion: false }
    const now = new Date()
    const d = (daysAgo) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); return d }
    await Promise.all([
      prisma.factura.upsert({ where: { noFactura: 'B01-SEED-001' }, update: {}, create: { ...factBase, noFactura: 'B01-SEED-001', estado: 'Vencida', ncf: 'B0100000001', fechaEmision: d(45), fechaVence: d(15) } }),
      prisma.factura.upsert({ where: { noFactura: 'B01-SEED-002' }, update: {}, create: { ...factBase, noFactura: 'B01-SEED-002', estado: 'Pagada',  ncf: 'B0100000002', fechaEmision: d(75), fechaVence: d(45), fechaPago: d(40) } }),
      prisma.factura.upsert({ where: { noFactura: 'B01-SEED-003' }, update: {}, create: { ...factBase, noFactura: 'B01-SEED-003', estado: 'Emitida', ncf: 'B0100000003', fechaEmision: d(10), fechaVence: d(-20) } }),
    ])

    res.json({
      ok:       true,
      cliente:  { id: cliente.id, email: 'demo.empresa@acrtest.do', password: 'Demo2026!' },
      servicios: 2,
      facturas:  3,
      catalogo:  catalogItems.length,
      msg: 'Login en el portal con demo.empresa@acrtest.do / Demo2026!',
    })
  } catch (e) {
    console.error('[SEED]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ─── Startup checks ───────────────────────────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'COOKIE_SECRET', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`CRITICAL: ${key} is missing — server cannot start safely.`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;

async function seedNomenclaturas() {
  const counters = [
    { prefijo: 'SV-',  tipoNcf: 'SV',  tipoDescripcion: 'Servicios',           limite: 99999 },
    { prefijo: 'OT-',  tipoNcf: 'OT',  tipoDescripcion: 'Ordenes de Trabajo',  limite: 99999 },
    { prefijo: 'COT-', tipoNcf: 'COT', tipoDescripcion: 'Cotizaciones',        limite: 99999 },
    // Comprobantes modificatorios fiscales DGII. Limite 99,999,999 idéntico a
    // B01/B02 — vienen del mismo lote de NCF asignado por DGII al RNC del taxpayer.
    { prefijo: 'B03',  tipoNcf: 'Nota de Débito',  tipoDescripcion: 'Notas de Débito (DGII B03)',  limite: 99999999 },
    { prefijo: 'B04',  tipoNcf: 'Nota de Crédito', tipoDescripcion: 'Notas de Crédito (DGII B04)', limite: 99999999 },
  ]
  for (const c of counters) {
    await prisma.configuracionNCF.upsert({
      where:  { tipoNcf: c.tipoNcf },
      update: {},
      create: { ...c, secuenciaActual: 0, activo: true },
    })
  }
  console.log('[SEED] Nomenclature counters ready (SV/OT/COT + B03/B04).')
}

async function warmChallengeStore(count = 3) {
  try {
    await Promise.all(Array.from({ length: count }, async () => {
      const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding:  { type: 'spki',  format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      const cid = crypto.randomUUID()
      challengeStore.set(cid, { publicKey: Buffer.from(publicKey).toString('base64'), privateKey, exp: Date.now() + 5 * 60_000 })
    }))
    console.log(`[CHALLENGE] ${count} RSA challenges pre-generated.`)
  } catch (e) {
    console.warn('[CHALLENGE] Warm-up failed (non-fatal):', e.message)
  }
}

// Asegura columnas idempotentes que el ORM ya conoce pero `prisma migrate deploy`
// puede no haber aplicado todavía (race entre `npx prisma generate` y el deploy
// real de Render). Sin esto, cualquier SELECT * sobre EmpresaPerfil o Factura
// rompe con "column does not exist" -> 500 en endpoints de listado y perfil.
async function ensureSchemaColumns() {
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE "EmpresaPerfil" ADD COLUMN IF NOT EXISTS "condicionesDefault" JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "condiciones"         JSONB`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "pdfUrl"              TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "snapshot"            JSONB`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Producto"       ADD COLUMN IF NOT EXISTS "descripcion"         TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Producto"       ADD COLUMN IF NOT EXISTS "imagenUrl"           TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "ItemCatalogo"   ADD COLUMN IF NOT EXISTS "imagenUrl"           TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "ItemCatalogo"   ADD COLUMN IF NOT EXISTS "productoId"          INTEGER`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "ItemCatalogo"   ADD COLUMN IF NOT EXISTS "codigo"              TEXT`)
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ItemCatalogo_codigo_key" ON "ItemCatalogo"("codigo")`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "EmpresaPerfil"  ADD COLUMN IF NOT EXISTS "pinSupervisor"       TEXT NOT NULL DEFAULT '1234'`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "EmpresaPerfil"  ADD COLUMN IF NOT EXISTS "maxDescuentoCajero" INTEGER NOT NULL DEFAULT 15`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "EmpresaPerfil"  ADD COLUMN IF NOT EXISTS "secuenciasConfig"   JSONB NOT NULL DEFAULT '{}'::jsonb`)
    // Plan.sku — auto-secuenciador (PLN-000001 por defecto)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "sku" TEXT`)
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Plan_sku_key" ON "Plan"("sku") WHERE "sku" IS NOT NULL`)
    // Reservas vinculadas a OrdenTrabajo (no solo cotizaciones)
    await prisma.$executeRawUnsafe(`ALTER TABLE "ReservaInventario" ADD COLUMN IF NOT EXISTS "ordenId" TEXT`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReservaInventario_ordenId_idx" ON "ReservaInventario"("ordenId")`)
    try {
      await prisma.$executeRawUnsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReservaInventario_ordenId_fkey') THEN
          ALTER TABLE "ReservaInventario" ADD CONSTRAINT "ReservaInventario_ordenId_fkey"
            FOREIGN KEY ("ordenId") REFERENCES "OrdenTrabajo"(id) ON DELETE SET NULL;
        END IF;
      END $$`)
    } catch {}
    // BOM (Bill of Materials) — ItemCatalogo bundles + componentes
    await prisma.$executeRawUnsafe(`ALTER TABLE "ItemCatalogo" ADD COLUMN IF NOT EXISTS "esBundle" BOOLEAN NOT NULL DEFAULT false`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ItemCatalogo_esBundle_idx" ON "ItemCatalogo"("esBundle")`)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ItemCatalogoComponente" (
        "id" SERIAL PRIMARY KEY,
        "itemCatalogoId" TEXT NOT NULL REFERENCES "ItemCatalogo"(id) ON DELETE CASCADE,
        "productoId" INTEGER NOT NULL REFERENCES "Producto"(id) ON DELETE RESTRICT,
        "cantidad" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ItemCatalogoComponente_itemCatalogoId_productoId_key" ON "ItemCatalogoComponente"("itemCatalogoId","productoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ItemCatalogoComponente_itemCatalogoId_idx" ON "ItemCatalogoComponente"("itemCatalogoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ItemCatalogoComponente_productoId_idx" ON "ItemCatalogoComponente"("productoId")`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "pagos"               JSONB`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "etapaPipeline"       TEXT NOT NULL DEFAULT 'Borrador'`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Factura_etapaPipeline_idx" ON "Factura"("etapaPipeline")`)
    // Patch sweep (security): empleado dueño + HMAC verifyHash + contador render
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "empleadoId"          INTEGER`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "verifyHash"          TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "pdfRenderAttempts"   INTEGER NOT NULL DEFAULT 0`)
    // M8: timestamp para CAS anti-stale en cron PDF.
    await prisma.$executeRawUnsafe(`ALTER TABLE "Factura"        ADD COLUMN IF NOT EXISTS "pdfInvalidatedAt"    TIMESTAMP`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Factura_empleadoId_idx" ON "Factura"("empleadoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Factura_verifyHash_idx" ON "Factura"("verifyHash")`)
    // WebAuthn credentials table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WebAuthnCredential" (
        "id" TEXT PRIMARY KEY,
        "empleadoId" INTEGER NOT NULL REFERENCES "Empleado"("id") ON DELETE CASCADE,
        "credentialId" TEXT NOT NULL UNIQUE,
        "publicKey" TEXT NOT NULL,
        "counter" BIGINT NOT NULL DEFAULT 0,
        "transports" TEXT[] NOT NULL DEFAULT '{}',
        "deviceName" TEXT,
        "backupEligible" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lastUsedAt" TIMESTAMP
      )
    `)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "WebAuthnCredential_empleadoId_idx" ON "WebAuthnCredential"("empleadoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "WebAuthnCredential_lastUsedAt_idx" ON "WebAuthnCredential"("lastUsedAt")`)
    try {
      await prisma.$executeRawUnsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Factura_empleadoId_fkey') THEN
          ALTER TABLE "Factura" ADD CONSTRAINT "Factura_empleadoId_fkey"
            FOREIGN KEY ("empleadoId") REFERENCES "Empleado"(id) ON DELETE SET NULL;
        END IF;
      END $$`)
    } catch {}
    await prisma.$executeRawUnsafe(`ALTER TABLE "Producto"       ADD COLUMN IF NOT EXISTS "costoPromedio"       DECIMAL(12,2) NOT NULL DEFAULT 0`)
    // Tablas nuevas (idempotente via IF NOT EXISTS)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AuditCaja" (
        "id" SERIAL PRIMARY KEY, "tipo" TEXT NOT NULL, "empleadoId" INTEGER, "facturaId" TEXT,
        "monto" DECIMAL(12,2), "descPct" DECIMAL(5,2), "detalle" TEXT, "ip" TEXT, "ua" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditCaja_tipo_idx"       ON "AuditCaja"("tipo")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditCaja_empleadoId_idx" ON "AuditCaja"("empleadoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditCaja_facturaId_idx"  ON "AuditCaja"("facturaId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditCaja_createdAt_idx"  ON "AuditCaja"("createdAt")`)
    // Hash chain inmutable para AuditCaja (anti-tamper).
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditCaja" ADD COLUMN IF NOT EXISTS "prevHash" TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditCaja" ADD COLUMN IF NOT EXISTS "hash"     TEXT`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditCaja_hash_idx" ON "AuditCaja"("hash")`)
    // Hash chain inmutable para AuditLog (mismo principio: prevHash + hash HMAC).
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditLog"  ADD COLUMN IF NOT EXISTS "prevHash" TEXT`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditLog"  ADD COLUMN IF NOT EXISTS "hash"     TEXT`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AuditLog_hash_idx"  ON "AuditLog"("hash")`)
    // BOM Instalacion: consumoInterno en líneas de OT.
    await prisma.$executeRawUnsafe(`ALTER TABLE "LineaOrdenTrabajo" ADD COLUMN IF NOT EXISTS "consumoInterno" BOOLEAN NOT NULL DEFAULT false`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LineaOrdenTrabajo_consumoInterno_idx" ON "LineaOrdenTrabajo"("consumoInterno")`)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ProductoSerial" (
        "id" SERIAL PRIMARY KEY,
        "productoId" INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
        "serie" TEXT NOT NULL, "estado" TEXT NOT NULL DEFAULT 'Disponible',
        "ubicacion" TEXT, "facturaId" TEXT, "garantiaHasta" TIMESTAMP, "notas" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ProductoSerial_productoId_serie_key" ON "ProductoSerial"("productoId","serie")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ProductoSerial_estado_idx"     ON "ProductoSerial"("estado")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ProductoSerial_facturaId_idx"  ON "ProductoSerial"("facturaId")`)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ReservaInventario" (
        "id" SERIAL PRIMARY KEY,
        "productoId" INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
        "facturaId" TEXT, "cantidad" INTEGER NOT NULL, "expiraEn" TIMESTAMP NOT NULL,
        "liberada" BOOLEAN NOT NULL DEFAULT false, "motivo" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReservaInventario_productoId_idx" ON "ReservaInventario"("productoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReservaInventario_facturaId_idx"  ON "ReservaInventario"("facturaId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReservaInventario_expiraEn_idx"   ON "ReservaInventario"("expiraEn")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReservaInventario_liberada_idx"   ON "ReservaInventario"("liberada")`)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ProductoBundle" (
        "id" SERIAL PRIMARY KEY,
        "padreId" INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
        "hijoId"  INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
        "score" INTEGER NOT NULL DEFAULT 1, "motivo" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ProductoBundle_padreId_hijoId_key" ON "ProductoBundle"("padreId","hijoId")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ProductoBundle_padreId_idx" ON "ProductoBundle"("padreId")`)
    // Device fingerprint + backup codes 2FA
    await prisma.$executeRawUnsafe(`ALTER TABLE "Empleado"     ADD COLUMN IF NOT EXISTS "backupCodes" JSONB NOT NULL DEFAULT '[]'::jsonb`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "SessionToken" ADD COLUMN IF NOT EXISTS "deviceHash"  TEXT`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SessionToken_deviceHash_idx" ON "SessionToken"("deviceHash")`)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DeviceFingerprint" (
        "id" SERIAL PRIMARY KEY,
        "empleadoId" INTEGER NOT NULL REFERENCES "Empleado"("id") ON DELETE CASCADE,
        "hash" TEXT NOT NULL, "label" TEXT, "ip" TEXT, "userAgent" TEXT,
        "primerLogin" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "ultimoLogin" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "DeviceFingerprint_empleadoId_hash_key" ON "DeviceFingerprint"("empleadoId","hash")`)
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "DeviceFingerprint_empleadoId_idx" ON "DeviceFingerprint"("empleadoId")`)
    // FK opcional + índice (idempotente via catalog lookup)
    try {
      await prisma.$executeRawUnsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemCatalogo_productoId_fkey') THEN
          ALTER TABLE "ItemCatalogo" ADD CONSTRAINT "ItemCatalogo_productoId_fkey"
            FOREIGN KEY ("productoId") REFERENCES "Producto"(id) ON DELETE SET NULL;
        END IF;
      END $$`)
    } catch {}
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ItemCatalogo_productoId_idx" ON "ItemCatalogo"("productoId")`)
    console.log('[DB] Schema columns verified (terms + cache + snapshot + pos images + catalog->producto link).')
  } catch (e) {
    console.error('[DB] ensureSchemaColumns FAILED:', e.message)
  }
}

// Crea los buckets de Storage si no existen. Idempotente — la API responde con
// "BucketAlreadyExists" que tratamos como éxito. Resuelve el 502 "Bucket not found"
// que aparecía cuando el bucket no estaba creado manualmente en Supabase.
async function ensureStorageBuckets() {
  if (!supabase) { console.log('[STORAGE] supabase no configurado — skip ensureStorageBuckets.'); return }
  const buckets = [
    { name: process.env.SUPABASE_BUCKET            ?? 'empresa-assets', public: true, fileSizeLimit: 5 * 1024 * 1024 },
    { name: process.env.SUPABASE_INVENTORY_BUCKET  ?? 'inventario-img', public: true, fileSizeLimit: 5 * 1024 * 1024 },
    { name: process.env.SUPABASE_PDF_BUCKET        ?? 'documentos-pdf', public: true, fileSizeLimit: 20 * 1024 * 1024 },
  ]
  for (const b of buckets) {
    try {
      const { error } = await supabase.storage.createBucket(b.name, {
        public:          b.public,
        fileSizeLimit:   b.fileSizeLimit,
        allowedMimeTypes: undefined, // se valida en el endpoint (magic bytes)
      })
      if (!error) { console.log(`[STORAGE] bucket "${b.name}" creado (public=${b.public}).`); continue }
      // Idempotencia: si ya existe, Supabase devuelve esto (varía el shape).
      const msg = String(error.message ?? '').toLowerCase()
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`[STORAGE] bucket "${b.name}" ya existe.`)
      } else {
        console.error(`[STORAGE] no se pudo crear "${b.name}":`, error.message)
      }
    } catch (e) {
      console.error(`[STORAGE] excepción creando "${b.name}":`, e.message)
    }
  }
}

// Habilita RLS en runtime como fallback al migrate. Idempotente — corre cada cold
// start. Si la migración ya aplicó, los EXECUTE format son no-op por igual estado.
async function ensureRowLevelSecurity() {
  if (process.env.SKIP_RLS_ENSURE === 'true') return
  try {
    await prisma.$executeRawUnsafe(`
      DO $$
      DECLARE t RECORD;
      BEGIN
        FOR t IN
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
        LOOP
          EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
          EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', t.tablename);
          EXECUTE format('DROP POLICY IF EXISTS "service_role_all" ON public.%I', t.tablename);
          EXECUTE format($p$
            CREATE POLICY "service_role_all" ON public.%I
            FOR ALL
            TO postgres, service_role
            USING (true)
            WITH CHECK (true)
          $p$, t.tablename);
        END LOOP;
      END $$;
    `)
    console.log('[DB] RLS enabled on all public tables (service_role_all policy).')
  } catch (e) {
    console.error('[DB] ensureRowLevelSecurity FAILED:', e.message)
  }
}

// ─── Montaje de routers modulares (Stage 1) ─────────────────────────────────
// Cada router recibe las dependencias inyectadas (prisma, middlewares, schemas,
// auditReq, helpers, limiters). Se mantienen como factories para preservar
// singletons (cache, throttles, stores in-memory) entre server.js y rutas.
// Se montan AL FINAL para que Express resuelva primero los handlers legacy
// inline; cuando un handler migre a routes/*.js se elimina de server.js y el
// router toma control sin más cambios.
// SECUENCIA_DEFAULTS + generarSiguienteCodigo viven ahora en
// shared/services/sequences.service.js (ver bloque de instanciación arriba).
const _routerDeps = {
  prisma,
  middlewares: _sharedMw,
  schemas:     sharedSchemas,
  helpers:     sharedHelpers,
  auditReq,
  // Limiters globales reusables. Los rate-limiters específicos de un dominio
  // (forgot/checkout/tracking/verify/empresaPublic/catalogoPublico/pinVerify)
  // se declaran localmente en sus respectivos modules/<dominio>/router.js
  // para evitar acoplamiento con el monolito.
  limiters: {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, bulkPdfLimiter,
  },
  // Helpers monolíticos pasados a routers para que handlers extraídos
  // sigan funcionando sin re-implementación. A medida que cada router migra
  // su lógica completa, estos punteros se podrán mover a shared/.
  // completarLogin se eliminó: vive en modules/auth/service.js. Los otros
  // routers lo destructuran pero nunca lo invocan — destructure undefined
  // no rompe (se limpiará al migrar cada módulo).
  twoFAStore,
  challengeStore,
  warmChallengeStore,
  IDLE_TTL_MS,
  generarSiguienteCodigo,
  generarPdfDeFactura,
  buildPdfData,
  subirPdfAlStorage,
  invalidarPdfCache,
  renderPdfDoc,
  generarPdfDocumento,
  persistirVerifyHash,
  facturaVerifyHash,
  PUBLIC_VERIFY_BASE,
  emailTransporter,
  sendFacturaPDF,
  PERMISSIONS_MAP,
  // Vault PAM (helpers de cifrado siguen en server.js; routers definen sus
  // propios stores y guardas localmente al cargar los handlers migrados).
  VAULT_KEY,
  vaultEncrypt,
  vaultDecrypt,
  // Storage
  supabase,
  SUPABASE_BUCKET,
  INVENTORY_BUCKET,
  KINDS_VALIDOS,
  KINDS_INVENTARIO,
  MIME_EXT,
  detectMimeFromBuffer,
  svgSeguro,
  comprimirImagen,
  esAssetUrlSegura,
  esUrlPublicaSegura,
  pathFromSupabaseUrl,
  // Portal helpers (setPortalCookie es local a modules/crm/portal-b2c/router.js)
  signPortalToken,
  // Misc constants
  NIVEL_PROPIETARIO_ABSOLUTO,
  protegerPropietario,
  // Sequence defaults (definido arriba)
  SECUENCIA_DEFAULTS,
};
app.use('/api', createAuthRouter(_routerDeps));
app.use('/api', createCrmRouter(_routerDeps));
app.use('/api', createInventarioRouter(_routerDeps));
app.use('/api', createVentasRouter(_routerDeps));
app.use('/api', createAdminRouter(_routerDeps));

// Arranca CRON jobs nocturnos (idempotente — solo registra una vez).
// Vive en backend/jobs/cron.js · cierra sobre prisma inyectado.
startCronJobs({ prisma });

async function startServer() {
  try {
    await prisma.$connect();
    console.log('[DB] Prisma connected to Supabase successfully.');
    await ensureSchemaColumns();
    await ensureRowLevelSecurity();
    await ensureStorageBuckets();
    // Libera reservas expiradas (TTL 72h por default). Idempotente.
    try {
      const r = await prisma.reservaInventario.updateMany({
        where: { liberada: false, expiraEn: { lt: new Date() } },
        data:  { liberada: true },
      })
      if (r.count > 0) console.log(`[RESERVA] ${r.count} reservas expiradas liberadas`)
    } catch {}
    await seedNomenclaturas();
  } catch (err) {
    console.error('[DB] CRITICAL: Prisma failed to connect to database:', err.message);
    process.exit(1);
  }

  // Warm-up Puppeteer/Chromium + page pool en background. Sin await: el servidor
  // empieza a aceptar requests mientras el browser y 2 páginas idle se inicializan.
  // Cold-start primer PDF baja de ~3s a ~50ms si el warmup termina antes.
  // prerenderPdfsBatch vive ahora en modules/ventas/_cron.js y arranca solo via
  // startCronJobs() — sin necesidad de disparo manual desde aquí.
  const { warmupPages } = require('./services/pdf-generator')
  warmupPages().catch(err => console.error('[PDF WARMUP]', err.message))

  // Pre-generate RSA challenges so first login after cold start never fails
  await warmChallengeStore(3)

  app.listen(PORT, () => {
    console.log(`[SERVER] ERP backend running on port ${PORT}`);
    console.log(`[ENV] NODE_ENV=${process.env.NODE_ENV ?? 'development'} | CORS=${[...ALLOWED_ORIGINS].join(', ')}`);
  });
}

startServer();
