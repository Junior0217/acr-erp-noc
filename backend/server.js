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

// ─── JWE-equivalent: AES-256-GCM wrapper (opaque cookie, RFC 7516 semantics) ──
const jweKey  = crypto.createHash('sha256').update(process.env.JWT_SECRET || '').digest()
const totpKey = crypto.createHash('sha256').update((process.env.JWT_SECRET || '') + ':totp').digest()

function wrapJWT(jwtStr) {
  const iv  = crypto.randomBytes(12)
  const cip = crypto.createCipheriv('aes-256-gcm', jweKey, iv)
  const enc = Buffer.concat([cip.update(jwtStr, 'utf8'), cip.final()])
  const tag = cip.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`
}

function unwrapJWT(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('bad token')
  const dec = crypto.createDecipheriv('aes-256-gcm', jweKey, Buffer.from(parts[0], 'base64url'))
  dec.setAuthTag(Buffer.from(parts[1], 'base64url'))
  return Buffer.concat([dec.update(Buffer.from(parts[2], 'base64url')), dec.final()]).toString('utf8')
}

function encryptTOTP(secret) {
  const iv  = crypto.randomBytes(12)
  const cip = crypto.createCipheriv('aes-256-gcm', totpKey, iv)
  const enc = Buffer.concat([cip.update(secret, 'utf8'), cip.final()])
  const tag = cip.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`
}

function decryptTOTP(stored) {
  const p = stored.split('.')
  if (p.length !== 3) throw new Error('invalid totp')
  const dec = crypto.createDecipheriv('aes-256-gcm', totpKey, Buffer.from(p[0], 'base64url'))
  dec.setAuthTag(Buffer.from(p[1], 'base64url'))
  return Buffer.concat([dec.update(Buffer.from(p[2], 'base64url')), dec.final()]).toString('utf8')
}

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

// ─── AuditLog helpers ─────────────────────────────────────────────────────────

function auditReq(evento, req, meta, overrides) {
  const ip       = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null
  const ua       = req?.headers?.['user-agent'] || null
  const userId   = overrides?.userId   ?? req?.user?.sub    ?? null
  const userName = overrides?.userName ?? req?.user?.nombre ?? null
  setImmediate(async () => {
    try { await prisma.auditLog.create({ data: { evento, usuarioId: userId, userName, ip, ua, meta: meta ?? undefined } }) } catch {}
  })
}

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
  '/api/servicios/ordenes':    '/api/orden-instalacion',
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

// Fingerprint = SHA-256(IP + User-Agent) — prevents shared-NAT users (same office IP)
// from counting against each other's rate limit buckets.
function reqFingerprint(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? ''
  const ua = req.headers['user-agent'] ?? ''
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex')
}

// /api/health DEBE ir antes del limiter global — Render lo golpea cada 30s
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
app.use('/api/', (req, res, next) => {
  res.setHeader('X-App-Version', APP_VERSION)
  res.setHeader('X-Boot-At',     String(APP_BOOT_AT))
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

const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.sub ? `billing:${req.user.sub}` : reqFingerprint(req),
  store: makeRateLimitStore(),
  message: { error: 'Límite de operaciones de facturación alcanzado. Intente en 1 minuto.' },
});

app.use(express.json({ limit: '50kb' }));

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
    return res.status(403).json({ error: 'CSRF token inválido.' })
  }
  next()
}
app.use(csrfMiddleware);

// ─── Zod Helpers ─────────────────────────────────────────────────────────────

const emptyStr  = z.literal('');
const nullStr   = (max = 20) => z.string().max(max).or(emptyStr).optional().transform(v => (v === '' || v == null) ? null : v);
const optIdent  = (max = 20) => z.string().min(1).max(max).or(emptyStr).optional().transform(v => (v === '' || v == null) ? null : v);

/**
 * Validador de Cédula Dominicana (Mod-10 / Luhn variant DGII).
 * Cédula: 11 dígitos. Los primeros 10 generan el dígito verificador
 * con pesos alternados [1,2] y reducción a un solo dígito (mod 10 +1 si >9).
 *
 * Devuelve true si la cédula es estructuralmente válida.
 * NO verifica que exista en DGII (eso requiere su API).
 */
function validarCedulaRD(cedulaRaw) {
  if (typeof cedulaRaw !== 'string') return false
  const d = cedulaRaw.replace(/\D/g, '')
  if (d.length !== 11) return false
  if (/^(\d)\1{10}$/.test(d)) return false  // todos iguales (00000000000) = inválida
  const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]
  let sum = 0
  for (let i = 0; i < 10; i++) {
    let p = parseInt(d[i], 10) * weights[i]
    if (p > 9) p = (p % 10) + Math.floor(p / 10)
    sum += p
  }
  const check = (10 - (sum % 10)) % 10
  return check === parseInt(d[10], 10)
}

/** Zod refinement reusable: cédula RD válida o null/empty (opcional). */
const optCedulaRD = z.string().max(20).optional().nullable().transform(v => {
  if (v === '' || v == null) return null
  return v
}).superRefine((v, ctx) => {
  if (v == null) return
  const digits = v.replace(/\D/g, '')
  if (digits.length !== 11) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cédula debe tener 11 dígitos.' })
    return
  }
  if (!validarCedulaRD(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cédula RD inválida (dígito verificador no coincide).' })
  }
})

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const passwordSchema = z.string()
  .min(8, 'Mínimo 8 caracteres.')
  .regex(/[^a-zA-Z0-9\s]/, 'Requiere al menos un símbolo especial (ej. ! @ # $ % & *).');

const empleadoSchema = z.object({
  nombre:   z.string().min(2).max(100),
  email:    z.string().email().trim(),
  roleIds:  z.array(z.number().int().positive()).optional().default([]),
  password: passwordSchema,
});

const empleadoUpdateSchema = z.object({
  nombre:   z.string().min(2).max(100).optional(),
  email:    z.string().email().trim().optional(),
  roleIds:  z.array(z.number().int().positive()).optional(),
  // Accept strong password OR empty string (= no change). Transform '' → undefined.
  password: z.union([passwordSchema, z.literal('')])
              .optional()
              .transform(v => (v === '' || v == null) ? undefined : v),
});

const asistenciaSchema = z.object({
  empleadoId: z.number().int().positive(),
  tipo:       z.enum(['Entrada', 'Salida']),
  latitud:    z.string().max(30).optional().nullable(),
  longitud:   z.string().max(30).optional().nullable(),
});

const clienteBaseShape = z.object({
  noCliente:           z.string().min(1).max(20),
  razonSocial:         z.string().min(2).max(200),
  nombreComercial:     nullStr(100),
  rnc:                 optIdent(20),
  registroMercantil:   nullStr(30),
  tipoEmpresa:         z.string().min(1).max(30),
  fechaInicio:         z.coerce.date().optional(),
  nombreContacto:      z.string().min(2).max(100),
  apellidoContacto:    nullStr(100),
  cedula:              optCedulaRD,
  cargo:               nullStr(80),
  direccion:           z.string().min(2).max(300),
  sector:              z.string().min(1).max(100),
  provincia:           z.string().min(1).max(100),
  telefonoPrincipal:   z.string().min(7).max(20),
  telefonoAlternativo: nullStr(20),
  email:               z.string().email().trim(),
  website:             nullStr(100),
  tipoCliente:         z.string().min(1).max(50),
  itbis:               z.boolean().default(true),
  promHorasMes:        z.number().int().min(0).max(744).optional(),
  latitud:             nullStr(20),
  longitud:            nullStr(20),
  activo:              z.boolean().default(true),
  fechaInactivo:       z.coerce.date().optional(),
  limiteCredito:       z.coerce.number().nonnegative().default(0),
  diasCredito:         z.coerce.number().int().min(0).default(0),
  tipoNcf:             z.string().default('Consumidor Final'),
});

const clienteSchema = clienteBaseShape.superRefine((data, ctx) => {
  if (!data.rnc && !data.cedula) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RNC o Cédula es obligatorio.', path: ['rnc'] });
  }
});

const clienteUpdateSchema = clienteBaseShape.omit({ noCliente: true }).partial();

const suplidorBaseShape = z.object({
  noSuplidor:        z.string().min(1).max(20),
  razonSocial:       z.string().min(2).max(200),
  nombreComercial:   nullStr(100),
  rnc:               optIdent(20),
  direccion:         z.string().min(2).max(300),
  sector:            z.string().min(1).max(100),
  provincia:         z.string().min(1).max(100),
  latitud:           nullStr(20),
  longitud:          nullStr(20),
  nombreContacto:    z.string().min(2).max(100),
  cedula:            optCedulaRD,
  cargo:             nullStr(80),
  telefonoPrincipal: z.string().min(7).max(20),
  telefonoAlt:       nullStr(20),
  email:             z.string().email().trim().or(emptyStr).optional().transform(v => (v === '' || v == null) ? null : v),
  contactoAlt:       nullStr(150),
  actividad:         z.string().min(1).max(100),
  camposUsuario:     nullStr(500),
  fechaInicio:       z.coerce.date().optional(),
  activo:            z.boolean().default(true),
  fechaInactivo:     z.coerce.date().optional(),
  limiteCredito:     z.coerce.number().nonnegative().default(0),
  diasCredito:       z.coerce.number().int().min(0).default(0),
});

const suplidorSchema = suplidorBaseShape.superRefine((data, ctx) => {
  if (!data.rnc && !data.cedula) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RNC o Cédula es obligatorio.', path: ['rnc'] });
  }
});

const suplidorUpdateSchema = suplidorBaseShape.omit({ noSuplidor: true }).partial();

const prospectoSchema = z.object({
  nombre:             z.string().min(2).max(150),
  telefono:           z.string().min(7).max(20),
  servicioInteresado: z.string().min(1).max(100),
  origen:             z.enum(['WhatsApp', 'Llamada', 'Referido', 'Web', 'Presencial', 'Otro']).default('WhatsApp'),
  notas:              nullStr(1000),
  latitud:            nullStr(20),
  longitud:           nullStr(20),
  estado:             z.enum(['Nuevo', 'Contactado', 'Interesado', 'Negociación', 'Perdido', 'Convertido']).default('Nuevo'),
});

const prospectoUpdateSchema = prospectoSchema.partial();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validUUID(id) { return UUID_RE.test(id); }
function rejectBadId(req, res) {
  if (!validUUID(req.params.id)) { res.status(400).json({ error: 'ID inválido.' }); return true; }
  return false;
}

// ─── Formateadores ────────────────────────────────────────────────────────────

function fmtPhone(v) {
  if (!v) return v;
  const d = String(v).replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
function fmtCedula(v) {
  if (!v) return v;
  const d = String(v).replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}
function fmtRNC(v) {
  if (!v) return v;
  const d = String(v).replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 3)}-${d.slice(3, 8)}-${d.slice(8)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}

