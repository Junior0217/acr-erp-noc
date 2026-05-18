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
const createNcfService        = require('./shared/services/ncf.service');
const createBomExpansionSvc   = require('./shared/services/bom-expansion.service');
// Helpers + Schemas destructurados al scope global para que los handlers legacy
// inline que aún viven en server.js sigan funcionando sin tocarlos uno por uno.
// A medida que cada handler migre a routes/*.js, esta lista se irá vaciando.
const {
  UUID_RE, validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
  emptyStr, nullStr, optIdent, optCedulaRD, fmtPhone, fmtCedula, fmtRNC,
  formatCliente, formatSuplidor, formatProspecto, reqFingerprint,
  computeDeviceHash, labelFromUA, _stripPollutionKeys, bodyLimit, getClientIp,
  stripTags, descripcionToRaw,
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
const createInventarioRouter = require('./modules/inventario');
const createVentasRouter     = require('./routes/ventas');
const createAdminRouter      = require('./routes/admin');
const createDgiiRouter       = require('./modules/dgii');
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
const _ncfService = createNcfService({ prisma });
const _bomService = createBomExpansionSvc({ prisma });
// M4: SSE stock hub singleton — un proceso, un hub. POS service emite tras
// deducir stock; el router de inventario expone /stock/stream que suscribe.
const createStockStreamHub = require('./shared/services/stock-stream.service');
const _stockHub = createStockStreamHub();

// #4: hash-chain Cotizaciones. Append cada evento (crear/editar/etapa) +
// endpoint /cotizaciones/:id/historial valida la cadena (anti-tamper).
const createCotEventoSvc = require('./shared/services/cotizacion-evento.service');
const _cotEventoSvc = createCotEventoSvc({ prisma });
const { _normStr, _normMoney, _normDateYMD, facturaVerifyHash, persistirVerifyHash }
  = createVerifyHashService({ prisma });

// ─── Middlewares (shared/middlewares.js factory) ──────────────────────────────
// auditReq se inyecta para que verificarJWT/protegerPropietario puedan loguear
// eventos sin acoplarse a la implementación. Destructuramos al scope global
// para que los handlers legacy inline sigan refiriéndose a `verificarJWT` etc.
//
// vaultLastReveal: Map COMPARTIDO entre el middleware vaultCooldownGuard
// (shared/middlewares.js) y el modules/crm/credenciales/service.js. Sin
// inyección explícita, ambos crearían Maps separados → bypass del cooldown
// posible. Fix Cyber Neo silent.
const _vaultLastReveal = new Map();
const _sharedMw = createMiddlewares({ prisma, auditReq, vaultLastReveal: _vaultLastReveal });
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
  // x-totp: header obligatorio para acciones destructivas/fiscales (delete
  // empleado, generar 606/607, offboard). Sin él en allowedHeaders, el
  // navegador aborta el preflight OPTIONS antes de mandar el POST real.
  // x-portal-csrf + pct-csrf: doble-submit cookie del portal cliente.
  // idempotency-key: M2 — anti doble-emit POS. X-Idempotent exposed para que
  // el frontend identifique respuestas cacheadas (no es factura nueva).
  allowedHeaders:  ['Content-Type', 'Authorization', 'Accept', 'X-CSRF-Token', 'x-totp', 'x-portal-csrf', 'pct-csrf', 'idempotency-key', 'Idempotency-Key'],
  exposedHeaders:  ['X-CSRF-Token', 'X-App-Version', 'X-Boot-At', 'X-Idempotent'],
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

// /api/health/legacy ELIMINADO (Fase 1.4): dup de /api/health sin uso real.
// El liveness probe oficial es /api/health (sin auth, exento del limiter).

// ─── Vault PAM (AES-256-GCM) ──────────────────────────────────────────────────
// Crypto helpers + VAULT_KEY validation viven AHORA en
// backend/modules/crm/credenciales/service.js (Fase 2.6). Aquí se conserva
// solo el warning de boot — la lógica de cifrado es scope-local del módulo
// para que el plaintext NUNCA viaje fuera del service. Cualquier consumidor
// futuro debe pasar por ese service, no por server.js helpers.
if (!process.env.VAULT_KEY) {
  console.warn('[VAULT] WARNING: VAULT_KEY not set — credential vault disabled.')
}

// Inventario uploads + empresa upload migraron a modules/inventario/uploads/
// y modules/admin/empresa/ respectivamente (Fase 1.2 + 1.4). server.js solo
// orquesta el wiring.

// ─── PDF stack (Blueprint Fase 1.3) ──────────────────────────────────────────
// Todo el stack vive en backend/modules/ventas/pdf/: buildPdfData,
// subirPdfAlStorage, invalidarPdfCache, invalidarPdfsSiCambioTemplate,
// renderVerifyQr, mergeCondiciones, _composicionFactura, renderFacturaPdf (era
// generarPdfDeFactura), prerenderPdfsBatch, PUBLIC_VERIFY_BASE,
// PDF_TEMPLATE_VERSION, PDF_CACHE_BUCKET, bulkPdfSchema, bulkPdfLimiter,
// mapWithConcurrency + rutas GET /cotizaciones/:id/pdf, GET /facturas/:id/pdf,
// POST /pdf/bulk.
// Aquí instanciamos el módulo UNA sola vez y lo pasamos vía _routerDeps a
// ventas/index.js (mount router + cron + lib). El handler legacy
// /facturas/:id/condiciones (arriba) usa _pdfModule.service.invalidarPdfCache.
const buildPdfModule = require('./modules/ventas/pdf');
const QRCode_pdfStack = require('qrcode'); // ya está en deps; alias para claridad
const _pdfModule = buildPdfModule({
  prisma,
  middlewares: _sharedMw,
  auditReq,
  helpers: sharedHelpers,
  supabase,
  inlineAssets,
  renderPdfDoc,
  generarPdfDocumento,
  facturaVerifyHash,
  QRCode: QRCode_pdfStack,
});
console.log(`[VERIFY] PUBLIC_VERIFY_BASE=${_pdfModule.service.PUBLIC_VERIFY_BASE}`);

// Handlers inline restantes migrados (Fase 1.4):
//   /api/productos/:id/bundles     → modules/ventas/catalogo
//   /api/catalogo/:id/bundles      → modules/ventas/catalogo
//   /api/productos/:id/series      → modules/inventario
//   /api/cotizaciones/:id/etapa    → modules/ventas/cotizaciones
//   /api/auditoria/caja            → modules/admin/ops
//   /api/auditoria/caja/verify     → modules/admin/ops
//   /api/auditoria/log/verify      → modules/admin/ops
//   /api/facturas/:id/condiciones  → modules/ventas/facturas (usa pdfService inyectado)
// stripTags + descripcionToRaw centralizados en shared/helpers.js (Fase 1.4).

// ─── Server ───────────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// /api/dev/seed-portal ELIMINADO (Fase 1.4) — endpoint HTTP dev movido a script
// standalone: `node backend/scripts/seeds/portal.js`. Cero superficie pública,
// audit trail via shell history, idempotente vía upsert.

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
  // (forgot/checkout/tracking/verify/empresaPublic/catalogoPublico/pinVerify/
  // bulkPdf) se declaran localmente en sus respectivos modules/<dominio>/
  // router.js para evitar acoplamiento con el monolito.
  limiters: {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter,
  },
  // Helpers monolíticos pasados a routers para que handlers extraídos
  // sigan funcionando sin re-implementación. A medida que cada router migra
  // su lógica completa, estos punteros se podrán mover a shared/.
  // completarLogin → vive en modules/auth/service.js.
  // generarPdfDeFactura / buildPdfData / subirPdfAlStorage / invalidarPdfCache /
  // PUBLIC_VERIFY_BASE → viven en modules/ventas/pdf/service.js (acceso vía
  // _routerDeps.pdfModule.service para handlers legacy que aún los necesiten).
  twoFAStore,
  challengeStore,
  warmChallengeStore,
  IDLE_TTL_MS,
  generarSiguienteCodigo,
  pdfModule:        _pdfModule,
  // NCF DGII allocator centralizado (Fase 2.3). El config admin
  // (modules/admin/empresa/ncf/) lo consume; facturas/notas también lo
  // consumen. CERO acceso directo a prisma.configuracionNCF desde routers.
  ncfService:       _ncfService,
  // BOM expansion centralizado (Fase 2.4) — pos + ordenes lo consumen.
  bomService:       _bomService,
  stockHub:         _stockHub,
  cotEventoSvc:     _cotEventoSvc,
  renderPdfDoc,
  generarPdfDocumento,
  persistirVerifyHash,
  facturaVerifyHash,
  emailTransporter,
  sendFacturaPDF,
  PERMISSIONS_MAP,
  // Vault PAM: helpers de cifrado migraron a modules/crm/credenciales/service.js
  // (Fase 2.6). Aquí pasamos el Map COMPARTIDO con vaultCooldownGuard del
  // shared/middlewares para que el cooldown 30s no pueda bypassearse.
  vaultLastReveal: _vaultLastReveal,
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
  // Express app expuesta para admin/ops._scanRoutes (introspección /_meta/endpoints).
  // Fix de ReferenceError latente: el código original referenciaba `app` como
  // naked identifier dentro del factory, rompiendo al primer hit del endpoint.
  app,
};
app.use('/api', createAuthRouter(_routerDeps));
app.use('/api', createCrmRouter(_routerDeps));
app.use('/api', createInventarioRouter(_routerDeps));
app.use('/api', createVentasRouter(_routerDeps));
app.use('/api', createAdminRouter(_routerDeps));
app.use('/api', createDgiiRouter(_routerDeps));

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