function formatCliente(c) {
  return { ...c, rnc: fmtRNC(c.rnc), telefonoPrincipal: fmtPhone(c.telefonoPrincipal), telefonoAlternativo: fmtPhone(c.telefonoAlternativo), cedula: fmtCedula(c.cedula), limiteCredito: Number(c.limiteCredito) };
}
function formatSuplidor(s) {
  return { ...s, rnc: fmtRNC(s.rnc), telefonoPrincipal: fmtPhone(s.telefonoPrincipal), telefonoAlt: fmtPhone(s.telefonoAlt), cedula: fmtCedula(s.cedula), limiteCredito: Number(s.limiteCredito) };
}
function formatProspecto(p) {
  return { ...p, telefono: fmtPhone(p.telefono) };
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

async function verificarJWT(req, res, next) {
  const wrapped = req.signedCookies?.token;
  if (!wrapped) return res.status(401).json({ error: 'No autenticado.' });
  try {
    const jwtStr  = unwrapJWT(wrapped);
    const payload = jwt.verify(jwtStr, process.env.JWT_SECRET);
    const ua      = req.headers['user-agent'] || '';
    if (payload.ua != null && payload.ua !== ua) {
      auditReq('session:ua_mismatch', req, { jti: payload.jti }, { userId: payload.sub });
      await prisma.sessionToken.deleteMany({ where: { jti: payload.jti } });
      res.clearCookie('token');
      return res.status(401).json({ error: 'Sesión inválida.' });
    }
    const session = await prisma.sessionToken.findUnique({ where: { jti: payload.jti } });
    if (!session || session.expiresAt < new Date()) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Sesión expirada.' });
    }
    req.user = payload;

    // Sliding refresh: if JWT has < 15min left, re-sign and extend session
    const nowSec    = Math.floor(Date.now() / 1000);
    const remaining = (payload.exp ?? 0) - nowSec;
    if (remaining > 0 && remaining < 900) {
      const newJwt = jwt.sign(
        { sub: payload.sub, nombre: payload.nombre, permisos: payload.permisos, jti: payload.jti, ua: payload.ua, ...(payload.needs2FASetup ? { needs2FASetup: true } : {}) },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
      );
      const newToken = wrapJWT(newJwt);
      const isProd   = process.env.NODE_ENV === 'production';
      const cookieOpts = {
        httpOnly: true, signed: true,
        secure:   isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge:   30 * 60 * 1000,
        ...(isProd ? { partitioned: true } : {}),
      };
      res.cookie('token', newToken, cookieOpts);
      await prisma.sessionToken.update({ where: { jti: payload.jti }, data: { expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
    }

    next();
  } catch {
    res.clearCookie('token');
    res.status(401).json({ error: 'Token inválido.' });
  }
}

function requerirPermiso(permiso) {
  return (req, res, next) => {
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : [];
    if (permisos.includes('sistema:owner')) return next();
    if (!permisos.includes(permiso)) return res.status(403).json({ error: 'Sin permiso para esta acción.' });
    next();
  };
}

/**
 * REGLA DE ORO: NO hardcodear 'sistema:owner'. Para acciones críticas
 * que exigen "Propietario Absoluto", validar nivel del rol del DB.
 * Default umbral = 100 (Propietario Absoluto). Subible a 110/120 sin tocar código.
 */
const NIVEL_PROPIETARIO_ABSOLUTO = 100

async function esPropietarioAbsoluto(userId) {
  if (!userId) return false
  try {
    const roles = await prisma.rol.findMany({
      where:  { activo: true, empleados: { some: { id: userId } } },
      select: { nivel: true },
    })
    const max = roles.reduce((m, r) => Math.max(m, r.nivel ?? 0), 0)
    return max >= NIVEL_PROPIETARIO_ABSOLUTO
  } catch { return false }
}

function requerirNivel(min = NIVEL_PROPIETARIO_ABSOLUTO) {
  return async (req, res, next) => {
    const ok = await esPropietarioAbsoluto(req.user?.sub)
    if (!ok) return res.status(403).json({ error: `Acción reservada a rol nivel ${min}+ (Propietario Absoluto).` })
    next()
  }
}

async function protegerPropietario(req, res, next) {
  const targetId = parseInt(req.params.id ?? req.params.empleadoId);
  if (!targetId) return next();
  if (req.user?.permisos?.includes('sistema:owner')) return next();
  try {
    const [callerRoles, targetEmp] = await Promise.all([
      prisma.rol.findMany({
        where: { empleados: { some: { id: req.user.sub } }, activo: true },
        select: { nivel: true },
      }),
      prisma.empleado.findUnique({
        where: { id: targetId },
        include: { roles: { where: { activo: true }, select: { nivel: true } } },
      }),
    ]);
    if (!targetEmp) return next();
    const callerNivel = callerRoles.length ? Math.max(...callerRoles.map(r => r.nivel ?? 0)) : 0;
    const targetNivel = targetEmp.roles.length ? Math.max(...targetEmp.roles.map(r => r.nivel ?? 0)) : 0;
    if (callerNivel <= targetNivel) {
      return res.status(403).json({ error: `Sin autorización: tu nivel (${callerNivel}) no supera el nivel del objetivo (${targetNivel}).` });
    }
    next();
  } catch { next(); }
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

// Idle timeout: 30 min sliding session. JWT TTL = 30 min; renewed on activity
// via sliding refresh in verificarJWT. RememberMe extends to 30d but keeps idle.
const IDLE_TTL_MS = 30 * 60 * 1000

function completarLogin(empleado, req, res, rememberMe = false, needs2FASetup = false) {
  const jti       = crypto.randomUUID()
  const ua        = req.headers['user-agent'] || ''
  const ip        = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null
  const ttl       = rememberMe ? 30 * 24 * 60 * 60 * 1000 : IDLE_TTL_MS
  const jwtTTL    = rememberMe ? '30d' : '30m'
  const expiresAt = new Date(Date.now() + ttl)
  // Single-session enforcement: revoke all prior sessions of this user
  return prisma.sessionToken.deleteMany({ where: { empleadoId: empleado.id } }).then(() =>
  prisma.sessionToken.create({ data: { jti, empleadoId: empleado.id, userAgent: ua, expiresAt, ip } })).then(() => {
    const permisos = [...new Set([
      ...(empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : []),
      ...(Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra : []),
    ])]
    const jwtPayload = { sub: empleado.id, nombre: empleado.nombre, permisos, jti, ua, ...(needs2FASetup ? { needs2FASetup: true } : {}) }
    const jwtStr = jwt.sign(jwtPayload, process.env.JWT_SECRET, { expiresIn: jwtTTL })
    const token  = wrapJWT(jwtStr)
    const csrf    = crypto.randomBytes(32).toString('hex')
    const isProd  = process.env.NODE_ENV === 'production'
    const cookieBase = {
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge:   ttl,
      ...(isProd ? { partitioned: true } : {}),
    }
    res.cookie('csrf',  csrf,  { ...cookieBase, httpOnly: false })
    res.cookie('token', token, { ...cookieBase, httpOnly: true, signed: true })
    res.setHeader('X-CSRF-Token', csrf)
    const response = { id: empleado.id, nombre: empleado.nombre, cargo: empleado.cargo, permisos, csrfToken: csrf }
    if (needs2FASetup) response.needs2FASetup = true
    return response
  })
}

// ─── Portal JWT ───────────────────────────────────────────────────────────────

const PORTAL_JWT_SECRET = (process.env.JWT_SECRET || '') + ':portal'

function signPortalToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, email: usuario.email, nombre: usuario.nombre, clienteId: usuario.clienteId ?? null, type: 'portal' },
    PORTAL_JWT_SECRET,
    { expiresIn: '30d' }
  )
}

async function verificarPortalJWT(req, res, next) {
  const raw = req.cookies?.pct
  if (!raw) return res.status(401).json({ error: 'No autenticado.' })
  try {
    const payload = jwt.verify(raw, PORTAL_JWT_SECRET)
    if (payload.type !== 'portal') throw new Error('wrong type')
    req.portalUser = payload
    next()
  } catch {
    res.clearCookie('pct')
    res.status(401).json({ error: 'Sesión expirada.' })
  }
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

// ─── Portal Public Routes (early — no auth required) ─────────────────────────

const portalRegisterSchema = z.object({
  nombre:   z.string().min(2).max(200),
  email:    z.string().email().trim().toLowerCase(),
  password: z.string().min(6).max(100),
})

const portalLoginSchema = z.object({
  email:    z.string().email().trim().toLowerCase(),
  password: z.string().min(1),
})

function setPortalCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production'
  const maxAge = 30 * 24 * 60 * 60 * 1000
  res.cookie('pct', token, {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge,
    ...(isProd ? { partitioned: true } : {}),
  })
  // CSRF companion: NOT httpOnly (frontend portal lo lee y manda como header)
  const csrfPortal = crypto.randomBytes(32).toString('hex')
  res.cookie('pct-csrf', csrfPortal, {
    httpOnly: false,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge,
    ...(isProd ? { partitioned: true } : {}),
  })
  res.setHeader('X-Portal-CSRF', csrfPortal)
  return csrfPortal
}

// Endpoint para que el frontend portal recupere el token CSRF tras hard reload
app.get('/api/portal/auth/csrf', verificarPortalJWT, (req, res) => {
  const existing = req.cookies?.['pct-csrf']
  if (existing) return res.json({ csrfToken: existing })
  // Si por algún motivo se perdió, regenera
  const isProd = process.env.NODE_ENV === 'production'
  const fresh  = crypto.randomBytes(32).toString('hex')
  res.cookie('pct-csrf', fresh, {
    httpOnly: false, secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge:  30 * 24 * 60 * 60 * 1000,
    ...(isProd ? { partitioned: true } : {}),
  })
  res.json({ csrfToken: fresh })
})

async function getOrCreatePortalSettings() {
  return prisma.portalSettings.upsert({
    where:  { id: 1 },
    update: {},
    create: { id: 1 },
  })
}

app.get('/api/portal/catalog', async (req, res) => {
  try {
    const { categoria, tipo, search } = req.query
    const where = { activo: true }
    if (categoria) where.categoria = categoria
    if (tipo) where.tipo = tipo
    if (search) where.nombre = { contains: search, mode: 'insensitive' }
    const items = await prisma.itemCatalogo.findMany({
      where,
      orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
      select: { id: true, nombre: true, descripcion: true, tipo: true, categoria: true, precio: true, tipoItem: true },
    })
    res.json({ data: items, total: items.length })
  } catch (e) { console.error('[GET /api/portal/catalog]', e.message); res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/portal/settings', async (req, res) => {
  try {
    const settings = await getOrCreatePortalSettings()
    res.json(settings)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.put('/api/portal/settings', verificarJWT, requerirPermiso('sistema:config'), async (req, res) => {
  try {
    const schema = z.object({
      mostrarEquipos:   z.boolean().optional(),
      permitirPagos:    z.boolean().optional(),
      mostrarMapa:      z.boolean().optional(),
      mostrarCotizador: z.boolean().optional(),
      mostrarServicios: z.boolean().optional(),
    })
    const data = schema.parse(req.body)
    const settings = await prisma.portalSettings.upsert({
      where:  { id: 1 },
      update: data,
      create: { id: 1, ...data },
    })
    auditReq('portal:settings_updated', req, data)
    res.json(settings)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/auth/register', portalLoginLimiter, async (req, res) => {
  try {
    const { nombre, email, password } = portalRegisterSchema.parse(req.body)
    const existing = await prisma.usuarioPortal.findFirst({ where: { email } })
    if (existing) return res.status(409).json({ error: 'Email ya registrado.' })
    const count    = await prisma.usuarioPortal.count()
    const noUsuario = `USR-${String(count + 1).padStart(4, '0')}`
    const hash = await bcrypt.hash(password, 12)
    const usuario = await prisma.usuarioPortal.create({
      data: { noUsuario, nombre, email, passwordHash: hash },
    })
    const token = signPortalToken(usuario)
    setPortalCookie(res, token)
    auditReq('portal:register', req, { usuarioId: usuario.id, email }, { userId: null, userName: nombre })
    res.status(201).json({ id: usuario.id, nombre: usuario.nombre, email: usuario.email, noUsuario: usuario.noUsuario })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[PORTAL REGISTER]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/auth/login', portalLoginLimiter, async (req, res) => {
  try {
    const { email, password } = portalLoginSchema.parse(req.body)
    let usuario = await prisma.usuarioPortal.findFirst({ where: { email } })

    // Auto-seed demo account
    if (!usuario && email === 'demo.empresa@acrtest.do') {
      const hash    = await bcrypt.hash('Demo2026!', 12)
      const count   = await prisma.usuarioPortal.count()
      usuario = await prisma.usuarioPortal.create({
        data: {
          noUsuario: `USR-${String(count + 1).padStart(4, '0')}`,
          nombre: 'Carlos Demo', email: 'demo.empresa@acrtest.do', passwordHash: hash,
          telefono: '809-555-1234',
        },
      })
      console.log('[PORTAL] Auto-seeded demo account:', usuario.id)
    }

    if (!usuario) return res.status(401).json({ error: 'Credenciales inválidas.' })
    if (!usuario.activo) return res.status(403).json({ error: 'Cuenta inactiva.' })
    const valid = await bcrypt.compare(password, usuario.passwordHash)
    if (!valid) {
      auditReq('portal:login_fail', req, { email }, { userId: null })
      return res.status(401).json({ error: 'Credenciales inválidas.' })
    }
    const token = signPortalToken(usuario)
    setPortalCookie(res, token)
    auditReq('portal:login', req, { usuarioId: usuario.id, email }, { userId: null, userName: usuario.nombre })
    res.json({ id: usuario.id, nombre: usuario.nombre, email: usuario.email, noUsuario: usuario.noUsuario, clienteId: usuario.clienteId })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/auth/logout', (req, res) => {
  res.clearCookie('pct')
  res.clearCookie('pct-csrf')
  res.status(204).end()
})

app.get('/api/portal/auth/me', verificarPortalJWT, async (req, res) => {
  try {
    const usuario = await prisma.usuarioPortal.findUnique({
      where:  { id: req.portalUser.sub },
      select: {
        id: true, noUsuario: true, nombre: true, email: true, telefono: true, activo: true, clienteId: true,
        cliente: { select: { id: true, noCliente: true, razonSocial: true, telefonoPrincipal: true, direccion: true, tipoCliente: true } },
      },
    })
    if (!usuario) { res.clearCookie('pct'); return res.status(401).json({ error: 'Usuario no encontrado.' }) }
    if (!usuario.activo) { res.clearCookie('pct'); return res.status(403).json({ error: 'Cuenta inactiva.' }) }
    res.json(usuario)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// In-memory reset token store (Redis-backed when available, falls back to Map)
const resetTokens = new Map()
setInterval(() => { const n = Date.now(); for (const [k,v] of resetTokens) if (v.exp < n) resetTokens.delete(k) }, 5 * 60_000)

async function storeResetToken(token, clienteId) {
  const exp = Date.now() + 15 * 60_000
  if (redisClient) {
    await redisClient.set(`pwd_reset:${token}`, clienteId, 'EX', 900)
  } else {
    resetTokens.set(token, { clienteId, exp })
  }
}

async function consumeResetToken(token) {
  if (redisClient) {
    const id = await redisClient.getdel(`pwd_reset:${token}`)
    return id || null
  }
  const entry = resetTokens.get(token)
  if (!entry || entry.exp < Date.now()) return null
  resetTokens.delete(token)
  return entry.clienteId
}

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  keyGenerator: reqFingerprint,
  store: makeRateLimitStore(),
  message: { error: 'Demasiadas solicitudes. Intente en 15 minutos.' },
})

app.post('/api/portal/auth/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email().trim().toLowerCase() }).parse(req.body)
    const usuario = await prisma.usuarioPortal.findFirst({ where: { email }, select: { id: true, nombre: true } })
    res.json({ ok: true })
    if (!usuario) return
    const token = crypto.randomBytes(32).toString('hex')
    await storeResetToken(token, usuario.id)
    const resetUrl = `${process.env.PORTAL_URL || process.env.CORS_ORIGIN || 'http://localhost:5173'}/portal?reset=${token}`
    console.log(`[PORTAL RESET] ${email} → ${resetUrl}`)
    if (process.env.SMTP_USER) {
      emailTransporter.sendMail({
        from:    `"ACR Networks" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: 'Restablecer contraseña — ACR',
        html: `<p>Hola <strong>${usuario.nombre}</strong>,</p>
               <p>Haz clic en el enlace para restablecer tu contraseña (válido 15 min):</p>
               <p><a href="${resetUrl}">${resetUrl}</a></p>`,
      }).catch(err => console.error('[PORTAL RESET EMAIL]', err.message))
    }
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Email inválido.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = z.object({
      token:    z.string().min(64).max(64),
      password: z.string().min(6).max(100),
    }).parse(req.body)
    const usuarioId = await consumeResetToken(token)
    if (!usuarioId) return res.status(400).json({ error: 'Token inválido o expirado.' })
    const hash = await bcrypt.hash(password, 12)
    await prisma.usuarioPortal.update({ where: { id: usuarioId }, data: { passwordHash: hash } })
    auditReq('portal:password_reset', req, { usuarioId }, { userId: null, userName: null })
    res.json({ ok: true })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

const SOS_QUOTA_PER_CLIENT = 3      // máx tickets B2B pendientes por cliente
const SOS_QUOTA_WINDOW_MS  = 24 * 3600_000  // en 24h

app.post('/api/portal/sos', verificarPortalJWT, async (req, res) => {
  try {
    const { descripcion } = z.object({ descripcion: z.string().max(500).optional() }).parse(req.body)
    const clienteId = req.portalUser.clienteId
    if (!clienteId) return res.status(422).json({ error: 'Tu cuenta no está vinculada a un cliente. Contacta a ACR para vincularla.' })
    const desde = new Date(Date.now() - SOS_QUOTA_WINDOW_MS)
    const recientes = await prisma.ordenTrabajo.count({
      where: { clienteId, tipoOT: 'SoporteTecnico', createdAt: { gte: desde }, estado: { in: ['Pendiente','EnProceso'] }, deletedAt: null },
    })
    if (recientes >= SOS_QUOTA_PER_CLIENT) {
      auditReq('portal:sos_quota', req, { clienteId, count: recientes }, { userId: null, userName: req.portalUser.nombre })
      return res.status(429).json({ error: `Límite alcanzado (${SOS_QUOTA_PER_CLIENT} tickets/24h). Contacta a ACR si es urgente.` })
    }
    const ot = await prisma.ordenTrabajo.create({
      data: {
        clienteId,
        tipoOT:        'SoporteTecnico',
        estado:        'Pendiente',
        notasTecnicas: descripcion || 'Solicitud de soporte técnico vía Portal B2C',
        metadatos:     { origen: 'portal_sos', usuarioId: req.portalUser.sub },
      },
    })
    auditReq('portal:sos_created', req, { otId: ot.id }, { userId: null, userName: req.portalUser.nombre })
    res.status(201).json({ id: ot.id, estado: ot.estado })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/cotizacion', verificarPortalJWT, async (req, res) => {
  try {
    const bodySchema = z.object({
      lineas: z.array(z.object({
        nombre:    z.string().min(1).max(200),
        precio:    z.number().positive(),
        cantidad:  z.number().int().min(1).max(999),
        categoria: z.string().optional(),
      })).min(1).max(50),
      descuentoPct: z.number().min(0).max(100).optional().default(0),
      notas:        z.string().max(500).optional(),
    })
    const { lineas, descuentoPct, notas } = bodySchema.parse(req.body)

    const subtotalBruto = lineas.reduce((s, l) => s + l.precio * l.cantidad, 0)
    const descAmt       = descuentoPct > 0 ? Math.round(subtotalBruto * (descuentoPct / 100) * 100) / 100 : 0
    const subtotal      = Math.round((subtotalBruto - descAmt) * 100) / 100
    const itbis         = Math.round(subtotal * 0.18 * 100) / 100
    const total         = Math.round((subtotal + itbis) * 100) / 100
    const noFactura     = `PCT${new Date().getFullYear()}-${String(Date.now()).slice(-8)}`

    const clienteId = req.portalUser.clienteId
    if (!clienteId) return res.status(422).json({ error: 'Tu cuenta no está vinculada a un cliente. Contacta a ACR.' })
    const factura = await prisma.factura.create({
      data: {
        noFactura, clienteId,
        estado: 'Borrador', subtotal, itbis, total,
        esCotizacion: true, tipoNcf: 'Consumidor Final',
        fechaVence: new Date(Date.now() + 30 * 86_400_000),
        notas: notas ?? `Cotización Portal — ${lineas.length} línea(s)${descuentoPct > 0 ? ` (${descuentoPct}% Pack Empresarial)` : ''}`,
        lineas: { createMany: { data: lineas.map(l => ({ descripcion: l.nombre, cantidad: l.cantidad, precioUnitario: l.precio })) } },
      },
      include: { lineas: true },
    })

    auditReq('portal:cotizacion', req, { facturaId: factura.id, total, lineas: lineas.length }, { userId: null, userName: req.portalUser.nombre })
    res.status(201).json({ id: factura.id, noFactura: factura.noFactura, total, lineas: factura.lineas.length })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[PORTAL COTIZACION]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.get('/api/portal/cotizaciones', verificarPortalJWT, async (req, res) => {
  try {
    const clienteId = req.portalUser.clienteId
    if (!clienteId) return res.json({ data: [] })
    const data = await prisma.factura.findMany({
      where:   { clienteId, esCotizacion: true, deletedAt: null },
      select:  { id: true, noFactura: true, total: true, estado: true, fechaEmision: true, fechaVence: true, notas: true },
      orderBy: { createdAt: 'desc' },
      take:    10,
    })
    res.json({ data })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/portal/dashboard', verificarPortalJWT, async (req, res) => {
  try {
    const clienteId = req.portalUser.clienteId
    if (!clienteId) return res.json({ servicios: [], facturas: [], ordenes: [], deudaTotal: 0, sinVincular: true })
    const [servicios, facturas, ordenes] = await Promise.all([
      prisma.servicio.findMany({
        where:   { clienteId },
        include: { plan: { select: { nombre: true, tipo: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.factura.findMany({
        where:   { clienteId, deletedAt: null, esCotizacion: false },
        select:  { id: true, noFactura: true, total: true, estado: true, fechaEmision: true, fechaVence: true },
        orderBy: { fechaEmision: 'desc' },
        take: 20,
      }),
      prisma.ordenTrabajo.findMany({
        where:   { clienteId, deletedAt: null },
        select:  { id: true, noOT: true, tipoOT: true, estado: true, createdAt: true, notasTecnicas: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ])
    const deudaTotal = facturas
      .filter(f => f.estado === 'Vencida')
      .reduce((s, f) => s + Number(f.total), 0)
    res.json({ servicios, facturas, ordenes, deudaTotal })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/portal/facturas/:id/pdf', verificarPortalJWT, async (req, res) => {
  try {
    const factura = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: {
        cliente: true,
        lineas:  true,
        orden:   { include: { lineas: { include: { itemCatalogo: { select: { nombre: true } } } } } },
      },
    })
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada.' })
    if (factura.clienteId !== req.portalUser.clienteId) return res.status(403).json({ error: 'Acceso denegado.' })
    const buf = await buildFacturaPDFBuffer(factura)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="factura-${factura.noFactura}.pdf"`)
    res.setHeader('Content-Length', buf.length)
    res.end(buf)
  } catch { if (!res.headersSent) res.status(500).json({ error: 'Error al generar PDF.' }) }
})

// ─── Usuarios Portal (NOC Admin) ──────────────────────────────────────────────

app.get('/api/usuarios-portal', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
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

app.post('/api/usuarios-portal/:id/vincular', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

// ─── Reportes ─────────────────────────────────────────────────────────────────

app.get('/api/reportes/semanal', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const ahora     = new Date();
    const inicioDia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    const inicioSemana = new Date(inicioDia);
    inicioSemana.setDate(inicioDia.getDate() - 6);

    const [facturas, ots, facturasMes] = await Promise.all([
      prisma.factura.findMany({
        where:   { esCotizacion: false, deletedAt: null, estado: 'Pagada', fechaEmision: { gte: inicioSemana } },
        select:  { total: true, fechaEmision: true, lineas: { select: { itemCatalogo: { select: { tipoItem: true, nombre: true } } } } },
      }),
      prisma.ordenTrabajo.findMany({
        where:   { deletedAt: null, estado: 'Cerrada', updatedAt: { gte: inicioSemana } },
        select:  { id: true, noOT: true, tipoOT: true, updatedAt: true, tecnico: { select: { id: true, nombre: true } } },
      }),
      prisma.factura.findMany({
        where:   { esCotizacion: false, deletedAt: null, estado: 'Pagada',
                   fechaEmision: { gte: new Date(ahora.getFullYear(), ahora.getMonth(), 1) } },
        select:  { total: true },
      }),
    ]);

    const ingresosPorCategoria = {};
    let totalSemana = 0;
    for (const f of facturas) {
      const monto = Number(f.total);
      totalSemana += monto;
      const tipos = [...new Set(f.lineas.map(l => l.itemCatalogo?.tipoItem).filter(Boolean))];
      const cat = tipos.length > 0 ? tipos[0] : 'Otro';
      ingresosPorCategoria[cat] = (ingresosPorCategoria[cat] ?? 0) + monto;
    }

    const ingresoPorDia = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(inicioSemana);
      d.setDate(d.getDate() + i);
      ingresoPorDia[d.toISOString().slice(0, 10)] = 0;
    }
    for (const f of facturas) {
      const key = new Date(f.fechaEmision).toISOString().slice(0, 10);
      if (key in ingresoPorDia) ingresoPorDia[key] += Number(f.total);
    }

    res.json({
      semana:     { inicio: inicioSemana, fin: ahora },
      totalSemana,
      totalMes:   facturasMes.reduce((s, f) => s + Number(f.total), 0),
      ingresosPorCategoria,
      ingresoPorDia,
      otsCerradas: ots.length,
      otsDetalle:  ots.map(o => ({ id: o.id, noOT: o.noOT, tipoOT: o.tipoOT, updatedAt: o.updatedAt, tecnicoNombre: o.tecnico?.nombre ?? null })),
    });
  } catch (e) {
    console.error('[REPORTE SEMANAL]', e.message, e.stack);
    // Never explode the frontend: return safe empty shape on backend errors
    res.json({
      semana:               { inicio: null, fin: null },
      totalSemana:          0,
      totalMes:             0,
      ingresosPorCategoria: {},
      ingresoPorDia:        {},
      otsCerradas:          0,
      otsDetalle:           [],
      _error:               'Datos incompletos. Reintenta en unos segundos.',
    });
  }
});

app.get('/api/reportes/comisiones', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const year  = parseInt(anio)  || new Date().getFullYear();
    const month = parseInt(mes)   || new Date().getMonth() + 1;
    const inicio = new Date(year, month - 1, 1);
    const fin    = new Date(year, month,     1);

    const ots = await prisma.ordenTrabajo.findMany({
      where:   {
        deletedAt: null,
        estado:    'Cerrada',
        tecnicoId: { not: null },
        tipoOT:    { in: ['Reparacion', 'Instalacion', 'CCTV'] },
        updatedAt: { gte: inicio, lt: fin },
      },
      select: {
        id: true, noOT: true, tipoOT: true, updatedAt: true,
        tecnico:  { select: { id: true, nombre: true } },
        facturas: { select: { total: true, estado: true }, take: 1 },
      },
    });

    const TASA = { Reparacion: 0.10, Instalacion: 0.08, CCTV: 0.10 };

    const porTecnico = {};
    for (const ot of ots) {
      const fact = (ot.facturas || [])[0];
      const total  = Number(fact?.total ?? 0);
      const tasa   = TASA[ot.tipoOT] ?? 0.08;
      const comision = total * tasa;
      const nombre = ot.tecnico?.nombre ?? 'Desconocido';
      if (!porTecnico[nombre]) porTecnico[nombre] = { nombre, ots: 0, totalFacturado: 0, comisionTotal: 0, detalle: [] };
      porTecnico[nombre].ots++;
      porTecnico[nombre].totalFacturado += total;
      porTecnico[nombre].comisionTotal  += comision;
      porTecnico[nombre].detalle.push({ noOT: ot.noOT, tipoOT: ot.tipoOT, total, tasa, comision, fecha: ot.updatedAt });
    }

    res.json({
      periodo:   { mes: month, anio: year },
      tecnicos:  Object.values(porTecnico).sort((a, b) => b.comisionTotal - a.comisionTotal),
      totalComisiones: Object.values(porTecnico).reduce((s, t) => s + t.comisionTotal, 0),
    });
  } catch (e) {
    console.error('[REPORTE COMISIONES]', e.message, e.stack);
    res.json({ periodo: { mes: null, anio: null }, tecnicos: [], totalComisiones: 0, _error: 'Datos incompletos.' });
  }
});

// ─── E-commerce: Checkout + Webhook (Azul gateway prep) ───────────────────────

const checkoutSchema = z.object({
  items: z.array(z.object({
    itemCatalogoId: z.string().uuid(),
    cantidad:       z.number().int().min(1).max(99),
  })).min(1).max(50),
  metodoPago: z.enum(['Tarjeta','Transferencia']).default('Tarjeta'),
})

const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })

app.post('/api/portal/checkout', checkoutLimiter, verificarPortalJWT, async (req, res) => {
  try {
    const { items } = checkoutSchema.parse(req.body)
    const clienteId = req.portalUser.clienteId
    if (!clienteId) return res.status(422).json({ error: 'Tu cuenta no está vinculada a un cliente.' })

    const ids = items.map(i => i.itemCatalogoId)
    const catalogo = await prisma.itemCatalogo.findMany({ where: { id: { in: ids }, activo: true } })
    if (catalogo.length !== ids.length) return res.status(400).json({ error: 'Uno o más items no existen o están inactivos.' })
    const catMap = Object.fromEntries(catalogo.map(c => [c.id, c]))

    let subtotal = 0
    const lineasData = items.map(i => {
      const c = catMap[i.itemCatalogoId]
      const precio = Number(c.precio)
      subtotal += precio * i.cantidad
      return { itemCatalogoId: c.id, descripcion: c.nombre, cantidad: i.cantidad, precioUnitario: precio }
    })
    const itbis = Math.round(subtotal * 0.18 * 100) / 100
    const total = Math.round((subtotal + itbis) * 100) / 100

    // Crea Factura(Borrador) como referencia de pago pendiente
    const factura = await prisma.factura.create({
      data: {
        noFactura: `PAGO-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        clienteId, estado: 'Borrador',
        subtotal, itbis, total,
        notas: `Checkout portal: pendiente pago via ${req.body.metodoPago ?? 'Tarjeta'}.`,
        esCotizacion: false,
        lineas: { createMany: { data: lineasData } },
      },
    })
    auditReq('ecommerce:checkout', req, { facturaId: factura.id, total, items: items.length }, { userId: null, userName: req.portalUser.nombre })
    res.status(201).json({ paymentRef: factura.id, total, gateway: 'azul', sandbox: !process.env.AZUL_WEBHOOK_SECRET })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[CHECKOUT]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// HMAC-SHA256 webhook verifier — gateway-agnostic
function verificarFirmaWebhook(secret, payloadRaw, firmaHex) {
  if (!secret || !firmaHex) return false
  const computado = crypto.createHmac('sha256', secret).update(payloadRaw).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(computado, 'hex'), Buffer.from(firmaHex, 'hex'))
  } catch { return false }
}

const azulWebhookSchema = z.object({
  paymentRef:     z.string().uuid(),
  estadoPago:     z.enum(['aprobado','rechazado','reversado']),
  transactionId:  z.string().min(1).max(120),
  monto:          z.coerce.number().positive(),
  fechaPago:      z.coerce.date().optional(),
})

app.post('/api/webhooks/azul', express.raw({ type: '*/*', limit: '50kb' }), async (req, res) => {
  const secret = process.env.AZUL_WEBHOOK_SECRET
  if (!secret) return res.status(503).json({ error: 'Pasarela no configurada. Define AZUL_WEBHOOK_SECRET.' })
  const firma = req.headers['x-azul-signature']
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body))
  if (!verificarFirmaWebhook(secret, rawBody, firma)) {
    auditReq('webhook:azul_signature_fail', req, { firma: firma?.slice(0, 12) }, { userId: null })
    return res.status(401).json({ error: 'Firma inválida.' })
  }
  let payload
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'))
    payload = azulWebhookSchema.parse(parsed)
  } catch (e) {
    return res.status(400).json({ error: 'Payload inválido.' })
  }
  try {
    const factura = await prisma.factura.findUnique({
      where: { id: payload.paymentRef },
      include: { lineas: { include: { itemCatalogo: true } }, cliente: true },
    })
    if (!factura) return res.status(404).json({ error: 'Pago no encontrado.' })
    if (factura.estado === 'Pagada') return res.status(409).json({ error: 'Pago ya procesado.' })
    if (Number(factura.total) !== payload.monto) {
      auditReq('webhook:amount_mismatch', req, { paymentRef: payload.paymentRef, expected: Number(factura.total), got: payload.monto })
      return res.status(422).json({ error: 'Monto no coincide.' })
    }
    if (payload.estadoPago !== 'aprobado') {
      await prisma.factura.update({ where: { id: factura.id }, data: { estado: 'Anulada', notas: `${factura.notas ?? ''} | Rechazado: ${payload.estadoPago}` } })
      return res.json({ ok: true, estado: 'rechazado' })
    }

    await prisma.$transaction(async (tx) => {
      await tx.factura.update({
        where: { id: factura.id },
        data:  { estado: 'Pagada', fechaPago: payload.fechaPago ?? new Date(),
                 notas: `${factura.notas ?? ''} | Azul tx: ${payload.transactionId}` },
      })
      const tieneInstalable = factura.lineas.some(l => ['CCTV','Redes','CercoElectrico'].includes(l.itemCatalogo?.categoria))
      const tieneRecurrente = factura.lineas.some(l => l.itemCatalogo?.tipo === 'Recurrente')

      if (tieneInstalable) {
        const noOT = await nextNomenclatura(tx, 'OT')
        await tx.ordenTrabajo.create({
          data: {
            clienteId: factura.clienteId, noOT,
            tipoOT:    'Instalacion', estado: 'Pendiente',
            metadatos: { origen: 'ecommerce', facturaId: factura.id, txAzul: payload.transactionId },
            fechaVencimientoSLA: new Date(Date.now() + 7 * 24 * 3600_000),
            lineas: { createMany: { data: factura.lineas.map(l => ({
              itemCatalogoId: l.itemCatalogoId, descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario,
            })) } },
          },
        })
      }

      if (tieneRecurrente) {
        const planItem = factura.lineas.find(l => l.itemCatalogo?.tipo === 'Recurrente')
        if (planItem) {
          // Se asume que existe (o se creará) un Plan vinculado al ItemCatalogo. Por ahora se deja documentado en metadatos.
          await tx.factura.update({ where: { id: factura.id }, data: { notas: `${factura.notas ?? ''} | Servicio recurrente: ${planItem.itemCatalogo.nombre}` } })
        }
      }
    })

    auditReq('webhook:azul_ok', req, { paymentRef: payload.paymentRef, transactionId: payload.transactionId, monto: payload.monto })
    res.json({ ok: true, estado: 'pagado' })
  } catch (e) {
    console.error('[WEBHOOK AZUL]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

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

app.get('/api/taller', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
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

app.post('/api/taller', verificarJWT, requerirPermiso('ot:crear'), async (req, res) => {
  try {
    const data = ticketTallerSchema.parse(req.body)
    let pin, noTicket, intento = 0
    while (intento < 5) {
      pin = generarPin()
      const colide = await prisma.ticketTaller.findUnique({ where: { codigoPin: pin } })
      if (!colide) break
      intento++
    }
    if (intento >= 5) return res.status(503).json({ error: 'No se pudo generar PIN único. Reintenta.' })
    const count = await prisma.ticketTaller.count()
    noTicket = `TLR-${String(count + 1).padStart(5, '0')}`
    const ticket = await prisma.ticketTaller.create({
      data: { ...data, noTicket, codigoPin: pin },
      include: { cliente: { select: { razonSocial: true } } },
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

app.patch('/api/taller/:id/estado', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

app.patch('/api/taller/:id', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

app.patch('/api/taller/:id/reabrir', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
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
// ─── Anti brute-force: in-memory tally + DB-persisted IpBlock ────────────────

const TRACK_FAIL_WINDOW_MS  = 5  * 60 * 1000      // 5 min sliding window
const TRACK_FAIL_THRESHOLD  = 5                   // 5 failures triggers block
const TRACK_BLOCK_DURATION  = 30 * 60 * 1000      // 30 min block

const failTally    = new Map()  // ip -> { count, firstFail }
const activeBlocks = new Map()  // ip -> expiresAt(ms)

async function hydrateIpBlocks() {
  try {
    const blocks = await prisma.ipBlock.findMany({ where: { expiraEn: { gt: new Date() } } })
    for (const b of blocks) activeBlocks.set(b.ip, b.expiraEn.getTime())
    console.log(`[IpBlock] hydrated ${blocks.length} active block(s)`)
  } catch (e) { console.error('[IpBlock hydrate]', e.message) }
}
hydrateIpBlocks()

function getClientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
       || req.socket?.remoteAddress
       || 'unknown').replace(/^::ffff:/, '')
}

function isIpBlocked(ip) {
  const exp = activeBlocks.get(ip)
  if (!exp) return false
  if (exp < Date.now()) { activeBlocks.delete(ip); return false }
  return true
}

async function registerTrackFailure(ip, motivo) {
  const now = Date.now()
  const entry = failTally.get(ip)
  if (!entry || (now - entry.firstFail) > TRACK_FAIL_WINDOW_MS) {
    failTally.set(ip, { count: 1, firstFail: now })
    return false
  }
  entry.count++
  if (entry.count >= TRACK_FAIL_THRESHOLD) {
    failTally.delete(ip)
    const expiraEn = new Date(now + TRACK_BLOCK_DURATION)
    activeBlocks.set(ip, expiraEn.getTime())
    try {
      await prisma.ipBlock.create({ data: { ip, motivo, intentos: TRACK_FAIL_THRESHOLD, expiraEn } })
      auditReq('security:ip_block', { headers: {}, socket: { remoteAddress: ip }, originalUrl: '/track' }, { ip, motivo, hasta: expiraEn })
    } catch (e) { console.error('[IpBlock persist]', e.message) }
    return true
  }
  return false
}

const trackingLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
app.get('/api/track/:pin', trackingLimiter, async (req, res) => {
  const ip = getClientIp(req)
  if (isIpBlocked(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. IP bloqueada temporalmente.' })
  }
  const pinRaw = (req.params.pin || '').toUpperCase()
  if (!/^[A-Z2-9]{6}$/.test(pinRaw)) {
    await registerTrackFailure(ip, 'PIN formato inválido')
    return res.status(400).json({ error: 'PIN inválido.' })
  }
  try {
    const t = await prisma.ticketTaller.findUnique({
      where:  { codigoPin: pinRaw },
      select: {
        noTicket: true, equipo: true, marca: true, modelo: true, estado: true,
        recibidoEn: true, diagnosticadoEn: true, listoEn: true, entregadoEn: true,
        diagnostico: true, costoEstimado: true,
        cliente: { select: { razonSocial: true } },
      },
    })
    if (!t) {
      await registerTrackFailure(ip, 'PIN no encontrado')
      return res.status(404).json({ error: 'Ticket no encontrado.' })
    }
    res.json(t)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

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

app.get('/api/credenciales', verificarJWT, requerirPermiso('vault:ver'), async (req, res) => {
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

app.post('/api/credenciales', verificarJWT, requerirPermiso('vault:editar'), async (req, res) => {
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

app.get(
  '/api/credenciales/:id/reveal',
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

app.delete('/api/credenciales/:id', verificarJWT, requerirPermiso('vault:editar'), async (req, res) => {
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

app.get('/api/activos-cliente', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
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

app.post('/api/activos-cliente', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

app.delete('/api/activos-cliente/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    await prisma.activoCliente.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Activo no encontrado.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── MSP: Préstamos de Equipos ────────────────────────────────────────────────

const prestamoSchema = z.object({
  clienteId:  z.string().uuid(),
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().min(1).default(1),
  diasLimite: z.number().int().min(1).max(180).default(15),
  notas:      z.string().max(500).optional().nullable(),
})

app.get('/api/prestamos', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
  try {
    const { activos } = req.query
    const where = {}
    if (activos === 'true') where.fechaDevolucion = null
    const data = await prisma.equipoPrestamo.findMany({
      where,
      include: {
        cliente:  { select: { id: true, noCliente: true, razonSocial: true } },
        producto: { select: { id: true, sku: true, nombre: true } },
      },
      orderBy: { fechaPrestamo: 'desc' },
    })
    const ahora = Date.now()
    const enriched = data.map(p => ({ ...p, vencido: !p.fechaDevolucion && new Date(p.fechaLimite).getTime() < ahora }))
    res.json({ data: enriched })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.post('/api/prestamos', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  try {
    const data = prestamoSchema.parse(req.body)
    const fechaLimite = new Date(Date.now() + data.diasLimite * 86_400_000)
    const prestamo = await prisma.$transaction(async (tx) => {
      const mov = await tx.movimientoInventario.create({
        data: { productoId: data.productoId, tipo: 'Salida', cantidad: data.cantidad },
      })
      await tx.producto.update({ where: { id: data.productoId }, data: { stockActual: { decrement: data.cantidad } } })
      return tx.equipoPrestamo.create({
        data: {
          clienteId: data.clienteId, productoId: data.productoId, cantidad: data.cantidad,
          fechaLimite, notas: data.notas ?? null, movimientoSalidaId: mov.id,
        },
      })
    })
    auditReq('prestamo:crear', req, { prestamoId: prestamo.id, clienteId: data.clienteId, productoId: data.productoId })
    res.status(201).json(prestamo)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    if (e.code === 'P2003')      return res.status(400).json({ error: 'Cliente o producto inválido.' })
    console.error('[PRESTAMO CREATE]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.patch('/api/prestamos/:id/devolver', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const prestamo = await prisma.equipoPrestamo.findUnique({ where: { id: req.params.id } })
    if (!prestamo) return res.status(404).json({ error: 'Préstamo no encontrado.' })
    if (prestamo.fechaDevolucion) return res.status(409).json({ error: 'Préstamo ya devuelto.' })
    const result = await prisma.$transaction(async (tx) => {
      const mov = await tx.movimientoInventario.create({
        data: { productoId: prestamo.productoId, tipo: 'Entrada', cantidad: prestamo.cantidad },
      })
      await tx.producto.update({ where: { id: prestamo.productoId }, data: { stockActual: { increment: prestamo.cantidad } } })
      return tx.equipoPrestamo.update({
        where: { id: req.params.id },
        data:  { fechaDevolucion: new Date(), movimientoEntradaId: mov.id },
      })
    })
    auditReq('prestamo:devolver', req, { prestamoId: req.params.id })
    res.json(result)
  } catch (e) {
    console.error('[PRESTAMO DEVOLVER]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── MSP: OT close + auto-create ActivoCliente ────────────────────────────────

app.patch('/api/ordenes/:id/estado', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  const estadoSchema = z.object({
    estado:            z.enum(['Pendiente','EnProceso','Cerrada','Cancelada']),
    fotosRequeridas:   z.number().int().min(0).optional(),
    limpiezaRealizada: z.boolean().optional(),
    garantiaDias:      z.number().int().min(0).optional(),
  })
  try {
    const data = estadoSchema.parse(req.body)
    const ot = await prisma.ordenTrabajo.findUnique({
      where:   { id: req.params.id },
      include: { lineas: { select: { productoId: true, cantidad: true } } },
    })
    if (!ot) return res.status(404).json({ error: 'OT no encontrada.' })
    if (ot.estado === 'Cerrada' && ot.estaFacturada) {
      return res.status(423).json({ error: 'OT cerrada y facturada. Datos inmutables.' })
    }

    // Anti-fraude: cerrar OT requiere fotos suficientes
    if (data.estado === 'Cerrada' && (ot.fotosRequeridas ?? 0) > 0) {
      const fotosCount = await prisma.ordenFoto.count({ where: { ordenId: ot.id } })
      if (fotosCount < ot.fotosRequeridas) {
        return res.status(422).json({ error: `Faltan fotos: requieres ${ot.fotosRequeridas}, hay ${fotosCount}.` })
      }
    }

    const update = { estado: data.estado }
    if (data.fotosRequeridas   != null) update.fotosRequeridas   = data.fotosRequeridas
    if (data.limpiezaRealizada != null) update.limpiezaRealizada = data.limpiezaRealizada
    if (data.garantiaDias      != null) update.garantiaDias      = data.garantiaDias
    if (data.estado === 'Cerrada') update.completadaEn = new Date()

    await prisma.$transaction(async (tx) => {
      await tx.ordenTrabajo.update({ where: { id: req.params.id }, data: update })

      // Auto-create ActivoCliente entries for product lines on close
      if (data.estado === 'Cerrada' && ['Instalacion','CCTV','Reparacion'].includes(ot.tipoOT)) {
        const garantia = data.garantiaDias ?? ot.garantiaDias ?? 0
        const fechaInst = new Date()
        const finGar = garantia > 0 ? new Date(fechaInst.getTime() + garantia * 86_400_000) : null
        const productoLines = ot.lineas.filter(l => l.productoId)
        for (const l of productoLines) {
          await tx.activoCliente.create({
            data: {
              clienteId:        ot.clienteId,
              productoId:       l.productoId,
              ordenTrabajoId:   ot.id,
              cantidad:         l.cantidad,
              fechaInstalacion: fechaInst,
              finGarantia:      finGar,
            },
          })
        }
      }
    })

    auditReq('ot:estado', req, { otId: ot.id, estado: data.estado })
    res.json({ ok: true })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[OT ESTADO]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── OrdenFoto (foto-evidencia anti-fraude) ───────────────────────────────────

const ordenFotoSchema = z.object({
  url:         z.string().url().max(1000),
  latitud:     z.string().max(30).optional().nullable(),
  longitud:    z.string().max(30).optional().nullable(),
  descripcion: z.string().max(200).optional().nullable(),
})

app.get('/api/ordenes/:id/fotos', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const fotos = await prisma.ordenFoto.findMany({
      where:   { ordenId: req.params.id },
      include: { empleado: { select: { id: true, nombre: true } } },
      orderBy: { takenAt: 'desc' },
    })
    res.json({ data: fotos })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.post('/api/ordenes/:id/fotos', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const data = ordenFotoSchema.parse(req.body)
    const ot = await prisma.ordenTrabajo.findUnique({ where: { id: req.params.id }, select: { id: true, estado: true, estaFacturada: true } })
    if (!ot) return res.status(404).json({ error: 'OT no encontrada.' })
    if (ot.estado === 'Cerrada' && ot.estaFacturada) return res.status(423).json({ error: 'OT inmutable.' })
    const foto = await prisma.ordenFoto.create({
      data: {
        ordenId:     ot.id,
        url:         data.url,
        latitud:     data.latitud  ?? null,
        longitud:    data.longitud ?? null,
        descripcion: data.descripcion ?? null,
        subidoPor:   req.user.sub,
      },
    })
    auditReq('ot:foto_upload', req, { ordenId: ot.id, fotoId: foto.id, geo: !!data.latitud })
    res.status(201).json(foto)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[FOTO POST]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.delete('/api/ordenes/:ordenId/fotos/:fotoId', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  if (!validUUID(req.params.ordenId) || !validUUID(req.params.fotoId)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const foto = await prisma.ordenFoto.findUnique({ where: { id: req.params.fotoId }, include: { orden: { select: { estado: true, estaFacturada: true } } } })
    if (!foto) return res.status(404).json({ error: 'Foto no encontrada.' })
    if (foto.orden.estado === 'Cerrada' && foto.orden.estaFacturada) return res.status(423).json({ error: 'OT inmutable.' })
    await prisma.ordenFoto.delete({ where: { id: req.params.fotoId } })
    auditReq('ot:foto_delete', req, { ordenId: req.params.ordenId, fotoId: req.params.fotoId })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Offboarding de empleados ─────────────────────────────────────────────────

app.post('/api/empleados/:id/offboard', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  const empleadoId = parseInt(req.params.id)
  if (!empleadoId) return res.status(400).json({ error: 'ID inválido.' })
  if (empleadoId === req.user.sub) return res.status(409).json({ error: 'No puedes desactivarte a ti mismo.' })
  try {
    const result = await prisma.$transaction(async (tx) => {
      const emp = await tx.empleado.findUnique({ where: { id: empleadoId }, select: { id: true, nombre: true, bloqueado: true } })
      if (!emp) throw Object.assign(new Error('Empleado no encontrado.'), { status: 404 })

      // 1. Bloquear y soft-delete
      await tx.empleado.update({
        where: { id: empleadoId },
        data:  { bloqueado: true, deletedAt: new Date() },
      })

      // 2. Revocar TODAS las sesiones activas
      const sessionsDeleted = await tx.sessionToken.deleteMany({ where: { empleadoId } })

      // 3. Limpiar carrito temporal
      await tx.carritoTemp.deleteMany({ where: { empleadoId } })

      // 4. Liberar OTs pendientes/en proceso (unassign + flag huérfana)
      const otsActivas = await tx.ordenTrabajo.findMany({
        where:  { tecnicoId: empleadoId, estado: { in: ['Pendiente', 'EnProceso'] }, deletedAt: null },
        select: { id: true, noOT: true, metadatos: true },
      })
      for (const ot of otsActivas) {
        await tx.ordenTrabajo.update({
          where: { id: ot.id },
          data:  {
            tecnicoId: null,
            metadatos: { ...(ot.metadatos ?? {}), huerfana: true, motivo: 'offboarding', ofrecidaPor: empleadoId, marcadaEn: new Date().toISOString() },
          },
        })
      }

      // 5. Liberar tickets de taller pendientes
      const ticketsActivos = await tx.ticketTaller.updateMany({
        where: { tecnicoId: empleadoId, estado: { in: ['Recibido', 'Diagnostico', 'EsperandoPieza'] } },
        data:  { tecnicoId: null },
      })

      return {
        empleado: emp,
        sessionsRevocadas: sessionsDeleted.count,
        otsLiberadas:      otsActivas.length,
        otsHuerfanas:      otsActivas.map(o => o.noOT),
        ticketsLiberados:  ticketsActivos.count,
      }
    })

    auditReq('rrhh:offboard', req, result)
    res.json(result)
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message })
    console.error('[OFFBOARD]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Catálogo público (sin precio para anti-scraping) ─────────────────────────

const catalogoPublicoLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
app.get('/api/catalogo-publico', catalogoPublicoLimiter, async (req, res) => {
  try {
    const items = await prisma.itemCatalogo.findMany({
      where: { activo: true, tipoItem: 'SERVICIO', categoria: { not: 'WISP' } },
      select: { id: true, nombre: true, descripcion: true, categoria: true, tipo: true },
      orderBy: { categoria: 'asc' },
    })
    res.json({ data: items })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Catálogo del portal (con precio, requiere login) ─────────────────────────

app.get('/api/portal/catalogo', verificarPortalJWT, async (req, res) => {
  try {
    const items = await prisma.itemCatalogo.findMany({
      where: { activo: true, tipoItem: 'SERVICIO', categoria: { not: 'WISP' } },
      select: { id: true, nombre: true, descripcion: true, categoria: true, tipo: true, precio: true },
      orderBy: { categoria: 'asc' },
    })
    res.json({ data: items.map(i => ({ ...i, precio: Number(i.precio) })) })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Reconciliación: lectura de incidencias ──────────────────────────────────

app.get('/api/incidencias', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const { tipo, severidad, resueltas } = req.query
    const where = {}
    if (tipo)      where.tipo      = tipo
    if (severidad) where.severidad = severidad
    if (resueltas === 'true')  where.resueltoEn = { not: null }
    if (resueltas === 'false') where.resueltoEn = null
    const data = await prisma.incidenciaReconciliacion.findMany({
      where,
      orderBy: [{ resueltoEn: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: { empleado: { select: { id: true, nombre: true } } },
    })
    res.json({ data })
  } catch { res.json({ data: [], _error: 'Error obteniendo incidencias' }) }
})

app.patch('/api/incidencias/:id/resolver', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  const id = parseInt(req.params.id)
  if (!id) return res.status(400).json({ error: 'ID inválido.' })
  const { resolucion } = z.object({ resolucion: z.string().min(3).max(500) }).parse(req.body)
  try {
    const inc = await prisma.incidenciaReconciliacion.update({
      where: { id },
      data:  { resueltoEn: new Date(), resolucion, asignadoA: req.user.sub },
    })
    auditReq('reconciliacion:resolver', req, { incidenciaId: id })
    res.json(inc)
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Incidencia no encontrada.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── API Dictionary: endpoint meta / introspección ────────────────────────────

// Mapping path -> módulo de negocio (NO refactor de URLs, solo agrupación lógica)
const MODULE_MAP = [
  { test: /^\/api\/_meta/,                                    modulo: 'Sistema',         emoji: '⚙️' },
  { test: /^\/api\/health/,                                   modulo: 'Sistema',         emoji: '⚙️' },
  { test: /^\/api\/auth\//,                                   modulo: 'Autenticación',   emoji: '🔐' },
  { test: /^\/api\/incidencias/,                              modulo: 'Seguridad',       emoji: '🛡️' },
  { test: /^\/api\/credenciales/,                             modulo: 'Seguridad (Vault)', emoji: '🔑' },
  { test: /^\/api\/empleados/,                                modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/asistencia/,                               modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/roles/,                                    modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/clientes/,                                 modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/suplidores/,                               modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/prospectos/,                               modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/usuarios-portal/,                          modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/(productos|categorias|inventario|kardex)/, modulo: 'Inventario',      emoji: '📦' },
  { test: /^\/api\/prestamos/,                                modulo: 'Inventario',      emoji: '📦' },
  { test: /^\/api\/(items-catalogo|catalogo)/,                modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/(facturas|cotizaciones|cotizacion|ncf)/,   modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/ordenes/,                                  modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/(servicios|planes|plantillas)/,            modulo: 'Servicios',       emoji: '🛠️' },
  { test: /^\/api\/taller/,                                   modulo: 'Taller (RMA)',    emoji: '🔧' },
  { test: /^\/api\/track/,                                    modulo: 'Tracking Público',emoji: '📍' },
  { test: /^\/api\/activos-cliente/,                          modulo: 'CMDB',            emoji: '🗂️' },
  { test: /^\/api\/reportes/,                                 modulo: 'Reportes',        emoji: '📊' },
  { test: /^\/api\/dashboard/,                                modulo: 'Dashboard',       emoji: '📈' },
  { test: /^\/api\/mapa-noc/,                                 modulo: 'NOC / Mapa',      emoji: '🗺️' },
  { test: /^\/api\/portal\/(auth|sos|dashboard|cotizacion|catalogo|checkout|settings|facturas)/, modulo: 'Portal B2C', emoji: '🌐' },
  { test: /^\/api\/webhooks/,                                 modulo: 'Webhooks',        emoji: '🪝' },
  { test: /^\/api\/carrito/,                                  modulo: 'Ventas',          emoji: '💼' },
]
function resolveModule(path) {
  for (const m of MODULE_MAP) if (m.test.test(path)) return { modulo: m.modulo, emoji: m.emoji }
  return { modulo: 'Otros', emoji: '❓' }
}

// Express 5.x: usa app.router (NO app._router). Robusto contra middlewares anidados.
function _scanRoutes(app) {
  const out = []
  const router = app.router ?? app._router // Express 5 vs 4 compat
  if (!router || !Array.isArray(router.stack)) return out

  function walk(stack, basePath = '') {
    for (const layer of stack) {
      try {
        if (layer.route) {
          // Express 5: route.path puede ser string, array de strings, o RegExp
          let pathStr = layer.route.path
          if (Array.isArray(pathStr)) pathStr = pathStr[0]
          if (pathStr instanceof RegExp) pathStr = pathStr.toString()
          if (typeof pathStr !== 'string') pathStr = String(pathStr ?? '')
          const path = basePath + pathStr
          const methodsObj = layer.route.methods || {}
          const methods = Object.keys(methodsObj).filter(m => methodsObj[m])
          for (const m of methods) {
            const handlerNames = (layer.route.stack || []).map(s => s?.name).filter(Boolean)
            const auth =
              handlerNames.includes('verificarJWT')          ? 'JWT'        :
              handlerNames.includes('verificarPortalJWT')    ? 'PortalJWT'  :
              handlerNames.some(h => /Limiter$/.test(h))     ? 'rate-limit' :
              'public'
            const permiso =
              handlerNames.find(h => h.startsWith('requerirPermiso')) ? 'role-restricted' : null
            const { modulo, emoji } = resolveModule(path)
            out.push({ method: m.toUpperCase(), path, modulo, emoji, auth, permiso })
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          walk(layer.handle.stack, basePath)
        }
      } catch (e) {
        console.error('[SCAN ROUTES] skip layer:', e.message)
      }
    }
  }
  walk(router.stack)
  return out
}

let _routesCache = null
app.get('/api/_meta/endpoints', verificarJWT, requerirPermiso('sistema:owner'), (req, res) => {
  try {
    if (!_routesCache || req.query.refresh === '1') {
      _routesCache = _scanRoutes(app)
        .filter(r => r.path.startsWith('/api/'))
        .sort((a, b) => a.modulo.localeCompare(b.modulo) || a.path.localeCompare(b.path))
    }
    const grouped = _routesCache.reduce((acc, r) => {
      const key = `${r.emoji} ${r.modulo}`
      ;(acc[key] = acc[key] || []).push(r)
      return acc
    }, {})
    res.json({
      total:     _routesCache.length,
      endpoints: _routesCache,
      grouped,
      modulos:   Object.keys(grouped).sort(),
      generadoEn: new Date(),
    })
  } catch (e) {
    console.error('[META ENDPOINTS]', e.message, e.stack)
    res.json({ total: 0, endpoints: [], grouped: {}, modulos: [], _error: 'Error escaneando rutas: ' + e.message })
  }
})

// ─── ActivoTimeline (historial vida de cada equipo) ──────────────────────────

app.get('/api/activos-cliente/:id/timeline', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
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

app.post('/api/activos-cliente/:id/timeline', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

// ─── UsuarioPortal: Owner reset password (no revelar — bcrypt one-way) ───────

app.post('/api/usuarios-portal/:id/reset-password', verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const nuevoPassword = crypto.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + 'A1!'
    const hash = await bcrypt.hash(nuevoPassword, 12)
    const u = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { passwordHash: hash },
      select: { id: true, noUsuario: true, nombre: true, email: true },
    })
    auditReq('portal:password_reset_owner', req, { usuarioId: u.id, email: u.email })
    // Response devuelve el password temporal UNA VEZ (no se persiste en claro)
    res.json({ usuario: u, passwordTemporal: nuevoPassword, mensaje: 'Comparte este password con el cliente por canal seguro. Se mostrará una sola vez.' })
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' })
    console.error('[PORTAL RESET OWNER]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/usuarios-portal/:id/bloquear', verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const u = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { activo: false },
      select: { id: true, activo: true },
    })
    auditReq('portal:bloquear_owner', req, { usuarioId: u.id })
    res.json(u)
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Supabase Storage + Validación URL whitelist (anti tracking-pixel) ──────

const SUPABASE_URL    = process.env.SUPABASE_URL || ''
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'empresa-assets'
const supabase        = (SUPABASE_URL && SUPABASE_KEY)
  ? createSupabaseClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null

/**
 * Whitelist estricta: URLs en assets DEBEN pertenecer al Supabase configurado
 * o a paths locales (/logo-acr.png para defaults). Bloquea inyección de
 * tracking-pixels externos via URLs como https://attacker.com/x.png.
 */
function esAssetUrlSegura(url) {
  if (!url || typeof url !== 'string') return true               // null/'' permitido
  if (url.startsWith('/'))             return true               // path relativo del propio frontend
  if (url.startsWith('data:image/'))   return true               // data URI inline (preview)
  if (!SUPABASE_URL)                   return false              // sin Supabase config = todo URL externo rechazado
  // Acepta URLs que empiecen con SUPABASE_URL/storage/v1/object/...
  const allowed = SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/object/'
  return url.startsWith(allowed)
}

// Mime detection real (no confiar en header del cliente)
function detectMimeFromBuffer(buf) {
  if (!buf || buf.length < 4) return null
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  // SVG: '<svg' o '<?xml' al inicio (con o sin BOM)
  const head = buf.slice(0, 100).toString('utf8').trim()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml'
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

// SVG sanitize: rechaza si contiene scripts o event handlers
function svgSeguro(buf) {
  const txt = buf.toString('utf8').toLowerCase()
  const peligrosos = ['<script', '<foreignobject', 'onload=', 'onerror=', 'onclick=', 'onmouseover=', 'javascript:', 'data:text/html']
  return !peligrosos.some(p => txt.includes(p))
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/webp': 'webp' }
const KINDS_VALIDOS = ['logoClaro', 'logoOscuro', 'selloFisico', 'firmaGerente']

// Extrae la ruta de Supabase Storage desde una URL pública.
// Ej: https://xxx.supabase.co/storage/v1/object/public/empresa-assets/acr/logo-123.webp → 'acr/logo-123.webp'
function pathFromSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return null
  const marker = `/object/public/${SUPABASE_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) {
    // También aceptar formato firmado /object/sign/<bucket>/...
    const signMarker = `/object/sign/${SUPABASE_BUCKET}/`
    const signIdx = url.indexOf(signMarker)
    if (signIdx === -1) return null
    return url.slice(signIdx + signMarker.length).split('?')[0]
  }
  return url.slice(idx + marker.length).split('?')[0]
}

// Comprime con sharp: resize 800x800 fit:inside (preserva aspect ratio), convierte a PNG.
// PNG es lossless + universalmente compatible con pdfkit, Chromium print-to-PDF y editores.
// WebP fue descartado: rompe pdfkit y editores legacy.
// SVG pasa intacto (vector, no necesita compresión raster).
async function comprimirImagen(buf, mime) {
  if (mime === 'image/svg+xml') {
    return { buffer: buf, mime: 'image/svg+xml', ext: 'svg' }
  }
  const out = await sharp(buf, { failOn: 'error' })
    .rotate()                                // respeta EXIF orientation
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 8, quality: 100, adaptiveFiltering: true, palette: false })
    .toBuffer()
  return { buffer: out, mime: 'image/png', ext: 'png' }
}

const uploadMulter = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024 },     // 2MB
})

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })

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
      // 1. Validación MIME real (header del archivo, no del cliente)
      const inputMime = detectMimeFromBuffer(req.file.buffer)
      if (!inputMime) return res.status(415).json({ error: 'Tipo de archivo no reconocido o corrupto.', code: 'INVALID_MIME' })
      if (!MIME_EXT[inputMime]) return res.status(415).json({ error: `Mime ${inputMime} no permitido.` })

      // 2. SVG: sanitizar contra XSS
      if (inputMime === 'image/svg+xml' && !svgSeguro(req.file.buffer)) {
        auditReq('empresa:upload_svg_malicioso', req, { kind, size: req.file.size })
        return res.status(422).json({ error: 'SVG contiene contenido peligroso (script, eventos, foreignObject).', code: 'SVG_UNSAFE' })
      }

      // 3. Comprimir con sharp (resize 800x800 + WebP). SVG pasa intacto.
      let buffer, finalMime, ext
      try {
        const compressed = await comprimirImagen(req.file.buffer, inputMime)
        buffer    = compressed.buffer
        finalMime = compressed.mime
        ext       = compressed.ext
      } catch (e) {
        console.error('[SHARP COMPRESS]', e.message)
        return res.status(422).json({ error: 'Imagen corrupta o formato no procesable.', code: 'COMPRESS_FAIL' })
      }

      const filename = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
      const path     = `acr/${filename}`

      // Upload a Supabase Storage. NO se escribe en BD aquí — la URL se
      // persiste sólo cuando el usuario envíe el form completo vía
      // PATCH /api/configuracion/empresa (orphan cleanup vive en esa ruta).
      const { error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buffer, {
        contentType: finalMime,
        cacheControl: '3600',
        upsert: false,
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
        ahorroPct: Number(ahorroPct.toFixed(1)),
        url: publicUrl,
      })

      res.status(201).json({
        kind, url: publicUrl, mime: finalMime,
        size: buffer.length,
        sizeOriginal: req.file.size,
        ahorroPct: Number(ahorroPct.toFixed(1)),
      })
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' })
      console.error('[EMPRESA UPLOAD]', e.message)
      res.status(500).json({ error: 'Error interno al procesar el archivo.' })
    }
  }
)

// ─── Upload de imágenes de inventario (productos, categorías, items) ─────────
// Reutiliza la misma pipeline de comprimirImagen + supabase storage. Bucket
// SUPABASE_INVENTORY_BUCKET (default: inventario-img) — separado de empresa-assets
// para tener cleanup independiente y políticas distintas.
const INVENTORY_BUCKET = process.env.SUPABASE_INVENTORY_BUCKET ?? 'inventario-img'
const KINDS_INVENTARIO = ['producto', 'categoria', 'itemCatalogo']

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

// ─── Generación de PDF server-side (Cotización + Factura) ────────────────────

// ─── Anti-tamper hash (HMAC) ──────────────────────────────────────────────────
// Hash determinístico sobre campos vitales del documento. Validación pública
// via /api/publico/verify/:hash — quien recibe el PDF puede confirmar que el
// monto/cliente/NCF coincide con lo emitido (defensa anti-Photoshop).
const VERIFY_SECRET = process.env.VERIFY_SECRET ?? process.env.JWT_SECRET ?? 'change-me-verify-secret'

function facturaVerifyHash(f) {
  const payload = [f.id, f.noFactura, f.ncf ?? '', String(f.total), f.fechaEmision?.toISOString?.() ?? f.fechaEmision ?? ''].join('|')
  return crypto.createHmac('sha256', VERIFY_SECRET).update(payload).digest('hex').slice(0, 24)
}

// PUBLIC_URL para verificación (frontend host). Si no se configura, omite el link en el PDF.
const PUBLIC_VERIFY_BASE = (process.env.PUBLIC_FRONTEND_URL ?? '').replace(/\/+$/, '')

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
    if (f?.pdfUrl) {
      await prisma.factura.update({ where: { id: facturaId }, data: { pdfUrl: null } })
      if (supabase) {
        const fecha = new Date(f.fechaEmision ?? Date.now())
        const path = `${fecha.getFullYear()}/${String(fecha.getMonth() + 1).padStart(2, '0')}/${facturaId}.pdf`
        await supabase.storage.from(PDF_CACHE_BUCKET).remove([path]).catch(() => {})
      }
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
  const own  = factura?.condiciones ?? {}
  const pick = (k) => {
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
    const d = defs?.[k]
    if (typeof d === 'string' && d.trim()) return d.trim()
    return null
  }
  return {
    validez:  pick('validez'),
    pago:     pick('pago'),
    entrega:  pick('entrega'),
    garantia: pick('garantia'),
  }
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
  return {
    empresa: empresaConAssets,
    cliente: {
      razonSocial: c.razonSocial,
      noCliente:   c.noCliente,
      rnc:         c.rnc,
      cedula:      c.cedula,
      direccion:   c.direccion,
      sector:      c.sector,
      provincia:   c.provincia,
      telefono:    c.telefono ?? c.telefonoPrincipal,
      email:       c.email,
    },
    // LineaFactura SOLO tiene relación con producto (no con itemCatalogo).
    // El nombre del item siempre vive en l.descripcion (string nativo).
    items: (f.lineas ?? []).map(l => ({
      descripcion:    l.descripcion,
      detalle:        l.producto?.nombre && l.producto.nombre !== l.descripcion ? l.producto.nombre : null,
      sku:            l.producto?.sku ?? null,
      cantidad:       l.cantidad,
      precioUnitario: Number(l.precioUnitario),
    })),
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
    verify: PUBLIC_VERIFY_BASE ? {
      hash: facturaVerifyHash(f),
      url:  `${PUBLIC_VERIFY_BASE}/verify/${facturaVerifyHash(f)}`,
    } : null,
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
      return res.redirect(302, cached.pdfUrl)
    }

    const fact = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: {
        cliente: true,
        lineas:  { include: { producto: { select: { sku: true, nombre: true } } } },
      },
    })
    if (!fact) return res.status(404).json({ error: 'Factura no encontrada.' })

    const data = await buildPdfData(fact)
    const html = renderPdfDoc({ tipo: 'factura', numero: fact.noFactura, ...data })
    const pdfBuf = await generarPdfDocumento(html)

    setImmediate(async () => {
      const url = await subirPdfAlStorage(pdfBuf, fact)
      if (url) await prisma.factura.update({ where: { id: fact.id }, data: { pdfUrl: url } }).catch(() => {})
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="factura-${fact.noFactura}.pdf"`)
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
      cliente: true,
      lineas:  { include: { producto: { select: { sku: true, nombre: true } } } },
    },
  })
  if (!f || f.deletedAt) return null
  if (tipo === 'cotizacion' && !f.esCotizacion) return null
  if (tipo === 'factura'    && f.esCotizacion)  return null
  const data = await buildPdfData(f)
  const html = renderPdfDoc({ tipo, numero: f.noFactura, ...data })
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

// ─── Verificación pública anti-tamper ─────────────────────────────────────────
// Genera el HMAC sobre cada factura activa y matchea el `:hash` que viene en el
// QR/link del PDF. NO valida contra una columna almacenada — el hash siempre
// se RECOMPUTA, así un PDF alterado revela inconsistencia (cambia el monto en
// Photoshop -> el hash mostrado ya no matchea con el real).
const verifyLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })

app.get('/api/publico/verify/:hash', verifyLimiter, async (req, res) => {
  try {
    const hash = String(req.params.hash || '').toLowerCase()
    if (!/^[a-f0-9]{24}$/.test(hash)) return res.status(400).json({ valid: false, error: 'Hash inválido.' })

    // Búsqueda eficiente: solo facturas activas. Para volúmenes grandes consider
    // precomputar columna verifyHash con índice. Por ahora, scan acotado.
    const candidatos = await prisma.factura.findMany({
      where:  { deletedAt: null },
      select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
      orderBy:{ fechaEmision: 'desc' },
      take:   20000,
    })
    const empresa = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { razonSocial: true, rnc: true } })

    const match = candidatos.find(f => facturaVerifyHash(f) === hash)
    if (!match) return res.status(404).json({ valid: false, error: 'Documento no encontrado o alterado.' })

    const cliente = await prisma.cliente.findUnique({ where: { id: match.clienteId }, select: { razonSocial: true } }).catch(() => null)
    res.json({
      valid:       true,
      tipo:        match.esCotizacion ? 'cotizacion' : 'factura',
      noFactura:   match.noFactura,
      ncf:         match.ncf,
      fechaEmision: match.fechaEmision,
      total:       Number(match.total),
      estado:      match.estado,
      cliente:     cliente?.razonSocial ?? null,
      empresa:     empresa ? { razonSocial: empresa.razonSocial, rnc: empresa.rnc } : null,
    })
  } catch (e) {
    console.error('[VERIFY]', e.code, e.message)
    res.status(500).json({ valid: false, error: 'Error interno.' })
  }
})

// Endpoint público para portal B2C (descarga su propia factura)
app.get('/api/portal/facturas/:id/pdf-v2', verificarPortalJWT, async (req, res) => {
  try {
    const fact = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { cliente: true, lineas: { include: { producto: { select: { sku: true, nombre: true } } } } },
    })
    if (!fact || fact.clienteId !== req.portalUser.clienteId) return res.status(404).json({ error: 'No encontrada.' })
    const data = await buildPdfData(fact)
    const html = renderPdfDoc({
      tipo:        fact.esCotizacion ? 'cotizacion' : 'factura',
      numero:      fact.noFactura,
      ...data,
    })
    const pdfBuf = await generarPdfDocumento(html)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${fact.noFactura}.pdf"`)
    res.end(pdfBuf)
  } catch (e) {
    console.error('[PDF PORTAL]', e.message)
    res.status(500).json({ error: 'Error generando PDF.' })
  }
})

// ─── EmpresaPerfil (Singleton ID=1) ──────────────────────────────────────────

// GET semi-público — campos de membrete + logos. Sin PII del representante.
const empresaPublicLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
app.get('/api/configuracion/empresa/publico', empresaPublicLimiter, async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: {
        rnc: true, razonSocial: true, nombreComercial: true, registroMercantil: true,
        direccion: true, sector: true, provincia: true, pais: true,
        telefono: true, email: true, website: true, assets: true, eslogan: true,
      },
    })
    if (!e) return res.status(404).json({ error: 'Perfil no inicializado.' })
    // Limpia el JSON de assets — sólo expone públicamente lo necesario para membrete:
    const safeAssets = {
      logoClaro:  e.assets?.logoClaro  ?? null,
      logoOscuro: e.assets?.logoOscuro ?? null,
    }
    res.json({ ...e, assets: safeAssets })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// GET autenticado — completo (incluye selloFisico, firmaGerente, PII representante)
app.get('/api/configuracion/empresa', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
    if (!e) return res.status(404).json({ error: 'Perfil no inicializado.' })
    res.json(e)
  } catch (err) {
    console.error('[GET /api/configuracion/empresa]', err.code, err.message, err.meta)
    res.status(500).json({ error: 'Error interno.', code: err.code ?? 'UNKNOWN' })
  }
})

// PATCH — permiso granular empresa:editar (puede asignarse a Owner o Admin desde UI roles).
// Telefono permite formato múltiple "X / Y" (ACR usa 2 líneas).
const empresaPatchSchema = z.object({
  rnc:                   z.string().min(9).max(20).optional(),
  razonSocial:           z.string().min(2).max(200).optional(),
  nombreComercial:       z.string().max(200).optional().nullable(),
  registroMercantil:     z.string().max(50).optional().nullable(),
  representanteNombre:   z.string().max(100).optional().nullable(),
  representanteApellido: z.string().max(100).optional().nullable(),
  representanteCedula:   z.string().max(20).optional().nullable().refine(
    v => !v || validarCedulaRD(v),
    { message: 'Cédula RD inválida (dígito verificador no coincide).' }
  ),
  representanteCargo:    z.string().max(80).optional().nullable(),
  direccion:             z.string().max(300).optional().nullable(),
  sector:                z.string().max(100).optional().nullable(),
  provincia:             z.string().max(100).optional().nullable(),
  pais:                  z.string().max(80).optional(),
  tipoEmpresa:           z.string().max(40).optional().nullable(),
  fechaInicio:           z.coerce.date().optional().nullable(),
  telefono:              z.string().max(80).optional().nullable(),
  fax:                   z.string().max(40).optional().nullable(),
  email:                 z.string().email().max(150).optional().nullable().or(z.literal('').transform(() => null)),
  website:               z.string().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  // URLs deben pasar whitelist: Supabase Storage del proyecto o path local. Bloquea tracking-pixels externos.
  assets:                z.object({
    logoClaro:    z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    logoOscuro:   z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    selloFisico:  z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    firmaGerente: z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
  }).partial().optional(),
  eslogan:               z.string().max(200).optional().nullable(),
  // Condiciones comerciales por defecto — cada campo opcional, max 280 char.
  condicionesDefault:    z.object({
    validez:  z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    pago:     z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    entrega:  z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    garantia: z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
  }).partial().optional(),
})

app.patch('/api/configuracion/empresa', verificarJWT, requerirPermiso('empresa:editar'), async (req, res) => {
  try {
    const data = empresaPatchSchema.parse(req.body)
    // Snapshot previo: necesario para identificar URLs huérfanas a remover de Storage
    // cuando el cliente reemplaza o limpia un asset al guardar el form.
    const prevAssets = data.assets
      ? ((await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { assets: true } }))?.assets ?? {})
      : null
    // Merge assets en el JSON existente (no sobreescribir si el cliente omite alguna URL)
    if (data.assets) {
      data.assets = { ...(prevAssets ?? {}), ...data.assets }
    }
    const e = await prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: data,
      create: { id: 1, rnc: data.rnc ?? '', razonSocial: data.razonSocial ?? 'Empresa', ...data },
    })
    auditReq('empresa:perfil_update', req, { campos: Object.keys(data) })

    // Fire-and-forget: limpia Storage de assets que ya no se referencian.
    // Sólo borra paths que viven en el bucket SUPABASE_BUCKET de ACR (validados por pathFromSupabaseUrl).
    if (prevAssets && supabase) {
      setImmediate(async () => {
        try {
          const paths = []
          for (const [k, oldUrl] of Object.entries(prevAssets)) {
            if (!oldUrl) continue
            const newUrl = data.assets?.[k]
            if (newUrl === oldUrl) continue
            const p = pathFromSupabaseUrl(oldUrl)
            if (p) paths.push(p)
          }
          if (paths.length === 0) return
          const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(paths)
          if (error) console.error('[EMPRESA PATCH CLEANUP]', error.message)
          else       console.log('[EMPRESA PATCH CLEANUP OK]', paths.length, 'paths')
        } catch (err) {
          console.error('[EMPRESA PATCH CLEANUP EXCEPTION]', err.message)
        }
      })
    }
    res.json(e)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[EMPRESA PATCH]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Auth Routes ──────────────────────────────────────────────────────────────

const generateKeyPairAsync = util.promisify(crypto.generateKeyPair);

app.get('/api/auth/challenge', async (req, res) => {
  try {
    // Serve from pre-warmed pool if available (avoids cold-start RSA failure)
    const now = Date.now()
    for (const [cid, entry] of challengeStore) {
      if (entry.exp > now && entry.publicKey) {
        challengeStore.set(cid, { privateKey: entry.privateKey, exp: now + 120_000 })
        setImmediate(() => warmChallengeStore(1))
        return res.json({ cid, publicKey: entry.publicKey })
      }
    }
    const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const cid = crypto.randomUUID();
    challengeStore.set(cid, { privateKey, exp: now + 120_000 });
    res.json({ cid, publicKey: Buffer.from(publicKey).toString('base64') });
  } catch (error) {
    console.error('[CHALLENGE ERROR]', { message: error.message, code: error.code, stack: error.stack });
    res.status(500).json({ error: 'RSA_FAILURE', message: error.message });
  }
});

const loginSchema = z.object({
  email:      z.string().email(),
  cid:        z.string().uuid(),
  ciphertext: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, cid, ciphertext, rememberMe } = loginSchema.parse(req.body);

    const challenge = challengeStore.get(cid);
    if (!challenge || challenge.exp < Date.now()) {
      return res.status(400).json({ error: 'Challenge inválido o expirado.' });
    }
    challengeStore.delete(cid);

    let password;
    try {
      password = crypto.privateDecrypt(
        { key: challenge.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(ciphertext, 'base64')
      ).toString('utf8');
    } catch { return res.status(401).json({ error: 'Credenciales inválidas.' }); }

    const empleado = await prisma.empleado.findUnique({
      where: { email },
      include: { roles: { where: { activo: true } } },
    });
    if (!empleado || empleado.bloqueado || !empleado.passwordHash) {
      password = null;
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
    const valid = await bcrypt.compare(password, empleado.passwordHash);
    password = null;
    if (!valid) {
      auditReq('auth:login_fail', req, { email });
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // If role mandates 2FA but user hasn't set it up yet → allow login, flag setup required
    const requires2FAByRole = empleado.roles.some(r => r.require2FA)
    if (requires2FAByRole && !empleado.twoFactorEnabled) {
      auditReq('auth:login_success', req, { email: empleado.email, needs2FASetup: true }, { userId: empleado.id, userName: empleado.nombre })
      const payload = await completarLogin(empleado, req, res, rememberMe, true)
      return res.json(payload)
    }

    // Detect suspicious IP (new location vs last known)
    const currentIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null
    const lastLogin = await prisma.auditLog.findFirst({
      where: { evento: 'auth:login_success', usuarioId: empleado.id },
      orderBy: { creadoEn: 'desc' },
    })
    if (lastLogin?.ip && lastLogin.ip !== currentIP) {
      auditReq('auth:suspicious_location', req, { knownIP: lastLogin.ip, newIP: currentIP }, { userId: empleado.id, userName: empleado.nombre })
    }

    // If 2FA enabled, return temp token — full session deferred until TOTP verified
    if (empleado.twoFactorEnabled) {
      const tempToken = crypto.randomUUID()
      twoFAStore.set(tempToken, { empleadoId: empleado.id, exp: Date.now() + 5 * 60_000, rememberMe })
      auditReq('auth:2fa_challenge', req, { email: empleado.email }, { userId: empleado.id, userName: empleado.nombre })
      return res.json({ requires2FA: true, tempToken })
    }

    auditReq('auth:login_success', req, { email: empleado.email }, { userId: empleado.id, userName: empleado.nombre });
    const payload = await completarLogin(empleado, req, res, rememberMe);
    res.json(payload);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.get('/api/auth/me', verificarJWT, async (req, res) => {
  try {
    const emp = await prisma.empleado.findUnique({
      where: { id: req.user.sub },
      select: { twoFactorEnabled: true, roles: { where: { activo: true }, select: { nivel: true } } },
    })
    const permisos = Array.isArray(req.user.permisos) ? req.user.permisos : []
    const needs2FASetup = req.user.needs2FASetup === true && !emp?.twoFactorEnabled
    const nivelMax = emp?.roles?.length ? Math.max(...emp.roles.map(r => r.nivel ?? 0)) : 0
    const out = { id: req.user.sub, nombre: req.user.nombre, permisos, twoFactorEnabled: emp?.twoFactorEnabled ?? false, nivelMax }
    if (needs2FASetup) out.needs2FASetup = true
    res.json(out)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/auth/permissions', verificarJWT, (req, res) => {
  res.json(PERMISSIONS_MAP);
});

// Returns the csrf token from the server-side cookie — safe for cross-origin clients
// that cannot read third-party cookies via document.cookie (CHIPS / ITP).
// The browser sends the cookie; the server echoes it in the JSON body.
app.get('/api/auth/csrf', (req, res) => {
  const token = req.cookies?.csrf
  if (!token) return res.status(401).json({ error: 'No session.' })
  res.json({ csrfToken: token })
});

app.post('/api/auth/logout', verificarJWT, async (req, res) => {
  auditReq('auth:logout', req);
  await prisma.sessionToken.deleteMany({ where: { jti: req.user.jti } });
  res.clearCookie('token');
  res.clearCookie('csrf');
  res.status(204).end();
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const wrapped = req.signedCookies?.token
    if (!wrapped) return res.status(401).json({ error: 'No autenticado.' })
    const jwtStr  = unwrapJWT(wrapped)
    const payload = jwt.verify(jwtStr, process.env.JWT_SECRET, { ignoreExpiration: true })
    const session = await prisma.sessionToken.findUnique({ where: { jti: payload.jti } })
    if (!session) return res.status(401).json({ error: 'Sesión inválida.' })
    // Allow refresh within 7 days after session expiry
    const maxRefreshAt = new Date(session.expiresAt.getTime() + 7 * 24 * 60 * 60 * 1000)
    if (maxRefreshAt < new Date()) return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' })
    const empleado = await prisma.empleado.findUnique({
      where:   { id: payload.sub },
      include: { roles: { where: { activo: true }, select: { permisos: true } } },
    })
    if (!empleado || empleado.deletedAt || empleado.bloqueado) return res.status(401).json({ error: 'Cuenta inactiva.' })
    const newJti    = crypto.randomUUID()
    const ttl       = 8 * 60 * 60 * 1000
    const expiresAt = new Date(Date.now() + ttl)
    await prisma.$transaction([
      prisma.sessionToken.delete({ where: { jti: payload.jti } }),
      prisma.sessionToken.create({ data: { jti: newJti, empleadoId: empleado.id, userAgent: session.userAgent, ip: session.ip, expiresAt } }),
    ])
    const permisos = [...new Set([
      ...(empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : []),
      ...(Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra : []),
    ])]
    const ua        = req.headers['user-agent'] || ''
    const newJwt    = jwt.sign({ sub: empleado.id, nombre: empleado.nombre, permisos, jti: newJti, ua }, process.env.JWT_SECRET, { expiresIn: '8h' })
    const newToken  = wrapJWT(newJwt)
    const csrf      = crypto.randomBytes(32).toString('hex')
    const isProd    = process.env.NODE_ENV === 'production'
    const cookieOpts = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', maxAge: ttl, ...(isProd ? { partitioned: true } : {}) }
    res.cookie('token', newToken, cookieOpts)
    res.cookie('csrf',  csrf,     { ...cookieOpts, httpOnly: false })
    res.setHeader('X-CSRF-Token', csrf)
    auditReq('auth:refresh', req, { empleadoId: empleado.id })
    res.json({ id: empleado.id, nombre: empleado.nombre, permisos, csrfToken: csrf })
  } catch {
    res.status(401).json({ error: 'Token inválido.' })
  }
})

// ─── 2FA Endpoints ────────────────────────────────────────────────────────────

app.post('/api/auth/2fa/verify', totpLimiter, async (req, res) => {
  try {
    const { tempToken, totp } = z.object({ tempToken: z.string().uuid(), totp: z.string().length(6) }).parse(req.body)
    const entry = twoFAStore.get(tempToken)
    if (!entry || entry.exp < Date.now()) return res.status(400).json({ error: 'Token expirado. Vuelve a iniciar sesión.' })
    twoFAStore.delete(tempToken)
    const empleado = await prisma.empleado.findUnique({
      where: { id: entry.empleadoId },
      include: { roles: { where: { activo: true } } },
    })
    if (!empleado || !empleado.twoFactorSecret) return res.status(400).json({ error: 'Error de configuración 2FA.' })

    let secret
    try {
      secret = decryptTOTP(empleado.twoFactorSecret)
    } catch (decryptErr) {
      console.error('[2FA ERROR] decryptTOTP failed — JWT_SECRET mismatch between old and new server:', {
        empleadoId: empleado.id,
        message:    decryptErr.message,
      })
      return res.status(400).json({
        error: '2FA_SECRET_INVALID',
        message: 'El secreto 2FA no puede descifrarse. El administrador debe resetear el 2FA de este usuario.',
      })
    }

    if (!authenticator.verify({ token: totp, secret })) {
      auditReq('auth:2fa_fail', req, {}, { userId: empleado.id, userName: empleado.nombre })
      return res.status(401).json({ error: 'PIN inválido.' })
    }
    auditReq('auth:login_success', req, { via: '2fa' }, { userId: empleado.id, userName: empleado.nombre })
    const payload = await completarLogin(empleado, req, res, entry.rememberMe ?? false)
    res.json(payload)
  } catch (e) {
    console.error('[2FA ERROR]', { message: e.message, stack: e.stack })
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.get('/api/auth/2fa/setup', verificarJWT, async (req, res) => {
  try {
    const secret     = authenticator.generateSecret()
    const encrypted  = encryptTOTP(secret)
    const otpauthUrl = authenticator.keyuri(req.user.nombre, 'ACR Networks ERP', secret)
    const qrCode     = await QRCode.toDataURL(otpauthUrl)
    await prisma.empleado.update({ where: { id: req.user.sub }, data: { twoFactorSecret: encrypted } })
    res.json({ qrCode, secret })
  } catch (e) { console.error('[2fa/setup]', e); res.status(500).json({ error: 'Error generando 2FA.' }) }
})

app.post('/api/auth/2fa/enable', verificarJWT, async (req, res) => {
  try {
    const { totp } = z.object({ totp: z.string().length(6) }).parse(req.body)
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorSecret: true, twoFactorEnabled: true } })
    if (!emp?.twoFactorSecret) return res.status(400).json({ error: 'Genera el QR primero.' })
    if (emp.twoFactorEnabled) return res.status(400).json({ error: '2FA ya está activo.' })
    const secret = decryptTOTP(emp.twoFactorSecret)
    if (!authenticator.verify({ token: totp, secret })) return res.status(401).json({ error: 'PIN inválido.' })
    await prisma.empleado.update({ where: { id: req.user.sub }, data: { twoFactorEnabled: true } })
    auditReq('auth:2fa_enabled', req)
    res.status(204).end()
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'PIN de 6 dígitos requerido.' })
    res.status(500).json({ error: 'Error al activar 2FA.' })
  }
})

app.post('/api/auth/2fa/disable', verificarJWT, async (req, res) => {
  try {
    const { totp } = z.object({ totp: z.string().length(6) }).parse(req.body)
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorSecret: true, twoFactorEnabled: true } })
    if (!emp?.twoFactorEnabled) return res.status(400).json({ error: '2FA no está activo.' })
    const secret = decryptTOTP(emp.twoFactorSecret)
    if (!authenticator.verify({ token: totp, secret })) return res.status(401).json({ error: 'PIN inválido.' })
    await prisma.empleado.update({ where: { id: req.user.sub }, data: { twoFactorEnabled: false, twoFactorSecret: null } })
    auditReq('auth:2fa_disabled', req)
    res.status(204).end()
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'PIN de 6 dígitos requerido.' })
    res.status(500).json({ error: 'Error al desactivar 2FA.' })
  }
})

app.patch('/api/auth/me/password', verificarJWT, async (req, res) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1, 'Contraseña actual requerida.'),
      newPassword: passwordSchema,
    }).parse(req.body)
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { passwordHash: true } })
    if (!emp) return res.status(404).json({ error: 'Usuario no encontrado.' })
    const valid = await bcrypt.compare(currentPassword, emp.passwordHash)
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta.' })
    const newHash = await bcrypt.hash(newPassword, 12)
    await prisma.$transaction([
      prisma.empleado.update({ where: { id: req.user.sub }, data: { passwordHash: newHash } }),
      prisma.sessionToken.deleteMany({ where: { empleadoId: req.user.sub, NOT: { jti: req.user.jti } } }),
    ])
    auditReq('auth:self_password_change', req)
    res.status(204).end()
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.get('/api/auth/me/sessions', verificarJWT, async (req, res) => {
  try {
    const sessions = await prisma.sessionToken.findMany({
      where: { empleadoId: req.user.sub, expiresAt: { gt: new Date() } },
      select: { jti: true, userAgent: true, createdAt: true, expiresAt: true, ip: true },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ data: sessions, current: req.user.jti })
  } catch { res.status(500).json({ error: 'Error obteniendo sesiones.' }) }
})

app.delete('/api/auth/me/sessions/:jti', verificarJWT, async (req, res) => {
  const { jti } = req.params
  if (!jti) return res.status(400).json({ error: 'JTI requerido.' })
  try {
    const session = await prisma.sessionToken.findUnique({ where: { jti } })
    if (!session || session.empleadoId !== req.user.sub) return res.status(404).json({ error: 'Sesión no encontrada.' })
    await prisma.sessionToken.delete({ where: { jti } })
    auditReq('auth:session_revoked', req, { jti })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error cerrando sesión.' }) }
})

// ─── Admin — Global Session Management (Owner only) ──────────────────────────

app.get('/api/admin/sessions', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const sessions = await prisma.sessionToken.findMany({
      where: { expiresAt: { gt: new Date() } },
      select: {
        jti: true, userAgent: true, createdAt: true, expiresAt: true, ip: true,
        empleado: { select: { id: true, nombre: true, cargo: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ data: sessions, current: req.user.jti })
  } catch { res.status(500).json({ error: 'Error obteniendo sesiones.' }) }
})

app.delete('/api/admin/sessions/token/:jti', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  const { jti } = req.params
  try {
    const session = await prisma.sessionToken.findUnique({ where: { jti }, include: { empleado: { select: { id: true } } } })
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada.' })
    if (session.jti === req.user.jti) return res.status(400).json({ error: 'Usa /logout para cerrar tu propia sesión.' })
    await prisma.sessionToken.delete({ where: { jti } })
    auditReq('auth:session_force_revoked', req, { jti, targetEmpleadoId: session.empleado.id })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error cerrando sesión.' }) }
})

// ─── Empleados ────────────────────────────────────────────────────────────────

app.post('/api/empleados', verificarJWT, requerirPermiso('rrhh:editar'), async (req, res) => {
  try {
    const { roleIds, password, ...data } = empleadoSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 12);
    let cargo = 'Técnico';
    if (roleIds.length) {
      const roles = await prisma.rol.findMany({ where: { id: { in: roleIds } }, select: { nombre: true, nivel: true }, orderBy: { nivel: 'desc' } });
      if (roles.length) cargo = roles[0].nombre;
    }
    const e = await prisma.empleado.create({
      data: { ...data, cargo, passwordHash, roles: { connect: roleIds.map(id => ({ id })) } },
      select: { id: true, nombre: true, cargo: true, email: true, bloqueado: true, creadoEn: true, roles: { select: { id: true, nombre: true } } },
    });
    auditReq('rrhh:empleado_creado', req, { nombre: e.nombre });
    res.status(201).json(e);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'Datos inválidos.' });
    if (error.code === 'P2002') return res.status(409).json({ error: 'El email ya está registrado.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.get('/api/empleados', verificarJWT, async (req, res) => {
  try {
    const { search } = req.query;
    const where = { deletedAt: null };
    if (search) where.OR = [
      { nombre: { contains: search, mode: 'insensitive' } },
      { cargo:  { contains: search, mode: 'insensitive' } },
    ];
    const empleados = await prisma.empleado.findMany({
      where, orderBy: { nombre: 'asc' },
      select: {
        id: true, nombre: true, cargo: true, email: true, bloqueado: true, creadoEn: true,
        roles: { select: { id: true, nombre: true } },
      },
    });
    res.json({ data: empleados });
  } catch {
    res.status(500).json({ error: 'Error al obtener empleados.' });
  }
});

app.put('/api/empleados/:id', verificarJWT, requerirPermiso('rrhh:editar'), protegerPropietario, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const { roleIds, password, ...data } = empleadoUpdateSchema.parse(req.body);
    const updateData = { ...data };
    if (password) updateData.passwordHash = await bcrypt.hash(password, 12);
    if (roleIds !== undefined) {
      updateData.roles = { set: roleIds.map(rid => ({ id: rid })) };
      if (roleIds.length) {
        const roles = await prisma.rol.findMany({ where: { id: { in: roleIds } }, select: { nombre: true, nivel: true }, orderBy: { nivel: 'desc' } });
        if (roles.length) updateData.cargo = roles[0].nombre;
      }
    }
    const e = await prisma.empleado.update({
      where: { id }, data: updateData,
      select: { id: true, nombre: true, cargo: true, email: true, bloqueado: true, creadoEn: true, roles: { select: { id: true, nombre: true } } },
    });
    res.json(e);
  } catch (e) {
    if (e instanceof z.ZodError) {
      console.error('[ZOD ERROR RRHH]', e.errors);
      return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors });
    }
    if (e.code === 'P2025') return res.status(404).json({ error: 'Empleado no encontrado.' });
    if (e.code === 'P2002') return res.status(409).json({ error: 'El email ya está registrado.' });
    console.error('[EMPLEADO PUT ERROR]', e.message);
    res.status(500).json({ error: 'Error al actualizar empleado.' });
  }
});

app.delete('/api/empleados/:id', verificarJWT, protegerPropietario, requerirTOTP, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    await prisma.empleado.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Empleado no encontrado.' });
    res.status(500).json({ error: 'Error al eliminar empleado.' });
  }
});

// ─── Asistencia ───────────────────────────────────────────────────────────────

function puedeGestionarAsistencia(req) {
  const perms = Array.isArray(req.user?.permisos) ? req.user.permisos : []
  return perms.includes('sistema:owner') || perms.includes('rrhh:asistencia')
}

app.get('/api/asistencia', verificarJWT, async (req, res) => {
  try {
    const { empleadoId, mes, anio } = req.query;
    const where = {};
    if (!puedeGestionarAsistencia(req)) {
      where.empleadoId = req.user.sub
    } else if (empleadoId) {
      const eid = parseInt(empleadoId); if (eid > 0) where.empleadoId = eid;
    }
    if (mes && anio) {
      const m = parseInt(mes); const y = parseInt(anio);
      where.fechaHora = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    }
    const registros = await prisma.asistencia.findMany({
      where, orderBy: { fechaHora: 'desc' }, take: 300,
      include: { empleado: { select: { id: true, nombre: true, cargo: true } } },
    });
    res.json({ data: registros });
  } catch {
    res.status(500).json({ error: 'Error al obtener asistencia.' });
  }
});

app.post('/api/asistencia', verificarJWT, async (req, res) => {
  try {
    const data = asistenciaSchema.parse(req.body);
    if (!puedeGestionarAsistencia(req) && data.empleadoId !== req.user.sub) {
      return res.status(403).json({ error: 'Solo puedes registrar tu propia asistencia.' })
    }
    // Prevent duplicate Entrada on the same calendar day
    if (data.tipo === 'Entrada') {
      const hoy = new Date();
      const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
      const finDia    = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
      const yaEntrada = await prisma.asistencia.findFirst({
        where: { empleadoId: data.empleadoId, tipo: 'Entrada', fechaHora: { gte: inicioDia, lt: finDia } },
      });
      if (yaEntrada) return res.status(409).json({ error: 'Ya existe una Entrada registrada hoy para este empleado.' });
    }
    const registro = await prisma.asistencia.create({
      data: {
        empleadoId: data.empleadoId,
        tipo:       data.tipo,
        ...(data.latitud  != null && { latitud:  data.latitud }),
        ...(data.longitud != null && { longitud: data.longitud }),
      },
      include: { empleado: { select: { id: true, nombre: true } } },
    });
    res.status(201).json(registro);
  } catch (e) {
    if (e.code === 'P2003') return res.status(400).json({ error: 'Empleado no encontrado.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

// ─── Clientes ─────────────────────────────────────────────────────────────────

app.get('/api/clientes', async (req, res) => {
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
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

app.post('/api/clientes', async (req, res) => {
  try {
    const { prospectoOrigenId, ...body } = req.body;
    const data = clienteSchema.parse(body);
    if (prospectoOrigenId) {
      if (!validUUID(prospectoOrigenId)) return res.status(400).json({ error: 'prospectoOrigenId inválido.' });
      const cliente = await prisma.$transaction(async (tx) => {
        const c = await tx.cliente.create({ data });
        await tx.prospecto.update({ where: { id: prospectoOrigenId }, data: { estado: 'Convertido' } });
        return c;
      });
      return res.status(201).json(formatCliente(cliente));
    }
    const cliente = await prisma.cliente.create({ data });
    res.status(201).json(formatCliente(cliente));
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de cliente ya existe.' });
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.put('/api/clientes/:id', async (req, res) => {
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

app.delete('/api/clientes/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const existing = await prisma.cliente.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Cliente no encontrado.' })
    await prisma.cliente.update({
      where: { id: req.params.id },
      data: { activo: false, deletedAt: new Date() },
    })
    auditReq('crm:cliente_eliminado', req, { clienteId: req.params.id });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar cliente.' });
  }
});

app.patch('/api/clientes/:id/toggle', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const current = await prisma.cliente.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const updated = await prisma.cliente.update({
      where: { id: req.params.id },
      data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
    });
    res.json(formatCliente(updated));
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

// ─── Suplidores ───────────────────────────────────────────────────────────────

app.get('/api/suplidores', async (req, res) => {
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
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener suplidores' });
  }
});

app.post('/api/suplidores', async (req, res) => {
  try {
    const data = suplidorSchema.parse(req.body);
    res.status(201).json(formatSuplidor(await prisma.suplidor.create({ data })));
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de suplidor ya existe.' });
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.put('/api/suplidores/:id', async (req, res) => {
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

app.patch('/api/suplidores/:id/toggle', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const current = await prisma.suplidor.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Suplidor no encontrado.' });
    const updated = await prisma.suplidor.update({
      where: { id: req.params.id },
      data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
    });
    res.json(formatSuplidor(updated));
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

// ─── Prospectos ───────────────────────────────────────────────────────────────

app.get('/api/prospectos', async (req, res) => {
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
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener prospectos' });
  }
});

app.post('/api/prospectos', async (req, res) => {
  try {
    const data = prospectoSchema.parse(req.body);
    res.status(201).json(formatProspecto(await prisma.prospecto.create({ data })));
  } catch (error) {
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.put('/api/prospectos/:id', async (req, res) => {
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

app.delete('/api/prospectos/:id', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    await prisma.prospecto.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Prospecto no encontrado.' });
    res.status(500).json({ error: 'Error al eliminar prospecto' });
  }
});

app.patch('/api/prospectos/:id/convertir', verificarJWT, async (req, res) => {
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

// ─── Mapa NOC ─────────────────────────────────────────────────────────────────

app.get('/api/mapa-noc', async (req, res) => {
  try {
    const [clientes, suplidores, prospectos, nC, nS, nP] = await Promise.all([
      prisma.cliente.findMany({
        select: { id: true, razonSocial: true, latitud: true, longitud: true, activo: true, telefonoPrincipal: true, servicios: { select: { plan: { select: { tipo: true } } }, where: { estado: 'Activo' }, take: 1 } },
        where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
      }),
      prisma.suplidor.findMany({
        select: { id: true, razonSocial: true, latitud: true, longitud: true, activo: true, actividad: true, telefonoPrincipal: true },
        where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
      }),
      prisma.prospecto.findMany({
        select: { id: true, nombre: true, latitud: true, longitud: true, estado: true, servicioInteresado: true, telefono: true },
        where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
      }),
      prisma.cliente.count(),
      prisma.suplidor.count(),
      prisma.prospecto.count(),
    ]);

    const toMarker = (list, tipo) => list.flatMap(r => {
      const lat = parseFloat(r.latitud);
      const lng = parseFloat(r.longitud);
      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return [];
      return [{
        id:      r.id,
        tipo,
        nombre:  r.razonSocial ?? r.nombre,
        lat,
        lng,
        activo:  r.activo ?? null,
        estado:  r.estado ?? null,
        servicio: r.servicios?.[0]?.plan?.tipo ?? r.actividad ?? r.servicioInteresado,
        telefono: fmtPhone(r.telefonoPrincipal ?? r.telefono),
      }];
    });

    res.json({
      markers: [
        ...toMarker(clientes,   'cliente'),
        ...toMarker(suplidores, 'suplidor'),
        ...toMarker(prospectos, 'prospecto'),
      ],
      totales: { clientes: nC, suplidores: nS, prospectos: nP },
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener mapa NOC' });
  }
});

// ─── Inventario: Schemas ─────────────────────────────────────────────────────

const stripTags = v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;

const categoriaSchema = z.object({
  nombre: z.string().min(2).max(100).transform(stripTags),
});

const productoSchema = z.object({
  sku:            z.string().min(1).max(50).transform(stripTags),
  nombre:         z.string().min(2).max(200).transform(stripTags),
  precio:         z.coerce.number().nonnegative(),
  categoriaId:    z.number().int().positive(),
  tipoItem:       z.enum(['ARTICULO', 'SERVICIO']).optional(),
  esCanibalizado: z.boolean().optional(),
  descripcion:    z.string().max(1000).optional().nullable().transform(v => v ?? null),
  imagenUrl:      z.string().max(500).url().optional().nullable().or(z.literal('').transform(() => null)),
});

const productoUpdateSchema = productoSchema.omit({ sku: true }).partial();

function formatProducto(p) { return { ...p, precio: Number(p.precio) }; }

// ─── Categorías ───────────────────────────────────────────────────────────────

app.get('/api/categorias', async (req, res) => {
  try {
    const { search } = req.query;
    const where = search ? { nombre: { contains: search, mode: 'insensitive' } } : {};
    const categorias = await prisma.categoria.findMany({
      where, orderBy: { nombre: 'asc' },
      include: { _count: { select: { productos: true } } },
    });
    res.json({ data: categorias });
  } catch {
    res.status(500).json({ error: 'Error al obtener categorías.' });
  }
});

app.post('/api/categorias', async (req, res) => {
  try {
    const data = categoriaSchema.parse(req.body);
    const cat = await prisma.categoria.create({ data, include: { _count: { select: { productos: true } } } });
    res.status(201).json(cat);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.put('/api/categorias/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const data = categoriaSchema.parse(req.body);
    const cat = await prisma.categoria.update({ where: { id }, data, include: { _count: { select: { productos: true } } } });
    res.json(cat);
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Categoría no encontrada.' });
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.delete('/api/categorias/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    await prisma.categoria.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Categoría no encontrada.' });
    if (e.code === 'P2003') return res.status(409).json({ error: 'No se puede eliminar: la categoría tiene productos asociados.' });
    res.status(500).json({ error: 'Error al eliminar categoría.' });
  }
});

// ─── Productos ────────────────────────────────────────────────────────────────

app.get('/api/productos', async (req, res) => {
  try {
    const { search, categoriaId, tipoItem, canibalizados, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (categoriaId) { const cid = parseInt(categoriaId); if (cid > 0) where.categoriaId = cid; }
    if (tipoItem && ['ARTICULO', 'SERVICIO'].includes(tipoItem)) where.tipoItem = tipoItem;
    if (canibalizados === 'true')  where.esCanibalizado = true;
    if (canibalizados === 'false') where.esCanibalizado = false;
    if (search) where.OR = [
      { nombre: { contains: search, mode: 'insensitive' } },
      { sku:    { contains: search, mode: 'insensitive' } },
    ];
    const [productos, total] = await Promise.all([
      prisma.producto.findMany({
        where, orderBy: { nombre: 'asc' }, skip, take,
        include: { categoria: { select: { id: true, nombre: true } } },
      }),
      prisma.producto.count({ where }),
    ]);
    res.json({ data: productos.map(formatProducto), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
  } catch (e) {
    console.error('[GET /api/productos]', e.message, e.stack);
    res.status(500).json({ error: 'Error al obtener productos.' });
  }
});

app.post('/api/productos', async (req, res) => {
  try {
    const data = productoSchema.parse(req.body);
    const producto = await prisma.producto.create({
      data, include: { categoria: { select: { id: true, nombre: true } } },
    });
    res.status(201).json(formatProducto(producto));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un producto con ese SKU.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'Categoría no válida.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.put('/api/productos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const data = productoUpdateSchema.parse(req.body);
    const producto = await prisma.producto.update({
      where: { id }, data,
      include: { categoria: { select: { id: true, nombre: true } } },
    });
    res.json(formatProducto(producto));
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Producto no encontrado.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'Categoría no válida.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.delete('/api/productos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    await prisma.producto.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Producto no encontrado.' });
    if (e.code === 'P2003') return res.status(409).json({ error: 'No se puede eliminar: el producto está en uso en órdenes o plantillas.' });
    res.status(500).json({ error: 'Error al eliminar producto.' });
  }
});

// ─── Movimientos (Kardex) ─────────────────────────────────────────────────────

app.get('/api/movimientos', async (req, res) => {
  try {
    const { productoId, tipo, search, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (productoId) { const pid = parseInt(productoId); if (pid > 0) where.productoId = pid; }
    if (tipo === 'Entrada' || tipo === 'Salida') where.tipo = tipo;
    if (search) where.producto = { OR: [
      { nombre: { contains: search, mode: 'insensitive' } },
      { sku:    { contains: search, mode: 'insensitive' } },
    ]};
    const [movimientos, total] = await Promise.all([
      prisma.movimientoInventario.findMany({
        where, orderBy: { fecha: 'desc' }, skip, take,
        include: {
          producto: { select: { id: true, nombre: true, sku: true } },
          orden:    { select: { id: true, tipo: true, servicio: { select: { cliente: { select: { razonSocial: true } } } } } },
        },
      }),
      prisma.movimientoInventario.count({ where }),
    ]);
    res.json({ data: movimientos, meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
  } catch {
    res.status(500).json({ error: 'Error al obtener movimientos.' });
  }
});

// ─── Planes ───────────────────────────────────────────────────────────────────

const TIPOS_SERVICIO = ['WISP','CCTV','Redes','CercoElectrico','VentaDirecta','Mixto','SoporteTecnico','Reparacion','ProyectoCCTV'];

const plantillaEquipoShape = z.object({
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().positive(),
});

const planSchema = z.object({
  nombre:            z.string().min(2).max(100),
  tipo:              z.enum(TIPOS_SERVICIO),
  precioMensualBase: z.coerce.number().nonnegative().default(0),
  precioInstalBase:  z.coerce.number().nonnegative().default(0),
  activo:            z.boolean().default(true),
  plantillaEquipos:  z.array(plantillaEquipoShape).default([]),
});

const planUpdateSchema = planSchema.partial();

function formatPlan(p) {
  return { ...p, precioMensualBase: Number(p.precioMensualBase), precioInstalBase: Number(p.precioInstalBase) };
}

app.get('/api/planes', async (req, res) => {
  try {
    const { search, activo, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (activo !== undefined) where.activo = activo === 'true';
    if (search) where.OR = [
      { nombre: { contains: search, mode: 'insensitive' } },
      { tipo:   { contains: search, mode: 'insensitive' } },
    ];
    const [planes, total] = await Promise.all([
      prisma.plan.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } } }),
      prisma.plan.count({ where }),
    ]);
    res.json({ data: planes.map(formatPlan), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener planes' });
  }
});

app.get('/api/planes/:id', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true, stockActual: true } } } } } });
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado.' });
    res.json(formatPlan(plan));
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener plan' });
  }
});

app.post('/api/planes', async (req, res) => {
  try {
    const { plantillaEquipos, ...rest } = planSchema.parse(req.body);
    const plan = await prisma.plan.create({
      data: { ...rest, plantillaEquipos: { create: plantillaEquipos } },
      include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } },
    });
    res.status(201).json(formatPlan(plan));
  } catch (error) {
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.put('/api/planes/:id', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const { plantillaEquipos, ...rest } = planUpdateSchema.parse(req.body);
    const plan = await prisma.$transaction(async (tx) => {
      if (plantillaEquipos !== undefined) {
        await tx.plantillaEquipo.deleteMany({ where: { planId: req.params.id } });
        await tx.plantillaEquipo.createMany({ data: plantillaEquipos.map(e => ({ ...e, planId: req.params.id })) });
      }
      return tx.plan.update({
        where: { id: req.params.id }, data: rest,
        include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } },
      });
    });
    res.json(formatPlan(plan));
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Plan no encontrado.' });
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.patch('/api/planes/:id/toggle', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const current = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Plan no encontrado.' });
    const updated = await prisma.plan.update({ where: { id: req.params.id }, data: { activo: !current.activo } });
    res.json(formatPlan(updated));
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

// ─── Servicios ────────────────────────────────────────────────────────────────

const ESTADOS_SERVICIO = ['Pendiente','EnInstalacion','Activo','Suspendido','Cancelado'];

const servicioSchema = z.object({
  clienteId:            z.string().uuid(),
  planId:               z.string().uuid(),
  estado:               z.enum(ESTADOS_SERVICIO).default('Pendiente'),
  precioMensual:        z.coerce.number().nonnegative().default(0),
  precioInstalacion:    z.coerce.number().nonnegative().default(0),
  notasTecnicas:        nullStr(2000),
  direccionInstalacion: nullStr(300),
  latitud:              nullStr(20),
  longitud:             nullStr(20),
});

const servicioUpdateSchema = servicioSchema.omit({ clienteId: true }).partial();

function formatServicio(s) {
  return { ...s, precioMensual: Number(s.precioMensual), precioInstalacion: Number(s.precioInstalacion) };
}

app.get('/api/servicios', async (req, res) => {
  try {
    const { search, estado, clienteId, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (estado) where.estado = estado;
    if (clienteId && validUUID(clienteId)) where.clienteId = clienteId;
    if (search) where.OR = [
      { cliente: { razonSocial: { contains: search, mode: 'insensitive' } } },
      { plan:    { nombre:      { contains: search, mode: 'insensitive' } } },
      { direccionInstalacion: { contains: search, mode: 'insensitive' } },
    ];
    const [servicios, total] = await Promise.all([
      prisma.servicio.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { cliente: { select: { id: true, razonSocial: true, noCliente: true, telefonoPrincipal: true } }, plan: { select: { id: true, nombre: true, tipo: true } } } }),
      prisma.servicio.count({ where }),
    ]);
    res.json({ data: servicios.map(formatServicio), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener servicios' });
  }
});

app.post('/api/servicios', async (req, res) => {
  try {
    const data = servicioSchema.parse(req.body);
    const servicio = await prisma.$transaction(async (tx) => {
      const noServicio = await nextNomenclatura(tx, 'SV')
      return tx.servicio.create({ data: { ...data, noServicio }, include: { cliente: { select: { id: true, razonSocial: true, noCliente: true, telefonoPrincipal: true } }, plan: { select: { id: true, nombre: true, tipo: true } } } })
    })
    res.status(201).json(formatServicio(servicio));
  } catch (error) {
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.put('/api/servicios/:id', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const data = servicioUpdateSchema.parse(req.body);
    const servicio = await prisma.servicio.update({ where: { id: req.params.id }, data, include: { cliente: { select: { id: true, razonSocial: true, noCliente: true, telefonoPrincipal: true } }, plan: { select: { id: true, nombre: true, tipo: true } } } });
    res.json(formatServicio(servicio));
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Servicio no encontrado.' });
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.patch('/api/servicios/:id/estado', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const { estado } = z.object({ estado: z.enum(ESTADOS_SERVICIO) }).parse(req.body);
    const servicio = await prisma.servicio.update({ where: { id: req.params.id }, data: { estado } });
    res.json(formatServicio(servicio));
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Servicio no encontrado.' });
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

// ─── Órdenes de Instalación ───────────────────────────────────────────────────

const TIPOS_ORDEN = ['Instalacion','Retiro','ServicioTecnico','Mantenimiento'];

const detalleOrdenShape = z.object({
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().positive(),
});

const ordenSchema = z.object({
  servicioId:  z.string().uuid(),
  tipo:        z.enum(TIPOS_ORDEN),
  tecnicoId:   z.number().int().positive(),
  notas:       nullStr(1000),
  diagnostico: nullStr(2000),
  solucion:    nullStr(2000),
  garantiaDias: z.coerce.number().int().min(0).optional().nullable(),
  detalles:    z.array(detalleOrdenShape).default([]),
});

const ordenUpdateSchema = z.object({
  tecnicoId:   z.number().int().positive().optional(),
  notas:       nullStr(1000),
  diagnostico: nullStr(2000),
  solucion:    nullStr(2000),
  garantiaDias: z.coerce.number().int().min(0).optional().nullable(),
  detalles:    z.array(detalleOrdenShape).optional(),
});

const ordenInclude = {
  servicio: { include: { cliente: { select: { id: true, razonSocial: true, noCliente: true } }, plan: { select: { nombre: true, tipo: true } } } },
  tecnico:  { select: { id: true, nombre: true, cargo: true } },
  detalles: { include: { producto: { select: { id: true, nombre: true, sku: true, stockActual: true } } } },
};

const ESTADO_SERVICIO_POR_TIPO_ORDEN = {
  Instalacion:    'Activo',
  Retiro:         'Cancelado',
  ServicioTecnico:'Activo',
  Mantenimiento:  'Activo',
};

app.get('/api/ordenes', async (req, res) => {
  try {
    const { search, estado, tipo, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (estado) where.estado = estado;
    if (tipo) where.tipo = tipo;
    if (search) where.OR = [
      { servicio: { cliente: { razonSocial: { contains: search, mode: 'insensitive' } } } },
      { servicio: { plan:    { nombre:      { contains: search, mode: 'insensitive' } } } },
      { tecnico:  { nombre:  { contains: search, mode: 'insensitive' } } },
    ];
    const [ordenes, total] = await Promise.all([
      prisma.ordenInstalacion.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: ordenInclude }),
      prisma.ordenInstalacion.count({ where }),
    ]);
    res.json({ data: ordenes, meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener órdenes' });
  }
});

app.post('/api/ordenes', async (req, res) => {
  try {
    const { detalles, ...rest } = ordenSchema.parse(req.body);
    const orden = await prisma.ordenInstalacion.create({
      data: { ...rest, estado: 'Pendiente', detalles: { create: detalles } },
      include: ordenInclude,
    });
    if (rest.tipo === 'Instalacion') {
      await prisma.servicio.update({ where: { id: rest.servicioId }, data: { estado: 'EnInstalacion' } });
    }
    res.status(201).json(orden);
  } catch (error) {
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.put('/api/ordenes/:id', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const { detalles, ...rest } = ordenUpdateSchema.parse(req.body);
    const orden = await prisma.$transaction(async (tx) => {
      if (detalles !== undefined) {
        await tx.detalleOrden.deleteMany({ where: { ordenId: req.params.id } });
        if (detalles.length > 0) {
          await tx.detalleOrden.createMany({ data: detalles.map(d => ({ ...d, ordenId: req.params.id })) });
        }
      }
      return tx.ordenInstalacion.update({ where: { id: req.params.id }, data: rest, include: ordenInclude });
    });
    res.json(orden);
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Orden no encontrada.' });
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

app.patch('/api/ordenes/:id/completar', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const orden = await prisma.ordenInstalacion.findUnique({ where: { id: req.params.id }, include: { detalles: true } });
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });
    if (orden.estado === 'Completada') return res.status(409).json({ error: 'La orden ya está completada.' });

    const tipoMovimiento = orden.tipo === 'Retiro' ? 'Entrada' : 'Salida';
    const nuevoEstadoServicio = ESTADO_SERVICIO_POR_TIPO_ORDEN[orden.tipo] ?? 'Activo';
    const stockInsuficiente = [];

    if (tipoMovimiento === 'Salida' && orden.detalles.length > 0) {
      const productos = await prisma.producto.findMany({ where: { id: { in: orden.detalles.map(d => d.productoId) } }, select: { id: true, nombre: true, stockActual: true } });
      const stockMap = Object.fromEntries(productos.map(p => [p.id, p]));
      for (const d of orden.detalles) {
        const p = stockMap[d.productoId];
        if (p && p.stockActual < d.cantidad) stockInsuficiente.push({ nombre: p.nombre, stockActual: p.stockActual, requerido: d.cantidad });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      for (const d of orden.detalles) {
        const delta = tipoMovimiento === 'Salida' ? -d.cantidad : d.cantidad;
        await tx.producto.update({ where: { id: d.productoId }, data: { stockActual: { increment: delta } } });
        await tx.movimientoInventario.create({ data: { productoId: d.productoId, tipo: tipoMovimiento, cantidad: d.cantidad, ordenInstalacionId: orden.id } });
      }
      await tx.servicio.update({ where: { id: orden.servicioId }, data: { estado: nuevoEstadoServicio } });
      return tx.ordenInstalacion.update({ where: { id: req.params.id }, data: { estado: 'Completada', completadaEn: new Date() }, include: ordenInclude });
    });

    res.json({ orden: result, alertasStock: stockInsuficiente });
  } catch (error) {
    res.status(500).json({ error: 'Error al completar orden' });
  }
});

// ─── Dashboard (KPIs) ─────────────────────────────────────────────────────────

// POOL NOTE FOR CTO: Supabase session-mode PgBouncer limits connections per session.
// Add to your .env to cap Prisma's pool and prevent EMAXCONNSESSION:
//   DATABASE_URL="postgresql://...?connection_limit=5&pool_timeout=10&pgbouncer=true"
// connection_limit=5  → Prisma opens at most 5 simultaneous DB connections
// pool_timeout=10     → queries wait up to 10s for a free slot before failing
// pgbouncer=true      → disables Prisma's session-level prepared statements (required for PgBouncer)

app.get('/api/dashboard', verificarJWT, async (req, res) => {
  try {
    if (dashCache && Date.now() < dashCacheExp) return res.json(dashCache);
    const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1)

    // Single CTE query — all 18 KPIs in ONE DB round-trip = ONE connection slot.
    // Eliminates EMAXCONNSESSION: previously 18 parallel queries saturated PgBouncer
    // session-mode pool. Now: 1 CTE + 1 stock findMany + 1 NCF findMany = 3 max.
    const [kpi] = await prisma.$queryRaw`
      WITH
        svc AS (
          SELECT
            COUNT(*) FILTER (WHERE estado = 'Activo')::int        AS activos,
            COUNT(*) FILTER (WHERE estado = 'Pendiente')::int     AS pendientes,
            COUNT(*) FILTER (WHERE estado = 'EnInstalacion')::int AS "enInstalacion",
            COUNT(*) FILTER (WHERE estado = 'Suspendido')::int    AS suspendidos,
            COUNT(*) FILTER (WHERE estado = 'Cancelado')::int     AS cancelados,
            COALESCE(SUM("precioMensual") FILTER (WHERE estado = 'Activo'), 0)::float8 AS ingresos
          FROM "Servicio"
        ),
        cli AS (
          SELECT
            COUNT(*)::int                                    AS total,
            COUNT(*) FILTER (WHERE activo = true)::int      AS activos
          FROM "Cliente"
          WHERE "deletedAt" IS NULL
        ),
        tec AS (SELECT COUNT(*)::int AS total FROM "Empleado"),
        oi  AS (
          SELECT COUNT(*) FILTER (WHERE estado = 'Pendiente')::int AS pendientes
          FROM "OrdenInstalacion"
        ),
        fac AS (
          SELECT
            COALESCE(SUM(total) FILTER (WHERE "fechaEmision" >= ${inicioMes} AND estado != 'Anulada'), 0)::float8  AS "facturadoMes",
            COUNT(*)            FILTER (WHERE "fechaEmision" >= ${inicioMes} AND estado != 'Anulada')::int          AS "facturasEmitidasMes",
            COALESCE(SUM(total) FILTER (WHERE estado = 'Pagada' AND "fechaPago" >= ${inicioMes}), 0)::float8       AS "cobradoMes",
            COUNT(*)            FILTER (WHERE estado = 'Vencida')::int                                              AS "vencidasCount",
            COALESCE(SUM(total) FILTER (WHERE estado = 'Vencida'), 0)::float8                                       AS "vencidasMonto"
          FROM "Factura"
        ),
        ots AS (
          SELECT
            COUNT(*) FILTER (WHERE estado = 'Pendiente')::int AS "otsPendientes",
            COUNT(*) FILTER (WHERE estado = 'EnProceso')::int AS "otsEnProceso"
          FROM "OrdenTrabajo"
        )
      SELECT
        svc.activos, svc.pendientes, svc."enInstalacion", svc.suspendidos, svc.cancelados, svc.ingresos,
        cli.total AS "totalClientes", cli.activos AS "clientesActivos",
        tec.total AS tecnicos,
        oi.pendientes AS "ordenesPendientes",
        fac."facturadoMes", fac."facturasEmitidasMes", fac."cobradoMes", fac."vencidasCount", fac."vencidasMonto",
        ots."otsPendientes", ots."otsEnProceso"
      FROM svc, cli, tec, oi, fac, ots
    `

    const stockCritico = await prisma.producto.findMany({
      where: { stockActual: { lte: 5 } },
      select: { id: true, nombre: true, sku: true, stockActual: true },
      orderBy: { stockActual: 'asc' }, take: 10,
    })

    let ncfAlerts = []
    try {
      const ncfConfigs = await prisma.configuracionNCF.findMany({ where: { activo: true } })
      ncfAlerts = ncfConfigs
        .filter(c => c.limite > 0 && c.secuenciaActual / c.limite >= 0.90)
        .map(c => ({
          tipoNcf:   c.tipoNcf,
          restantes: c.limite - c.secuenciaActual,
          pct:       Math.round((c.secuenciaActual / c.limite) * 100),
        }))
    } catch (ncfErr) {
      console.error('[DASHBOARD] ncfAlerts query failed:', ncfErr.message)
    }

    dashCache = {
      servicios: {
        activos:       Number(kpi.activos),
        pendientes:    Number(kpi.pendientes),
        enInstalacion: Number(kpi.enInstalacion),
        suspendidos:   Number(kpi.suspendidos),
        cancelados:    Number(kpi.cancelados),
      },
      ordenesPendientes:          Number(kpi.ordenesPendientes),
      stockCritico,
      ingresosMensualesEstimados: Number(kpi.ingresos),
      clientes: { total: Number(kpi.totalClientes), activos: Number(kpi.clientesActivos) },
      tecnicos:                   Number(kpi.tecnicos),
      billing: {
        facturadoMes:        Number(kpi.facturadoMes),
        facturasEmitidasMes: Number(kpi.facturasEmitidasMes),
        cobradoMes:          Number(kpi.cobradoMes),
        vencidasCount:       Number(kpi.vencidasCount),
        vencidasMonto:       Number(kpi.vencidasMonto),
        otsPendientes:       Number(kpi.otsPendientes),
        otsEnProceso:        Number(kpi.otsEnProceso),
      },
      ncfAlerts,
    };
    dashCacheExp = Date.now() + 60_000;
    res.json(dashCache);
  } catch (error) {
    console.error('[DASHBOARD ERROR]', error);
    res.status(500).json({ error: error.message || 'Error interno al obtener dashboard.' });
  }
});

// ─── Admin: Permisos y Sesiones ───────────────────────────────────────────────

app.get('/api/admin/empleados', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  try {
    const empleados = await prisma.empleado.findMany({
      select: {
        id: true, nombre: true, cargo: true, email: true, bloqueado: true, creadoEn: true,
        permisosExtra: true, twoFactorEnabled: true,
        roles: { select: { id: true, nombre: true, activo: true, permisos: true } },
      },
      orderBy: { nombre: 'asc' },
    });
    res.json({ data: empleados });
  } catch { res.status(500).json({ error: 'Error al obtener empleados.' }); }
});

app.patch('/api/admin/empleados/:id/roles', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  // Anti-self-escalation
  if (id === req.user.sub) return res.status(403).json({ error: 'No puedes modificar tus propios roles.' });
  try {
    const { roleIds } = z.object({ roleIds: z.array(z.number().int().positive()) }).parse(req.body);
    const current = await prisma.empleado.findUnique({ where: { id }, include: { roles: { select: { permisos: true } } } });
    const currentPerms = current?.roles?.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []) ?? [];
    if (currentPerms.includes('sistema:owner')) {
      const rolesToAssign = await prisma.rol.findMany({ where: { id: { in: roleIds } } });
      const merged = [...new Set(rolesToAssign.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []))];
      if (!merged.includes('sistema:owner')) return res.status(403).json({ error: 'El propietario debe conservar un rol con sistema:owner.' });
    }
    // Anti-privilege-escalation: non-owner can only assign roles whose perms are a subset of their own
    if (!req.user.permisos?.includes('sistema:owner')) {
      const callerPerms = new Set(Array.isArray(req.user.permisos) ? req.user.permisos : [])
      const rolesToAssign = await prisma.rol.findMany({ where: { id: { in: roleIds } }, select: { id: true, nombre: true, permisos: true, nivel: true } })
      for (const rol of rolesToAssign) {
        const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : []
        const escalated = rolPerms.find(p => !callerPerms.has(p))
        if (escalated) return res.status(403).json({ error: `No puedes asignar el rol "${rol.nombre}": contiene permiso "${escalated}" que tú no posees.` })
      }
      // nivel check: cannot assign a role with nivel >= own nivelMax
      const callerRoles = await prisma.rol.findMany({ where: { empleados: { some: { id: req.user.sub } }, activo: true }, select: { nivel: true } })
      const callerNivel = callerRoles.length ? Math.max(...callerRoles.map(r => r.nivel ?? 0)) : 0
      for (const rol of rolesToAssign) {
        if ((rol.nivel ?? 0) >= callerNivel) {
          return res.status(403).json({ error: `No puedes asignar el rol "${rol.nombre}" (nivel ${rol.nivel}): tu nivel máximo es ${callerNivel}.` })
        }
      }
    }
    const newRoles     = await prisma.rol.findMany({ where: { id: { in: roleIds } } });
    const newRolePerms = new Set(newRoles.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []));
    const e = await prisma.$transaction(async (tx) => {
      const emp    = await tx.empleado.findUnique({ where: { id }, select: { permisosExtra: true } });
      const extras = Array.isArray(emp?.permisosExtra) ? emp.permisosExtra : [];
      const cleanedExtras = extras.filter(p => !newRolePerms.has(p));
      return tx.empleado.update({
        where: { id },
        data: {
          roles: { set: roleIds.map(rid => ({ id: rid })) },
          ...(cleanedExtras.length !== extras.length ? { permisosExtra: cleanedExtras } : {}),
        },
        include: { roles: { select: { id: true, nombre: true } } },
      });
    });
    auditReq('admin:roles_update', req, { targetId: id, roleIds });
    res.json({ id: e.id, roles: e.roles });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.patch('/api/admin/empleados/:id/permisos-extra', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const { permisosExtra } = z.object({ permisosExtra: z.array(z.string()) }).parse(req.body);
    const emp = await prisma.empleado.findUnique({ where: { id }, include: { roles: { where: { activo: true }, select: { permisos: true } } } });
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const rolePerms = new Set(emp.roles.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []));
    const cleanedExtras = permisosExtra.filter(p => !rolePerms.has(p));
    await prisma.empleado.update({ where: { id }, data: { permisosExtra: cleanedExtras } });
    auditReq('admin:permisos_extra_update', req, { targetId: id, count: cleanedExtras.length });
    res.status(204).end();
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
    res.status(500).json({ error: 'Error al actualizar permisos extra.' });
  }
});

// ─── Roles CRUD ───────────────────────────────────────────────────────────────

const rolSchema = z.object({
  nombre:      z.string().min(2).max(100),
  descripcion: z.string().max(200).optional().nullable(),
  permisos:    z.array(z.string()).default([]),
  activo:      z.boolean().default(true),
  nivel:       z.number().int().min(0).max(100).optional().default(0),
  require2FA:  z.boolean().optional().default(false),
});
const rolUpdateSchema = rolSchema.partial();

app.get('/api/roles', verificarJWT, async (req, res) => {
  try {
    const roles = await prisma.rol.findMany({
      select: {
        id:          true,
        nombre:      true,
        descripcion: true,
        permisos:    true,
        activo:      true,
        nivel:       true,
        require2FA:  true,
        createdAt:   true,
        updatedAt:   true,
        _count:      { select: { empleados: true } },
      },
      orderBy: { nombre: 'asc' },
    });
    res.json({ data: roles });
  } catch { res.status(500).json({ error: 'Error al obtener roles.' }); }
});

async function requerirTOTP(req, res, next) {
  try {
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorEnabled: true, twoFactorSecret: true } })
    if (!emp?.twoFactorEnabled) return next()
    const code = req.headers['x-totp'] || req.body?.totp
    if (!code) return res.status(403).json({ error: 'Esta acción destructiva requiere tu código TOTP de 2FA.' })
    const secret = decryptTOTP(emp.twoFactorSecret)
    if (!authenticator.verify({ token: String(code), secret })) return res.status(401).json({ error: 'Código TOTP inválido o expirado.' })
    next()
  } catch { next() }
}

async function callerNivelMax(userId) {
  const roles = await prisma.rol.findMany({ where: { empleados: { some: { id: userId } }, activo: true }, select: { nivel: true } });
  return roles.length ? Math.max(...roles.map(r => r.nivel ?? 0)) : 0;
}

app.post('/api/roles', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  try {
    const data = rolSchema.parse(req.body);
    if (!req.user.permisos?.includes('sistema:owner')) {
      const myNivel = await callerNivelMax(req.user.sub);
      if ((data.nivel ?? 0) >= myNivel)
        return res.status(403).json({ error: `No puedes crear un rol con nivel ${data.nivel}: tu nivel máximo es ${myNivel}.` });
    }
    const rol  = await prisma.rol.create({ data, include: { _count: { select: { empleados: true } } } });
    auditReq('admin:rol_creado', req, { rolId: rol.id, nombre: rol.nombre });
    res.status(201).json(rol);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un rol con ese nombre.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.put('/api/roles/:id', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const existing = await prisma.rol.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rol no encontrado.' });
    const existingPerms = Array.isArray(existing.permisos) ? existing.permisos : [];
    if (existingPerms.includes('sistema:owner') && !req.user?.permisos?.includes('sistema:owner'))
      return res.status(403).json({ error: 'El rol Owner solo puede ser modificado por el propietario del sistema.' });
    const data = rolUpdateSchema.parse(req.body);
    if (!req.user.permisos?.includes('sistema:owner') && data.nivel !== undefined) {
      const myNivel = await callerNivelMax(req.user.sub);
      if (data.nivel >= myNivel)
        return res.status(403).json({ error: `No puedes asignar nivel ${data.nivel}: tu nivel máximo es ${myNivel}.` });
    }
    const newPerms = Array.isArray(data.permisos) ? data.permisos : [];
    if (existingPerms.includes('sistema:owner') && !newPerms.includes('sistema:owner'))
      return res.status(403).json({ error: 'No se puede remover sistema:owner del rol Owner.' });
    const rol = await prisma.rol.update({ where: { id }, data, include: { _count: { select: { empleados: true } } } });
    auditReq('admin:rol_actualizado', req, { rolId: id });
    res.json(rol);
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Rol no encontrado.' });
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un rol con ese nombre.' });
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.delete('/api/roles/:id', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const rol = await prisma.rol.findUnique({ where: { id }, include: { _count: { select: { empleados: true } } } });
    if (!rol) return res.status(404).json({ error: 'Rol no encontrado.' });
    const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : [];
    if (rolPerms.includes('sistema:owner'))
      return res.status(403).json({ error: 'El rol Owner es inmutable y no puede eliminarse.' });
    if (rol._count.empleados > 0) return res.status(409).json({ error: `No se puede eliminar: ${rol._count.empleados} usuario(s) tienen este rol asignado.` });
    await prisma.rol.delete({ where: { id } });
    auditReq('admin:rol_eliminado', req, { rolId: id, nombre: rol.nombre });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Rol no encontrado.' });
    res.status(500).json({ error: 'Error al eliminar rol.' });
  }
});

app.patch('/api/admin/empleados/:id/password', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const { password } = z.object({ password: passwordSchema }).parse(req.body);
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.empleado.update({ where: { id }, data: { passwordHash } });
    await prisma.sessionToken.deleteMany({ where: { empleadoId: id } });
    auditReq('admin:password_change', req, { targetId: id });
    res.status(204).end();
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Contraseña inválida.' });
    res.status(400).json({ error: 'Error al cambiar contraseña.' });
  }
});

app.patch('/api/admin/empleados/:id/bloquear', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  if (id === req.user.sub) return res.status(403).json({ error: 'No puedes bloquear tu propia cuenta.' });
  try {
    const { bloqueado } = z.object({ bloqueado: z.boolean() }).parse(req.body);
    await prisma.empleado.update({ where: { id }, data: { bloqueado } });
    if (bloqueado) await prisma.sessionToken.deleteMany({ where: { empleadoId: id } });
    auditReq(bloqueado ? 'admin:usuario_bloqueado' : 'admin:usuario_desbloqueado', req, { targetId: id });
    res.status(204).end();
  } catch { res.status(400).json({ error: 'Datos inválidos.' }); }
});

app.delete('/api/admin/sessions/:empleadoId', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
  const empleadoId = parseInt(req.params.empleadoId);
  if (!empleadoId || empleadoId < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    await prisma.sessionToken.deleteMany({ where: { empleadoId } });
    auditReq('admin:sessions_killed', req, { targetId: empleadoId });
    res.status(204).end();
  } catch { res.status(500).json({ error: 'Error al cerrar sesiones.' }); }
});

// ─── Catálogo de Items (Ventas) ───────────────────────────────────────────────

const itemCatalogoSchema = z.object({
  nombre:      z.string().min(1).max(120),
  descripcion: z.string().max(1000).optional().nullable(),
  imagenUrl:   z.string().max(500).url().optional().nullable().or(z.literal('').transform(() => null)),
  tipo:        z.enum(['Recurrente', 'VentaUnica', 'Servicio']),
  categoria:   z.enum(['WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'Mixto', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV']),
  precio:      z.number().min(0),
  costo:       z.number().min(0).optional().default(0),
  stock:       z.number().int().optional().nullable(),
  productoId:  z.number().int().positive().optional().nullable(),
  activo:      z.boolean().default(true),
})

app.get('/api/catalogo', verificarJWT, async (req, res) => {
  try {
    const { tipo, categoria, activo, search } = req.query
    const where = {}
    if (tipo) where.tipo = tipo
    if (categoria) where.categoria = categoria
    if (activo !== undefined && activo !== '') where.activo = activo === 'true'
    if (search) where.nombre = { contains: search, mode: 'insensitive' }
    // Carga el producto físico si existe — proyecta stockActual/imagen al ItemCatalogo
    // como "single source of truth" para el POS (sin duplicar datos en la BD).
    const items = await prisma.itemCatalogo.findMany({
      where, orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
      include: { producto: { select: { id: true, sku: true, stockActual: true, stockMinimo: true, imagenUrl: true, descripcion: true } } },
    })
    // Resuelve campos efectivos: imagen y stock del Producto físico ganan si están atados.
    const enriched = items.map(it => ({
      ...it,
      imagenUrl: it.imagenUrl ?? it.producto?.imagenUrl ?? null,
      // stock efectivo: si hay producto vinculado, gana el stockActual del inventario real
      stock: it.producto ? it.producto.stockActual : it.stock,
      stockSource: it.producto ? 'inventario' : (it.stock != null ? 'catalogo' : null),
      sku: it.producto?.sku ?? null,
    }))
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos')
    const data = canSeeCosts ? enriched : enriched.map(({ costo, ...rest }) => rest)
    res.json({ data })
  } catch (e) { console.error('[GET /api/catalogo]', e.code, e.message); res.status(500).json({ error: 'Error interno.' }) }
})

app.post('/api/catalogo', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
  try {
    const data = itemCatalogoSchema.parse(req.body)
    const item = await prisma.itemCatalogo.create({ data })
    res.status(201).json(item)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.put('/api/catalogo/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
  try {
    const data = itemCatalogoSchema.parse(req.body)
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos')
    if (!canSeeCosts) {
      const existing = await prisma.itemCatalogo.findUnique({ where: { id: req.params.id }, select: { costo: true } })
      if (existing) data.costo = Number(existing.costo)
    }
    const item = await prisma.itemCatalogo.update({ where: { id: req.params.id }, data })
    res.json(item)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.delete('/api/catalogo/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
  try {
    const count = await prisma.lineaOrdenTrabajo.count({ where: { itemCatalogoId: req.params.id } })
    if (count > 0) return res.status(409).json({ error: 'Item en uso en órdenes. Desactívalo en su lugar.' })
    await prisma.itemCatalogo.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Configuración NCF ────────────────────────────────────────────────────────

const ncfSchema = z.object({
  prefijo:         z.string().min(1).max(3),
  tipoNcf:         z.string().min(1),
  tipoDescripcion: z.string().min(1),
  secuenciaActual: z.number().int().min(0).default(0),
  limite:          z.number().int().min(1).default(9999999),
  vencimiento:     z.string().datetime().optional().nullable(),
  activo:          z.boolean().default(true),
})

app.get('/api/ncf-config', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const configs = await prisma.configuracionNCF.findMany({ orderBy: { tipoNcf: 'asc' } })
    res.json({ data: configs })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.post('/api/ncf-config', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  try {
    const data = ncfSchema.parse(req.body)
    const config = await prisma.configuracionNCF.upsert({
      where:  { tipoNcf: data.tipoNcf },
      create: { ...data, vencimiento: data.vencimiento ? new Date(data.vencimiento) : null },
      update: { ...data, vencimiento: data.vencimiento ? new Date(data.vencimiento) : null },
    })
    res.json(config)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Órdenes de Trabajo ───────────────────────────────────────────────────────

const lineaOTSchema = z.object({
  itemCatalogoId: z.string().uuid().optional().nullable(),
  productoId:     z.number().int().optional().nullable(),
  descripcion:    z.string().min(1).max(200),
  cantidad:       z.number().int().min(1).default(1),
  precioUnitario: z.number().min(0),
})

const ordenTrabajoSchema = z.object({
  clienteId:           z.string().uuid(),
  tecnicoId:           z.number().int().optional().nullable(),
  tipoOT:              z.enum(['ISP', 'CCTV', 'Reparacion', 'CercoElectrico', 'VentaDirecta', 'General', 'Instalacion', 'Mantenimiento']).default('General'),
  estado:              z.string().default('Pendiente'),
  notasTecnicas:       z.string().optional().nullable(),
  metadatos:           z.record(z.unknown()).default({}),
  fotosRequeridas:     z.number().int().min(0).default(0),
  limpiezaRealizada:   z.boolean().default(false),
  fechaVencimientoSLA: z.coerce.date().optional().nullable(),
  garantiaDias:        z.number().int().min(0).optional().nullable(),
  lineas:              z.array(lineaOTSchema).min(1, 'Agrega al menos un item.'),
})

app.get('/api/ordenes', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
  try {
    const { estado, tipoOT, clienteId, tecnicoId, limit = '50', offset = '0' } = req.query
    const where = { deletedAt: null }
    if (estado)    where.estado    = estado
    if (tipoOT)    where.tipoOT    = tipoOT
    if (clienteId) where.clienteId = clienteId
    if (tecnicoId) where.tecnicoId = parseInt(tecnicoId)
    const [total, ordenes] = await prisma.$transaction([
      prisma.ordenTrabajo.count({ where }),
      prisma.ordenTrabajo.findMany({
        where,
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true } },
          tecnico: { select: { id: true, nombre: true } },
          lineas:  { include: { itemCatalogo: { select: { id: true, nombre: true, tipo: true } } } },
          _count:  { select: { facturas: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
    ])
    res.json({ data: ordenes, total })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

const SLA_HORAS_POR_TIPO = { Reparacion: 48, Instalacion: 168, CCTV: 168, Mantenimiento: 72, General: 24, ISP: 72, CercoElectrico: 168, VentaDirecta: 24 }

app.post('/api/ordenes', verificarJWT, billingLimiter, requerirPermiso('ot:crear'), async (req, res) => {
  try {
    const { lineas, ...otData } = ordenTrabajoSchema.parse(req.body)
    if (!otData.fechaVencimientoSLA) {
      const horas = SLA_HORAS_POR_TIPO[otData.tipoOT] ?? 48
      otData.fechaVencimientoSLA = new Date(Date.now() + horas * 3600_000)
    }
    const orden = await prisma.$transaction(async (tx) => {
      const noOT = await nextNomenclatura(tx, 'OT')
      const ot = await tx.ordenTrabajo.create({ data: { ...otData, noOT } })
      await tx.lineaOrdenTrabajo.createMany({
        data: lineas.map(l => ({ ...l, ordenId: ot.id })),
      })
      return tx.ordenTrabajo.findUnique({
        where: { id: ot.id },
        include: {
          cliente: { select: { id: true, razonSocial: true } },
          lineas:  { include: { itemCatalogo: { select: { nombre: true } } } },
        },
      })
    })
    auditReq('ot:crear', req, { ordenId: orden.id, tipoOT: orden.tipoOT, clienteId: orden.clienteId })
    res.status(201).json(orden)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.delete('/api/ordenes/:id', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  try {
    const ot = await prisma.ordenTrabajo.findUnique({ where: { id: req.params.id }, select: { id: true, estaFacturada: true, deletedAt: true } })
    if (!ot || ot.deletedAt)          return res.status(404).json({ error: 'OT no encontrada.' })
    if (ot.estaFacturada)             return res.status(409).json({ error: 'No se puede eliminar una OT ya facturada.' })
    await prisma.ordenTrabajo.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
    auditReq('ot:eliminar', req, { otId: req.params.id })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Facturas ────────────────────────────────────────────────────────────────

app.post('/api/facturas', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  const { ordenId, forzarCredito } = req.body
  if (!ordenId) return res.status(400).json({ error: 'ordenId requerido.' })
  try {
    // ── CONTROL DE CREDITO (pre-transacción para fail rápido) ────────────────
    const otPre = await prisma.ordenTrabajo.findUnique({
      where:   { id: ordenId },
      include: { lineas: true, cliente: { select: { id: true, razonSocial: true, limiteCredito: true } } },
    })
    if (otPre && otPre.cliente && Number(otPre.cliente.limiteCredito) > 0) {
      const totalNueva = otPre.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0) * 1.18
      const deudaActual = await prisma.factura.aggregate({
        _sum:  { total: true },
        where: {
          clienteId:    otPre.cliente.id,
          deletedAt:    null,
          esCotizacion: false,
          estado:       { in: ['Emitida', 'Vencida'] },
        },
      })
      const deuda  = Number(deudaActual._sum.total ?? 0)
      const limite = Number(otPre.cliente.limiteCredito)
      if (deuda + totalNueva > limite) {
        const perms = Array.isArray(req.user?.permisos) ? req.user.permisos : []
        const puedeForzar = perms.includes('ventas:forzar_credito') || perms.includes('sistema:owner')
        if (!puedeForzar || !forzarCredito) {
          auditReq('factura:credito_bloqueado', req, { clienteId: otPre.cliente.id, deuda, limite, intento: totalNueva })
          return res.status(422).json({
            error: `Crédito excedido: ${otPre.cliente.razonSocial} debe RD$${deuda.toFixed(0)} de RD$${limite.toFixed(0)} permitidos. Esta factura suma RD$${totalNueva.toFixed(0)}.`,
            code:  'CREDIT_LIMIT_EXCEEDED',
            puedeForzar,
            detalle: { deudaActual: deuda, limiteCredito: limite, montoIntentado: totalNueva },
          })
        }
        // Owner forzó: auditar el bypass
        auditReq('factura:credito_forzado', req, { clienteId: otPre.cliente.id, deuda, limite, monto: totalNueva })
      }
    }

    const factura = await prisma.$transaction(async (tx) => {
      // 1. OT + líneas + cliente
      const ot = await tx.ordenTrabajo.findUnique({
        where:   { id: ordenId },
        include: { cliente: true, lineas: true, facturas: { select: { id: true } } },
      })
      if (!ot || ot.deletedAt)       throw Object.assign(new Error('Orden no encontrada.'),        { status: 404 })
      if (ot.facturas.length > 0)    throw Object.assign(new Error('Esta orden ya tiene factura.'), { status: 409 })
      if (ot.estado === 'Cancelada') throw Object.assign(new Error('No se puede facturar una OT cancelada.'), { status: 422 })

      // 2. Tipo NCF del cliente
      const tipoNcf = ot.cliente.tipoNcf ?? 'Consumidor Final'

      // 3. UPDATE atómico — acquire exclusive row lock, increment counter
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = ${tipoNcf}
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
          AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
        RETURNING *
      `
      if (!rows || rows.length === 0)
        throw Object.assign(
          new Error(`Sin secuencia NCF disponible para tipo "${tipoNcf}". Verifica la configuración.`),
          { status: 422 }
        )

      // 4. NCF + noFactura (tied to same atomic sequence — guaranteed unique)
      const seq       = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncf       = `${rows[0].prefijo}${seq}`
      const noFactura = `FAC${new Date().getFullYear()}${seq}`

      // 5. Cálculo de totales
      const subtotal = ot.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0)
      const itbis    = ot.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
      const total    = Math.round((subtotal + itbis) * 100) / 100

      // 6. Crear Factura en estado Emitida
      const f = await tx.factura.create({
        data: {
          noFactura,
          clienteId:  ot.clienteId,
          ordenId:    ot.id,
          estado:     'Emitida',
          subtotal,
          itbis,
          total,
          ncf,
          tipoNcf,
          fechaVence: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      })

      // 7. Marcar OT como Completada + estaFacturada
      await tx.ordenTrabajo.update({
        where: { id: ordenId },
        data:  { estado: 'Completada', completadaEn: new Date(), estaFacturada: true },
      })

      return tx.factura.findUnique({
        where:   { id: f.id },
        include: { cliente: { select: { email: true, razonSocial: true } }, orden: { include: { lineas: true } } },
      })
    })

    auditReq('factura:emitir', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total) })
    res.status(201).json(factura)

    // Fire-and-forget PDF email
    setImmediate(async () => {
      try {
        const pdfBuf = await buildFacturaPDFBuffer(factura)
        await sendFacturaPDF(factura, pdfBuf)
      } catch (e) { console.error('[EMAIL FF]', e.message) }
    })
  } catch (e) {
    const status = e.status ?? 500
    const msg    = e.status ? e.message : 'Error al generar la factura.'
    res.status(status).json({ error: msg })
  }
})

// ─── POS / Manual Invoice ─────────────────────────────────────────────────────

const CONSUMIDOR_FINAL_NO = 'CF-0001'

// Generate next sequential code using ConfiguracionNCF (e.g. 'SV-001', 'OT-001', 'COT-001')
async function nextNomenclatura(tx, tipo) {
  const rows = await tx.$queryRaw`
    UPDATE "ConfiguracionNCF"
    SET    "secuenciaActual" = "secuenciaActual" + 1
    WHERE  "tipoNcf" = ${tipo}
    RETURNING "prefijo", "secuenciaActual"
  `
  if (!rows || rows.length === 0) throw new Error(`Contador de nomenclatura "${tipo}" no encontrado.`)
  return `${rows[0].prefijo}${String(rows[0].secuenciaActual).padStart(3, '0')}`
}

// Compute effective unit price after sequential discounts (% first, then fixed)
function efectivoUnitario(pu, pct, monto) {
  const afterPct = pu * (1 - pct / 100)
  return Math.round(Math.max(0, afterPct - monto) * 100) / 100
}
function totalLinea(pu, pct, monto, cant) {
  return Math.round(efectivoUnitario(pu, pct, monto) * cant * 100) / 100
}

function formatCarrito(c) {
  if (!c) return null
  const lineas = (c.lineas ?? []).map(l => {
    const pu  = Number(l.precioUnitario)
    const pct = Number(l.descuentoPorcentaje)
    const mon = Number(l.descuentoMonto)
    const eu  = efectivoUnitario(pu, pct, mon)
    return { ...l, precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, precioEfectivo: eu, subtotalLinea: Math.round(eu * l.cantidad * 100) / 100 }
  })
  const subtotal = Math.round(lineas.reduce((s, l) => s + l.subtotalLinea, 0) * 100) / 100
  const itbisAmt = c.applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  return { ...c, lineas, totales: { subtotal, itbis: itbisAmt, total: Math.round((subtotal + itbisAmt) * 100) / 100 } }
}

const lineaPOSSchema = z.object({
  productoId:          z.number().int().positive(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
})

const facturaManualSchema = z.object({
  clienteId:    z.string().uuid().optional(),
  itbis:        z.boolean().optional().default(true),
  diasVence:    z.number().int().min(0).max(365).optional().default(30),
  esCotizacion: z.boolean().optional().default(false),
  lineas:       z.array(lineaPOSSchema).min(1, 'Se requiere al menos una línea.'),
})

// Shared transaction: used by /api/facturas/manual and /api/carrito/checkout
async function procesarFacturaPOS({ inputClienteId, applyItbis, diasVence, esCotizacion, lineas, tipoNcfOverride, nombreTemporal, descuentoGlobalPct = 0, descuentoGlobalMonto = 0 }) {
  return prisma.$transaction(async (tx) => {
    // 1. Resolve client
    let cliente
    if (inputClienteId) {
      cliente = await tx.cliente.findUnique({ where: { id: inputClienteId } })
      if (!cliente) throw Object.assign(new Error('Cliente no encontrado.'), { status: 404 })
    } else {
      cliente = await tx.cliente.upsert({
        where:  { noCliente: CONSUMIDOR_FINAL_NO },
        update: {},
        create: {
          noCliente: CONSUMIDOR_FINAL_NO, razonSocial: 'Consumidor Final', nombreContacto: 'Consumidor Final',
          tipoCliente: 'Residencial', tipoEmpresa: 'Residencial', telefonoPrincipal: '000-000-0000',
          email: 'consumidor@acr.do', direccion: 'N/A', sector: 'N/A', provincia: 'Santo Domingo',
          itbis: false, tipoNcf: 'Consumidor Final', activo: true,
        },
      })
    }

    // 2. Load products (only lines that have a productoId — description-only lines skip this)
    const productoIds = [...new Set(lineas.map(l => l.productoId).filter(Boolean))]
    const productos = productoIds.length > 0
      ? await tx.producto.findMany({
          where:  { id: { in: productoIds } },
          select: { id: true, nombre: true, sku: true, stockActual: true, precio: true, tipoItem: true },
        })
      : []
    const pMap = Object.fromEntries(productos.map(p => [p.id, p]))
    for (const l of lineas) {
      if (l.productoId && !pMap[l.productoId])
        throw Object.assign(new Error(`Producto ID ${l.productoId} no encontrado.`), { status: 404 })
      if (!l.productoId && !l.descripcion)
        throw Object.assign(new Error('Línea sin productoId requiere campo descripción.'), { status: 400 })
    }

    // 3. Stock check — only ARTICULO items, only for real invoices
    // Performed later via atomic UPDATE to avoid TOCTOU race conditions

    // 4. Build enriched lines + totals (with discounts)
    const lineasEnriquecidas = lineas.map(l => {
      if (l.productoId) {
        const p   = pMap[l.productoId]
        const pu  = l.precioUnitario ?? Number(p.precio)
        const pct = l.descuentoPorcentaje ?? 0
        const mon = l.descuentoMonto ?? 0
        return { productoId: l.productoId, descripcion: l.descripcion ?? p.nombre, cantidad: l.cantidad,
                 precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, _tipoItem: p.tipoItem }
      }
      // Description-only line (POS catalog item — no inventory tracking)
      const pu  = l.precioUnitario ?? 0
      const pct = l.descuentoPorcentaje ?? 0
      const mon = l.descuentoMonto ?? 0
      return { productoId: null, descripcion: l.descripcion, cantidad: l.cantidad,
               precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, _tipoItem: 'SERVICIO' }
    })
    const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100
    const globalDesc    = descuentoGlobalPct > 0
      ? Math.round(subtotalBruto * (descuentoGlobalPct / 100) * 100) / 100
      : Math.min(descuentoGlobalMonto, subtotalBruto)
    const subtotal = Math.round((subtotalBruto - globalDesc) * 100) / 100
    const itbisAmt = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
    const total    = Math.round((subtotal + itbisAmt) * 100) / 100

    let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado

    if (esCotizacion) {
      noFactura = await nextNomenclatura(tx, 'COT')
      estado    = 'Borrador'
    } else {
      // 5. Smart NCF: override > PYME/Empresa → Fiscal (B01); else → Consumidor Final (B02)
      tipoNcf = tipoNcfOverride || (['PYME', 'Empresa'].includes(cliente.tipoEmpresa) ? 'Fiscal' : 'Consumidor Final')
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = ${tipoNcf}
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
          AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
        RETURNING *
      `
      if (!rows || rows.length === 0)
        throw Object.assign(new Error(`Sin secuencia NCF disponible para "${tipoNcf}". Verifica Configuración NCF.`), { status: 422 })
      const seq = String(rows[0].secuenciaActual).padStart(8, '0')
      ncf       = `${rows[0].prefijo}${seq}`
      noFactura = `FAC${new Date().getFullYear()}${seq}`
      estado    = 'Emitida'
    }

    // 6. Snapshot fiscal: foto inmutable de empresa + cliente al momento de emitir.
    // Solo en facturas reales (no cotizaciones). Si la empresa cambia logo/RNC/dirección
    // años después, los PDFs antiguos siguen mostrando el estado original.
    let snapshot = null
    if (!esCotizacion) {
      const empresa = await tx.empresaPerfil.findUnique({ where: { id: 1 } })
      snapshot = {
        emitidoEn: new Date().toISOString(),
        empresa: empresa ? {
          razonSocial:       empresa.razonSocial,
          nombreComercial:   empresa.nombreComercial,
          rnc:               empresa.rnc,
          registroMercantil: empresa.registroMercantil,
          direccion:         empresa.direccion,
          sector:            empresa.sector,
          provincia:         empresa.provincia,
          telefono:          empresa.telefono,
          email:             empresa.email,
          website:           empresa.website,
          eslogan:           empresa.eslogan,
          representanteNombre:   empresa.representanteNombre,
          representanteApellido: empresa.representanteApellido,
          representanteCargo:    empresa.representanteCargo,
          assets:                empresa.assets ?? {},
          condicionesDefault:    empresa.condicionesDefault ?? {},
        } : null,
        cliente: {
          razonSocial: cliente.razonSocial,
          noCliente:   cliente.noCliente,
          rnc:         cliente.rnc,
          cedula:      cliente.cedula,
          direccion:   cliente.direccion,
          sector:      cliente.sector,
          provincia:   cliente.provincia,
          telefono:    cliente.telefonoPrincipal ?? cliente.telefono,
          email:       cliente.email,
          tipoEmpresa: cliente.tipoEmpresa,
        },
      }
    }

    // 7. Create Factura + LineaFactura (nested write)
    const lineaData = lineasEnriquecidas.map(({ _tipoItem, ...rest }) => rest)
    const f = await tx.factura.create({
      data: {
        noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
        ncf, tipoNcf, esCotizacion,
        snapshot,
        notas:      esCotizacion
          ? `Cotización POS — ${lineas.length} línea(s)`
          : nombreTemporal
            ? `[WALK-IN] ${nombreTemporal} | Factura manual POS — ${lineas.length} línea(s)`
            : `Factura manual POS — ${lineas.length} línea(s)`,
        fechaVence: diasVence > 0 ? new Date(Date.now() + diasVence * 86_400_000) : null,
        lineas:     { createMany: { data: lineaData } },
      },
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
        lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true, tipoItem: true } } } },
      },
    })

    // 7. Atomic stock deduction + Kardex (ARTICULO only, real invoices only)
    // Single SQL UPDATE checks and decrements in one step — no race condition
    if (!esCotizacion) {
      const cantPorArticulo = {}
      for (const l of lineasEnriquecidas) {
        if (l._tipoItem !== 'SERVICIO')
          cantPorArticulo[l.productoId] = (cantPorArticulo[l.productoId] || 0) + l.cantidad
      }
      for (const [pid, cant] of Object.entries(cantPorArticulo)) {
        const rows = await tx.$queryRaw`
          UPDATE "Producto"
          SET    "stockActual" = "stockActual" - ${cant}
          WHERE  id = ${Number(pid)} AND "stockActual" >= ${cant}
          RETURNING id, nombre, "stockActual"
        `
        if (!rows || rows.length === 0) {
          const p = pMap[Number(pid)]
          throw Object.assign(new Error(`Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${cant}.`), { status: 400 })
        }
        await tx.movimientoInventario.create({ data: { productoId: Number(pid), tipo: 'Salida', cantidad: cant } })
      }
    }
    return f
  })
}

app.post('/api/facturas/manual', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  try {
    const { clienteId, itbis: applyItbis, diasVence, esCotizacion, lineas } = facturaManualSchema.parse(req.body)
    const factura = await procesarFacturaPOS({ inputClienteId: clienteId, applyItbis, diasVence, esCotizacion, lineas })
    auditReq(esCotizacion ? 'cotizacion:crear' : 'factura:manual', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total), lineas: factura.lineas.length })
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[FACTURA MANUAL]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al generar la factura.' })
  }
})

// ─── POS — Venta directa desde ItemCatalogo ───────────────────────────────────

const lineaPOSCatalogoSchema = z.object({
  itemCatalogoId:      z.string().uuid(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
})

const posVentaSchema = z.object({
  clienteId:           z.string().uuid().optional(),
  nombreTemporal:      z.string().max(120).optional(),
  tipoNcf:             z.string().optional(),
  applyItbis:          z.boolean().optional().default(true),
  diasVence:           z.number().int().min(0).max(365).optional().default(30),
  esCotizacion:        z.boolean().optional().default(false),
  descuentoGlobalPct:  z.number().min(0).max(100).optional().default(0),
  descuentoGlobalMonto:z.number().min(0).optional().default(0),
  lineas:              z.array(lineaPOSCatalogoSchema).min(1),
})

app.post('/api/pos/venta', verificarJWT, billingLimiter, async (req, res) => {
  try {
    const { clienteId: inputClienteId, nombreTemporal, tipoNcf: tipoNcfOverride, applyItbis, diasVence, esCotizacion, descuentoGlobalPct, descuentoGlobalMonto, lineas } = posVentaSchema.parse(req.body)
    const permReq = esCotizacion ? 'pos:cotizar' : 'pos:facturar'
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    if (!permisos.includes('sistema:owner') && !permisos.includes(permReq))
      return res.status(403).json({ error: `Se requiere permiso "${permReq}".` })

    const factura = await prisma.$transaction(async (tx) => {
      // 1. Resolve client
      let cliente
      if (inputClienteId) {
        cliente = await tx.cliente.findUnique({ where: { id: inputClienteId } })
        if (!cliente) throw Object.assign(new Error('Cliente no encontrado.'), { status: 404 })
      } else {
        cliente = await tx.cliente.upsert({
          where:  { noCliente: CONSUMIDOR_FINAL_NO },
          update: {},
          create: {
            noCliente: CONSUMIDOR_FINAL_NO, razonSocial: 'Consumidor Final', nombreContacto: 'Consumidor Final',
            tipoCliente: 'Residencial', tipoEmpresa: 'Residencial', telefonoPrincipal: '000-000-0000',
            email: 'consumidor@acr.do', direccion: 'N/A', sector: 'N/A', provincia: 'Santo Domingo',
            itbis: false, tipoNcf: 'Consumidor Final', activo: true,
          },
        })
      }

      // 2. Load catalog items
      const ids = [...new Set(lineas.map(l => l.itemCatalogoId))]
      const items = await tx.itemCatalogo.findMany({ where: { id: { in: ids } }, select: { id: true, nombre: true, precio: true, tipoItem: true, stock: true } })
      const iMap = Object.fromEntries(items.map(i => [i.id, i]))
      for (const l of lineas) {
        if (!iMap[l.itemCatalogoId]) throw Object.assign(new Error(`Item ${l.itemCatalogoId} no encontrado.`), { status: 404 })
      }

      // 3. Build enriched lines + totals
      const lineasEnriquecidas = lineas.map(l => {
        const item = iMap[l.itemCatalogoId]
        const pu  = l.precioUnitario ?? Number(item.precio)
        const pct = l.descuentoPorcentaje ?? 0
        const mon = l.descuentoMonto ?? 0
        return { descripcion: item.nombre, cantidad: l.cantidad, precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon }
      })
      const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100
      const globalDesc    = descuentoGlobalPct > 0 ? Math.round(subtotalBruto * (descuentoGlobalPct / 100) * 100) / 100 : Math.min(descuentoGlobalMonto, subtotalBruto)
      const subtotal      = Math.round((subtotalBruto - globalDesc) * 100) / 100
      const itbisAmt      = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
      const total         = Math.round((subtotal + itbisAmt) * 100) / 100

      // 4. NCF / noFactura
      let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado
      if (esCotizacion) {
        noFactura = await nextNomenclatura(tx, 'COT')
        estado    = 'Borrador'
      } else {
        tipoNcf = tipoNcfOverride || (['PYME', 'Empresa'].includes(cliente.tipoEmpresa) ? 'Fiscal' : 'Consumidor Final')
        const rows = await tx.$queryRaw`
          UPDATE "ConfiguracionNCF"
          SET    "secuenciaActual" = "secuenciaActual" + 1
          WHERE  "tipoNcf"         = ${tipoNcf}
            AND  "activo"          = true
            AND  "secuenciaActual" < "limite"
            AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
          RETURNING *
        `
        if (!rows || rows.length === 0) throw Object.assign(new Error(`Sin secuencia NCF para "${tipoNcf}". Verifica Config NCF.`), { status: 422 })
        const seq = String(rows[0].secuenciaActual).padStart(8, '0')
        ncf       = `${rows[0].prefijo}${seq}`
        noFactura = `FAC${new Date().getFullYear()}${seq}`
        estado    = 'Emitida'
      }

      // 5. Create Factura (no productoId — catalog items don't deduct stock)
      return tx.factura.create({
        data: {
          noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
          ncf, tipoNcf, esCotizacion,
          notas: esCotizacion
            ? `Cotización POS (catálogo) — ${lineas.length} línea(s)`
            : nombreTemporal
              ? `[WALK-IN] ${nombreTemporal} — ${lineas.length} línea(s)`
              : `Factura POS (catálogo) — ${lineas.length} línea(s)`,
          fechaVence: diasVence > 0 ? new Date(Date.now() + diasVence * 86_400_000) : null,
          lineas: { createMany: { data: lineasEnriquecidas } },
        },
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
          lineas:  true,
        },
      })
    })
    auditReq(esCotizacion ? 'cotizacion:crear' : 'factura:pos_catalogo', req, { facturaId: factura.id, total: Number(factura.total) })
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[POS VENTA]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al procesar venta.' })
  }
})

// ─── Carrito Temporal (POS) ───────────────────────────────────────────────────

const CARRITO_INCLUDE = {
  cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, tipoNcf: true, tipoEmpresa: true } },
  lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true, precio: true, stockActual: true, tipoItem: true } } }, orderBy: { id: 'asc' } },
}

app.get('/api/carrito', verificarJWT, async (req, res) => {
  try {
    let c = await prisma.carritoTemp.findUnique({ where: { empleadoId: req.user.sub }, include: CARRITO_INCLUDE })
    if (!c) c = await prisma.carritoTemp.create({ data: { empleadoId: req.user.sub }, include: CARRITO_INCLUDE })
    res.json(formatCarrito(c))
  } catch { res.status(500).json({ error: 'Error al obtener carrito.' }) }
})

app.patch('/api/carrito', verificarJWT, async (req, res) => {
  const schema = z.object({
    clienteId:  z.string().uuid().nullable().optional(),
    applyItbis: z.boolean().optional(),
    diasVence:  z.number().int().min(0).max(365).optional(),
  })
  try {
    const data = schema.parse(req.body)
    const c = await prisma.carritoTemp.upsert({
      where: { empleadoId: req.user.sub }, update: data,
      create: { empleadoId: req.user.sub, ...data }, include: CARRITO_INCLUDE,
    })
    res.json(formatCarrito(c))
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error al actualizar carrito.' })
  }
})

app.post('/api/carrito/item', verificarJWT, async (req, res) => {
  const schema = z.object({
    productoId:          z.number().int().positive(),
    cantidad:            z.number().int().positive().default(1),
    precioOverride:      z.number().positive().optional(),
    descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
    descuentoMonto:      z.number().min(0).optional().default(0),
  })
  try {
    const { productoId, cantidad, precioOverride, descuentoPorcentaje, descuentoMonto } = schema.parse(req.body)
    const producto = await prisma.producto.findUnique({ where: { id: productoId }, select: { id: true, precio: true, tipoItem: true } })
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado.' })
    const carrito = await prisma.carritoTemp.upsert({ where: { empleadoId: req.user.sub }, update: {}, create: { empleadoId: req.user.sub } })
    const existing = await prisma.lineaCarrito.findFirst({ where: { carritoId: carrito.id, productoId } })
    if (existing) {
      await prisma.lineaCarrito.update({
        where: { id: existing.id },
        data: { cantidad: { increment: cantidad }, ...(precioOverride !== undefined ? { precioUnitario: precioOverride } : {}), descuentoPorcentaje, descuentoMonto },
      })
    } else {
      await prisma.lineaCarrito.create({
        data: { carritoId: carrito.id, productoId, cantidad, precioUnitario: precioOverride ?? Number(producto.precio), descuentoPorcentaje, descuentoMonto },
      })
    }
    const full = await prisma.carritoTemp.findUnique({ where: { id: carrito.id }, include: CARRITO_INCLUDE })
    res.status(201).json(formatCarrito(full))
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    res.status(500).json({ error: 'Error al agregar item.' })
  }
})

app.patch('/api/carrito/item/:lineaId', verificarJWT, async (req, res) => {
  const lineaId = parseInt(req.params.lineaId)
  if (!lineaId) return res.status(400).json({ error: 'ID inválido.' })
  const schema = z.object({
    cantidad:            z.number().int().min(1).optional(),
    precioUnitario:      z.number().positive().optional(),
    descuentoPorcentaje: z.number().min(0).max(100).optional(),
    descuentoMonto:      z.number().min(0).optional(),
  })
  try {
    const data = schema.parse(req.body)
    const linea = await prisma.lineaCarrito.findUnique({ where: { id: lineaId }, include: { carrito: { select: { empleadoId: true } } } })
    if (!linea || linea.carrito.empleadoId !== req.user.sub) return res.status(404).json({ error: 'Línea no encontrada.' })
    await prisma.lineaCarrito.update({ where: { id: lineaId }, data })
    if (data.precioUnitario !== undefined)
      auditReq('pos:precio_override', req, { lineaId, precioAnterior: Number(linea.precioUnitario), precioNuevo: data.precioUnitario })
    const full = await prisma.carritoTemp.findUnique({ where: { empleadoId: req.user.sub }, include: CARRITO_INCLUDE })
    res.json(formatCarrito(full))
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error al actualizar línea.' })
  }
})

app.delete('/api/carrito/item/:lineaId', verificarJWT, async (req, res) => {
  const lineaId = parseInt(req.params.lineaId)
  if (!lineaId) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const linea = await prisma.lineaCarrito.findUnique({ where: { id: lineaId }, include: { carrito: { select: { empleadoId: true } } } })
    if (!linea || linea.carrito.empleadoId !== req.user.sub) return res.status(404).json({ error: 'Línea no encontrada.' })
    await prisma.lineaCarrito.delete({ where: { id: lineaId } })
    const full = await prisma.carritoTemp.findUnique({ where: { empleadoId: req.user.sub }, include: CARRITO_INCLUDE })
    res.json(formatCarrito(full))
  } catch { res.status(500).json({ error: 'Error al eliminar línea.' }) }
})

app.delete('/api/carrito', verificarJWT, async (req, res) => {
  try {
    const c = await prisma.carritoTemp.findUnique({ where: { empleadoId: req.user.sub } })
    if (c) await prisma.lineaCarrito.deleteMany({ where: { carritoId: c.id } })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error al vaciar carrito.' }) }
})

app.post('/api/carrito/checkout', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  const schema = z.object({
    esCotizacion:       z.boolean().optional().default(false),
    tipoNcfOverride:    z.string().optional(),
    nombreTemporal:     z.string().max(100).optional(),
    descuentoGlobalPct: z.number().min(0).max(100).optional().default(0),
    descuentoGlobalMonto: z.number().min(0).optional().default(0),
  })
  try {
    const { esCotizacion, tipoNcfOverride, nombreTemporal, descuentoGlobalPct, descuentoGlobalMonto } = schema.parse(req.body)
    const carrito = await prisma.carritoTemp.findUnique({
      where: { empleadoId: req.user.sub },
      include: { lineas: true },
    })
    if (!carrito || carrito.lineas.length === 0) return res.status(400).json({ error: 'Carrito vacío.' })
    const lineas = carrito.lineas.map(l => ({
      productoId:          l.productoId,
      cantidad:            l.cantidad,
      precioUnitario:      Number(l.precioUnitario),
      descuentoPorcentaje: Number(l.descuentoPorcentaje),
      descuentoMonto:      Number(l.descuentoMonto),
    }))
    const factura = await procesarFacturaPOS({
      inputClienteId: carrito.clienteId ?? undefined,
      applyItbis:     carrito.applyItbis,
      diasVence:      carrito.diasVence,
      esCotizacion,
      lineas,
      tipoNcfOverride,
      nombreTemporal,
      descuentoGlobalPct,
      descuentoGlobalMonto,
    })
    await prisma.lineaCarrito.deleteMany({ where: { carritoId: carrito.id } })
    auditReq(esCotizacion ? 'carrito:cotizacion' : 'carrito:checkout', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total) })
    if (descuentoGlobalPct > 0 || descuentoGlobalMonto > 0) {
      auditReq('pos:descuento_global', req, {
        facturaId: factura.id, noFactura: factura.noFactura,
        descuentoGlobalPct, descuentoGlobalMonto,
        totalFinal: Number(factura.total),
      })
    }
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    console.error('[CHECKOUT]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error en checkout.' })
  }
})

// ─── Cotizaciones ─────────────────────────────────────────────────────────────

app.get('/api/cotizaciones', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const { clienteId, search, clienteCodigo, clienteNombre, desde, hasta, limit = '20', offset = '0' } = req.query
    const where = { esCotizacion: true, deletedAt: null }
    if (clienteId)     where.clienteId = clienteId
    if (search)        where.noFactura = { contains: search, mode: 'insensitive' }

    const clienteAnd = []
    if (clienteCodigo) clienteAnd.push({ noCliente:   { contains: clienteCodigo, mode: 'insensitive' } })
    if (clienteNombre) clienteAnd.push({ razonSocial: { contains: clienteNombre, mode: 'insensitive' } })
    if (clienteAnd.length > 0) where.cliente = { AND: clienteAnd }

    if (desde || hasta) {
      where.fechaEmision = {}
      if (desde) where.fechaEmision.gte = new Date(desde)
      if (hasta) { const h = new Date(hasta); h.setHours(23, 59, 59, 999); where.fechaEmision.lte = h }
    }

    const [total, data] = await prisma.$transaction([
      prisma.factura.count({ where }),
      prisma.factura.findMany({
        where, orderBy: { createdAt: 'desc' }, take: parseInt(limit), skip: parseInt(offset),
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true } },
          lineas:  { select: { id: true, descripcion: true, cantidad: true, precioUnitario: true, descuentoPorcentaje: true, descuentoMonto: true } },
        },
      }),
    ])
    res.json({ data, total })
  } catch (e) {
    console.error('[GET /api/cotizaciones]', e.code, e.message, e.meta)
    res.status(500).json({ error: 'Error interno.', code: e.code ?? 'UNKNOWN' })
  }
})

app.post('/api/cotizaciones/:id/revivir', verificarJWT, requerirPermiso('factura:emitir'), async (req, res) => {
  const schema = z.object({ emitir: z.boolean().optional().default(false) })
  try {
    const { emitir } = schema.parse(req.body)
    const original = await prisma.factura.findUnique({
      where: { id: req.params.id },
      include: { cliente: true, lineas: { include: { producto: { select: { id: true, precio: true, stockActual: true, tipoItem: true } } } } },
    })
    if (!original || !original.esCotizacion) return res.status(404).json({ error: 'Cotización no encontrada.' })

    // Re-check current prices for lines that have a productoId
    const productoIds = original.lineas.map(l => l.productoId).filter(Boolean)
    const prods = productoIds.length > 0
      ? await prisma.producto.findMany({ where: { id: { in: productoIds } }, select: { id: true, nombre: true, precio: true, stockActual: true, tipoItem: true } })
      : []
    const pMap = Object.fromEntries(prods.map(p => [p.id, p]))

    const lineasRevividas = original.lineas.map(l => {
      if (l.productoId) {
        const actual = pMap[l.productoId]
        const precioActual = actual ? Number(actual.precio) : Number(l.precioUnitario)
        return {
          productoId:          l.productoId,
          descripcion:         l.descripcion,
          cantidad:            l.cantidad,
          precioUnitario:      precioActual,
          descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
          descuentoMonto:      Number(l.descuentoMonto ?? 0),
          _meta: {
            descripcion:        l.descripcion,
            precioEnCotizacion: Number(l.precioUnitario),
            precioActual,
            precioActualizado:  actual !== null && precioActual !== Number(l.precioUnitario),
            stockDisponible:    actual?.stockActual ?? null,
            tipoItem:           actual?.tipoItem ?? null,
          },
        }
      }
      // Description-only line (POS catalog cotización — no productoId)
      const storedPrice = Number(l.precioUnitario)
      return {
        productoId:          null,
        descripcion:         l.descripcion,
        cantidad:            l.cantidad,
        precioUnitario:      storedPrice,
        descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
        descuentoMonto:      Number(l.descuentoMonto ?? 0),
        _meta: {
          descripcion:        l.descripcion,
          precioEnCotizacion: storedPrice,
          precioActual:       storedPrice,
          precioActualizado:  false,
          stockDisponible:    null,
          tipoItem:           'SERVICIO',
        },
      }
    })

    const sub = Math.round(lineasRevividas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100
    const itb = Number(original.itbis) > 0 ? Math.round(sub * 0.18 * 100) / 100 : 0

    if (!emitir) {
      return res.json({
        original:          { id: original.id, noFactura: original.noFactura, createdAt: original.createdAt },
        lineas:            lineasRevividas,
        totales:           { subtotal: sub, itbis: itb, total: Math.round((sub + itb) * 100) / 100 },
        hayActualizaciones: lineasRevividas.some(l => l._meta.precioActualizado),
      })
    }

    const lineasParaProcesar = lineasRevividas.map(({ _meta, ...rest }) => rest)
    const nuevaFactura = await procesarFacturaPOS({
      inputClienteId: original.clienteId,
      applyItbis:     Number(original.itbis) > 0,
      diasVence:      original.fechaVence ? Math.max(0, Math.round((new Date(original.fechaVence) - Date.now()) / 86_400_000)) : 30,
      esCotizacion:   false,
      lineas:         lineasParaProcesar,
    })
    auditReq('cotizacion:revivir', req, { originalId: original.id, nuevaId: nuevaFactura.id })
    res.status(201).json({ factura: nuevaFactura, lineas: lineasRevividas })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[COTIZACION REVIVIR]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al revivir la cotización.' })
  }
})

app.get('/api/facturas/:id', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const f = await prisma.factura.findUnique({
      where: { id: req.params.id },
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
        lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true } } } },
        orden:   { select: { id: true, tipoOT: true } },
      },
    })
    if (!f) return res.status(404).json({ error: 'Factura no encontrada.' })
    res.json(f)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/facturas', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const { estado, clienteId, search, clienteCodigo, clienteNombre, desde, hasta, incluirCotizaciones, limit = '50', offset = '0' } = req.query
    const where = { deletedAt: null }
    if (incluirCotizaciones !== 'true') where.esCotizacion = false
    if (estado)    where.estado    = estado
    if (clienteId) where.clienteId = clienteId
    if (search)    where.OR = [
      { noFactura: { contains: search, mode: 'insensitive' } },
      { ncf:       { contains: search, mode: 'insensitive' } },
    ]

    const clienteAnd = []
    if (clienteCodigo) clienteAnd.push({ noCliente:   { contains: clienteCodigo, mode: 'insensitive' } })
    if (clienteNombre) clienteAnd.push({ razonSocial: { contains: clienteNombre, mode: 'insensitive' } })
    if (clienteAnd.length > 0) where.cliente = { AND: clienteAnd }

    if (desde || hasta) {
      where.fechaEmision = {}
      if (desde) where.fechaEmision.gte = new Date(desde)
      if (hasta) { const h = new Date(hasta); h.setHours(23, 59, 59, 999); where.fechaEmision.lte = h }
    }

    const [total, facturas] = await prisma.$transaction([
      prisma.factura.count({ where }),
      prisma.factura.findMany({
        where,
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true } },
          orden:   { select: { id: true, tipoOT: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
    ])
    res.json({ data: facturas, total })
  } catch (e) {
    console.error('[GET /api/facturas]', e.code, e.message, e.meta)
    res.status(500).json({ error: 'Error interno.', code: e.code ?? 'UNKNOWN' })
  }
})

app.patch('/api/facturas/:id/estado', verificarJWT, billingLimiter, requerirPermiso('factura:editar'), async (req, res) => {
  try {
    const { estado } = req.body
    const allowed = ['Pagada', 'Anulada', 'Vencida']
    if (!allowed.includes(estado)) return res.status(400).json({ error: `Estado inválido. Permitidos: ${allowed.join(', ')}.` })

    const existing = await prisma.factura.findUnique({ where: { id: req.params.id } })
    if (!existing)                 return res.status(404).json({ error: 'Factura no encontrada.' })
    if (existing.estado === 'Anulada') return res.status(409).json({ error: 'Factura ya anulada. No se puede modificar.' })
    if (existing.estado === estado) return res.status(409).json({ error: `Factura ya está en estado ${estado}.` })

    const data = { estado, pdfUrl: null } // invalida cache — el badge ESTADO cambia en el PDF
    if (estado === 'Pagada') data.fechaPago = new Date()

    const factura = await prisma.factura.update({ where: { id: req.params.id }, data })
    invalidarPdfCache(factura.id).catch(() => {})
    auditReq('factura:estado', req, { facturaId: factura.id, estado, ncf: factura.ncf })
    if (estado === 'Anulada') auditReq('factura:anulada', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(existing.total) })
    res.json(factura)

    // Fire-and-forget: sync RouterOS Address List for ISP clients (Pagada → activo, Vencida → moroso)
    if ((estado === 'Pagada' || estado === 'Vencida') && factura.ordenId) {
      setImmediate(async () => {
        try {
          const ot = await prisma.ordenTrabajo.findUnique({
            where: { id: factura.ordenId },
            select: { tipoOT: true, metadatos: true },
          })
          const ip = ot?.tipoOT === 'ISP' ? ot.metadatos?.ip : null
          if (ip) await syncMikrotik(ip, estado === 'Pagada' ? 'activo' : 'moroso')
        } catch (e) { console.error('[MIKROTIK FF]', e.message) }
      })
    }
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── PDF Builder (shared por rutas legacy + envío por email) ─────────────────
// Delegación al motor corporativo nuevo (Puppeteer + renderPdfDoc).
// Antes era pdfkit; ahora se unifica para que TODOS los PDFs (legacy + nuevos +
// email automático) salgan con el mismo diseño y datos desde EmpresaPerfil.

async function buildFacturaPDFBuffer(factura) {
  const empresa = await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
  const empresaConAssets = empresa
    ? { ...empresa, assets: await inlineAssets(empresa.assets ?? {}) }
    : { razonSocial: '', rnc: '', assets: {} }
  const c = factura.cliente ?? {}
  // Soporta tanto factura.lineas (POS) como factura.orden.lineas (OT) — coge la primera no vacía.
  const lineasSrc = (factura.lineas?.length ? factura.lineas : factura.orden?.lineas) ?? []
  const items = lineasSrc.map(l => ({
    descripcion:    l.descripcion ?? l.itemCatalogo?.nombre ?? '—',
    detalle:        l.itemCatalogo?.descripcion ?? null,
    sku:            l.producto?.sku ?? null,
    cantidad:       l.cantidad,
    precioUnitario: Number(l.precioUnitario),
  }))
  const html = renderPdfDoc({
    tipo:         factura.esCotizacion ? 'cotizacion' : 'factura',
    numero:       factura.noFactura,
    ncf:          factura.ncf ?? null,
    tipoNcf:      factura.tipoNcf ?? null,
    empresa:      empresaConAssets,
    cliente: {
      razonSocial: c.razonSocial,
      noCliente:   c.noCliente,
      rnc:         c.rnc,
      cedula:      c.cedula,
      direccion:   c.direccion,
      sector:      c.sector,
      provincia:   c.provincia,
      telefono:    c.telefono ?? c.telefonoPrincipal,
      email:       c.email,
    },
    items,
    subtotal:     Number(factura.subtotal),
    itbis:        Number(factura.itbis ?? 0),
    total:        Number(factura.total),
    fechaEmision: factura.fechaEmision,
    fechaVence:   factura.fechaVence,
    estado:       factura.estado,
    notas:        factura.notas,
    condiciones:  mergeCondiciones(empresa, factura),
    verify:       PUBLIC_VERIFY_BASE ? { hash: facturaVerifyHash(factura), url: `${PUBLIC_VERIFY_BASE}/verify/${facturaVerifyHash(factura)}` } : null,
  })
  return generarPdfDocumento(html)
}

// (Ruta /api/facturas/:id/pdf registrada arriba, unificada con renderPdfDoc.)

// ─── Health detallado (requiere HEALTH_TOKEN) ────────────────────────────────
// /api/health (sin auth) está registrado arriba del rate-limiter para Render.

app.get('/api/health/detailed', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '')
  if (process.env.HEALTH_TOKEN && token !== process.env.HEALTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized.' })
  }
  const t0 = Date.now()
  let dbOk = false, dbMs = null
  try { await prisma.$queryRaw`SELECT 1`; dbMs = Date.now() - t0; dbOk = true } catch {}
  const mem = process.memoryUsage()
  const status = dbOk ? 'ok' : 'degraded'
  res.status(dbOk ? 200 : 503).json({
    status,
    timestamp:  new Date().toISOString(),
    uptime:     Math.floor(process.uptime()),
    commit:     process.env.RENDER_GIT_COMMIT ?? 'local',
    node:       process.version,
    env:        process.env.NODE_ENV ?? 'development',
    db:         { ok: dbOk, latencyMs: dbMs },
    redis:      redisClient ? (redisClient.status === 'ready' ? 'connected' : redisClient.status) : 'not configured',
    memory: {
      rss:       Math.round(mem.rss       / 1048576) + 'MB',
      heapUsed:  Math.round(mem.heapUsed  / 1048576) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1048576) + 'MB',
    },
  })
})

// ─── WISP Auto-Biller Cron ────────────────────────────────────────────────────

async function billarOTsISP() {
  const hoy = new Date()
  const diaHoy = hoy.getDate()
  console.log(`[CRON WISP] Iniciando facturación automática para día de corte: ${diaHoy}`)
  let facturadas = 0, errores = 0

  try {
    // Fetch ISP OTs activas cuyo diaCorte en metadatos == hoy
    const ots = await prisma.$queryRaw`
      SELECT ot.id, ot."clienteId", ot.metadatos
      FROM   "OrdenTrabajo" ot
      WHERE  ot."tipoOT" = 'ISP'
        AND  ot."estado"  = 'Activo'
        AND  (
          (ot.metadatos->>'diaCorte')::int = ${diaHoy}
          OR ot."diaCorte" = ${diaHoy}
        )
    `

    for (const ot of ots) {
      try {
        await prisma.$transaction(async (tx) => {
          // Idempotency — no double-bill same OT same day
          const existing = await tx.factura.findFirst({
            where: {
              ordenId:      ot.id,
              fechaEmision: { gte: new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) },
            },
          })
          if (existing) return

          const otFull = await tx.ordenTrabajo.findUnique({
            where:   { id: ot.id },
            include: { cliente: true, lineas: true },
          })
          if (!otFull || !otFull.lineas.length) return

          const tipoNcf = otFull.cliente.tipoNcf ?? 'Consumidor Final'
          const rows = await tx.$queryRaw`
            UPDATE "ConfiguracionNCF"
            SET    "secuenciaActual" = "secuenciaActual" + 1
            WHERE  "tipoNcf"         = ${tipoNcf}
              AND  "activo"          = true
              AND  "secuenciaActual" < "limite"
              AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
            RETURNING *
          `
          if (!rows || rows.length === 0) throw new Error(`Sin NCF disponible para tipo ${tipoNcf}`)

          const seq       = String(rows[0].secuenciaActual).padStart(8, '0')
          const ncf       = `${rows[0].prefijo}${seq}`
          const noFactura = `FAC${hoy.getFullYear()}${seq}`
          const subtotal  = otFull.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0)
          const itbis     = otFull.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
          const total     = Math.round((subtotal + itbis) * 100) / 100

          await tx.factura.create({
            data: {
              noFactura,
              clienteId:  otFull.clienteId,
              ordenId:    otFull.id,
              estado:     'Emitida',
              subtotal,
              itbis,
              total,
              ncf,
              tipoNcf,
              fechaVence: new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000),
            },
          })
        })
        facturadas++
      } catch (err) {
        errores++
        console.error(`[CRON WISP] Error en OT ${ot.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[CRON WISP] Error fatal:', err.message)
  }

  console.log(`[CRON WISP] Completado. Facturadas: ${facturadas}, Errores: ${errores}`)
}

cron.schedule('5 0 * * *', billarOTsISP, { timezone: 'America/Santo_Domingo' })

async function billarMoras() {
  const hoy = new Date()
  console.log(`[CRON MORA] Revisando facturas vencidas al ${hoy.toLocaleDateString('es-DO')}`)
  try {
    // Fetch ISP OT IPs before bulk update so we can sync MikroTik after
    const afectadas = await prisma.factura.findMany({
      where: { estado: 'Emitida', fechaVence: { lt: hoy } },
      select: { id: true, orden: { select: { tipoOT: true, metadatos: true } } },
    })

    const { count } = await prisma.factura.updateMany({
      where: { estado: 'Emitida', fechaVence: { lt: hoy } },
      data:  { estado: 'Vencida' },
    })
    if (count > 0) console.log(`[CRON MORA] ${count} factura(s) marcadas como Vencida.`)

    // Sync MikroTik for each ISP client that just went moroso
    setImmediate(async () => {
      for (const f of afectadas) {
        if (f.orden?.tipoOT === 'ISP') {
          const ip = f.orden.metadatos?.ip
          if (ip) await syncMikrotik(ip, 'moroso').catch(e => console.error('[MIKROTIK MORA]', e.message))
        }
      }
    })
  } catch (err) {
    console.error('[CRON MORA] Error:', err.message)
  }
}

cron.schedule('10 0 * * *', billarMoras, { timezone: 'America/Santo_Domingo' })


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
    { prefijo: 'SV-',  tipoNcf: 'SV',  tipoDescripcion: 'Servicios' },
    { prefijo: 'OT-',  tipoNcf: 'OT',  tipoDescripcion: 'Ordenes de Trabajo' },
    { prefijo: 'COT-', tipoNcf: 'COT', tipoDescripcion: 'Cotizaciones' },
  ]
  for (const c of counters) {
    await prisma.configuracionNCF.upsert({
      where:  { tipoNcf: c.tipoNcf },
      update: {},
      create: { ...c, secuenciaActual: 0, limite: 99999, activo: true },
    })
  }
  console.log('[SEED] Nomenclature counters ready (SV/OT/COT).')
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

async function startServer() {
  try {
    await prisma.$connect();
    console.log('[DB] Prisma connected to Supabase successfully.');
    await ensureSchemaColumns();
    await ensureRowLevelSecurity();
    await seedNomenclaturas();
  } catch (err) {
    console.error('[DB] CRITICAL: Prisma failed to connect to database:', err.message);
    process.exit(1);
  }

  // Warm-up Puppeteer/Chromium en background. Sin await: el servidor empieza
  // a aceptar requests mientras el browser se inicializa. Cold-start primer
  // PDF baja de ~3s a ~150ms si la warm-up termina antes del primer request.
  const { getBrowser } = require('./services/pdf-generator')
  getBrowser()
    .then(() => console.log('[PDF] Chromium warmed up.'))
    .catch(err => console.error('[PDF WARMUP]', err.message))

  // Pre-generate RSA challenges so first login after cold start never fails
  await warmChallengeStore(3)

  app.listen(PORT, () => {
    console.log(`[SERVER] ERP backend running on port ${PORT}`);
    console.log(`[ENV] NODE_ENV=${process.env.NODE_ENV ?? 'development'} | CORS=${[...ALLOWED_ORIGINS].join(', ')}`);
  });
}

startServer();
