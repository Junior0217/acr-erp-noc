require('dotenv').config();
console.log('[RENDER SYNC] Backend API v2.1 started — Prisma Client regenerated');
const util         = require('util');
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

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'none'"],
      scriptSrc:       ["'none'"],
      styleSrc:        ["'none'"],
      imgSrc:          ["'none'"],
      connectSrc:      ["'self'"],
      fontSrc:         ["'none'"],
      objectSrc:       ["'none'"],
      mediaSrc:        ["'none'"],
      frameSrc:        ["'none'"],
      formAction:      ["'self'"],
      frameAncestors:  ["'none'"],
    },
  },
  crossOriginOpenerPolicy:    { policy: 'same-origin' },
  crossOriginResourcePolicy:  { policy: 'cross-origin' },
  crossOriginEmbedderPolicy:  false,
}));
app.use(cookieParser(process.env.COOKIE_SECRET));

const DEV_ORIGINS     = ['http://localhost:5173', 'http://127.0.0.1:5173']
const PROD_ORIGINS    = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean)
const CORS_WILDCARD   = PROD_ORIGINS.includes('*') || PROD_ORIGINS.length === 0  // open if not configured
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
  exposedHeaders:  ['X-CSRF-Token'],
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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  keyGenerator: reqFingerprint,
  store: makeRateLimitStore(),
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
  '/api/portal/settings', '/api/portal/cotizacion', '/api/portal/sos',
])
function csrfMiddleware(req, res, next) {
  const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'
  if (!mutating) return next()
  const p = req.path
  if ([...CSRF_SKIP].some(s => p === s || p.startsWith(s + '/'))) return next()
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
  cedula:              optIdent(20),
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
  cedula:            optIdent(20),
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

function completarLogin(empleado, req, res, rememberMe = false, needs2FASetup = false) {
  const jti       = crypto.randomUUID()
  const ua        = req.headers['user-agent'] || ''
  const ip        = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null
  const ttl       = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000
  const jwtTTL    = rememberMe ? '30d' : '8h'
  const expiresAt = new Date(Date.now() + ttl)
  return prisma.sessionToken.create({ data: { jti, empleadoId: empleado.id, userAgent: ua, expiresAt, ip } }).then(() => {
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

function signPortalToken(cliente) {
  return jwt.sign(
    { sub: cliente.id, email: cliente.email, nombre: cliente.razonSocial, type: 'portal' },
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
  max: 10,
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

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  let dbConnected = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (_) {}
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
  res.cookie('pct', token, {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000,
    ...(isProd ? { partitioned: true } : {}),
  })
}

async function getOrCreatePortalSettings() {
  return prisma.portalSettings.upsert({
    where:  { id: 1 },
    update: {},
    create: { id: 1 },
  })
}

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
    const existing = await prisma.cliente.findFirst({ where: { email } })
    if (existing) {
      if (existing.passwordHash) return res.status(409).json({ error: 'Email ya registrado.' })
      const hash = await bcrypt.hash(password, 12)
      const updated = await prisma.cliente.update({ where: { id: existing.id }, data: { passwordHash: hash } })
      const token = signPortalToken(updated)
      setPortalCookie(res, token)
      auditReq('portal:register', req, { clienteId: updated.id, email }, { userId: null, userName: nombre })
      return res.json({ id: updated.id, nombre: updated.razonSocial, email: updated.email })
    }
    const count = await prisma.cliente.count()
    const noCliente = `PRT-${String(count + 1).padStart(5, '0')}`
    const hash = await bcrypt.hash(password, 12)
    const cliente = await prisma.cliente.create({
      data: {
        noCliente,
        razonSocial:       nombre,
        email,
        passwordHash:      hash,
        tipoEmpresa:       'Persona Física',
        tipoCliente:       'Residencial',
        nombreContacto:    nombre,
        direccion:         'Por completar',
        sector:            'Por completar',
        provincia:         'Distrito Nacional',
        telefonoPrincipal: '000-000-0000',
      },
    })
    const token = signPortalToken(cliente)
    setPortalCookie(res, token)
    auditReq('portal:register', req, { clienteId: cliente.id, email }, { userId: null, userName: nombre })
    res.status(201).json({ id: cliente.id, nombre: cliente.razonSocial, email: cliente.email })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[PORTAL REGISTER]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/auth/login', portalLoginLimiter, async (req, res) => {
  try {
    const { email, password } = portalLoginSchema.parse(req.body)
    let cliente = await prisma.cliente.findFirst({ where: { email } })

    if (!cliente && email === 'demo.empresa@acrtest.do') {
      const hash     = await bcrypt.hash('Demo2026!', 12)
      const count    = await prisma.cliente.count()
      const noCliente = `PRT-${String(count + 1).padStart(4, '0')}`
      cliente = await prisma.cliente.create({
        data: {
          noCliente, razonSocial: 'Corporación Demo S.R.L.',
          email: 'demo.empresa@acrtest.do', passwordHash: hash,
          tipoEmpresa: 'Sociedad de Responsabilidad Limitada', tipoCliente: 'Corporativo',
          nombreContacto: 'Carlos Empresario', apellidoContacto: 'Demo', cargo: 'Gerente de TI',
          telefono: '809-555-1234', telefonoPrincipal: '809-555-1234',
          direccion: 'Av. Winston Churchill #55, Torre Empresarial, Piso 8',
          sector: 'Piantini', provincia: 'Distrito Nacional',
          limiteCredito: 100000, diasCredito: 30, itbis: true,
        },
      })
      console.log('[PORTAL] Auto-seeded demo account:', cliente.id)
    }

    if (!cliente || !cliente.passwordHash) {
      return res.status(401).json({ error: 'Credenciales inválidas.' })
    }
    const valid = await bcrypt.compare(password, cliente.passwordHash)
    if (!valid) {
      auditReq('portal:login_fail', req, { email }, { userId: null })
      return res.status(401).json({ error: 'Credenciales inválidas.' })
    }
    const token = signPortalToken(cliente)
    setPortalCookie(res, token)
    auditReq('portal:login', req, { clienteId: cliente.id, email }, { userId: null, userName: cliente.razonSocial })
    res.json({ id: cliente.id, nombre: cliente.razonSocial, email: cliente.email })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/auth/logout', (req, res) => {
  res.clearCookie('pct')
  res.status(204).end()
})

app.get('/api/portal/auth/me', verificarPortalJWT, async (req, res) => {
  try {
    const cliente = await prisma.cliente.findUnique({
      where:  { id: req.portalUser.sub },
      select: { id: true, razonSocial: true, email: true, noCliente: true, telefonoPrincipal: true, direccion: true, activo: true },
    })
    if (!cliente) { res.clearCookie('pct'); return res.status(401).json({ error: 'Cliente no encontrado.' }) }
    res.json(cliente)
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
    const cliente = await prisma.cliente.findFirst({ where: { email }, select: { id: true, razonSocial: true, passwordHash: true } })
    // Always 200 — no user enumeration
    res.json({ ok: true })
    if (!cliente || !cliente.passwordHash) return
    const token = crypto.randomBytes(32).toString('hex')
    await storeResetToken(token, cliente.id)
    const resetUrl = `${process.env.PORTAL_URL || process.env.CORS_ORIGIN || 'http://localhost:5173'}/portal?reset=${token}`
    console.log(`[PORTAL RESET] ${email} → ${resetUrl}`)
    if (process.env.SMTP_USER) {
      emailTransporter.sendMail({
        from:    `"ACR Networks" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: 'Restablecer contraseña — ACR Networks',
        html: `<p>Hola <strong>${cliente.razonSocial}</strong>,</p>
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
    const clienteId = await consumeResetToken(token)
    if (!clienteId) return res.status(400).json({ error: 'Token inválido o expirado.' })
    const hash = await bcrypt.hash(password, 12)
    await prisma.cliente.update({ where: { id: clienteId }, data: { passwordHash: hash } })
    auditReq('portal:password_reset', req, { clienteId }, { userId: null, userName: null })
    res.json({ ok: true })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

app.post('/api/portal/sos', verificarPortalJWT, async (req, res) => {
  try {
    const { descripcion } = z.object({ descripcion: z.string().max(500).optional() }).parse(req.body)
    const ot = await prisma.ordenTrabajo.create({
      data: {
        clienteId:     req.portalUser.sub,
        tipoOT:        'SoporteTecnico',
        estado:        'Pendiente',
        notasTecnicas: descripcion || 'Solicitud de soporte técnico vía Portal B2C',
        metadatos:     { origen: 'portal_sos' },
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

    const factura = await prisma.factura.create({
      data: {
        noFactura, clienteId: req.portalUser.sub,
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
    const data = await prisma.factura.findMany({
      where:   { clienteId: req.portalUser.sub, esCotizacion: true, deletedAt: null },
      select:  { id: true, noFactura: true, total: true, estado: true, fechaEmision: true, fechaVence: true, notas: true },
      orderBy: { createdAt: 'desc' },
      take:    10,
    })
    res.json({ data })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/portal/dashboard', verificarPortalJWT, async (req, res) => {
  try {
    const [servicios, facturas] = await Promise.all([
      prisma.servicio.findMany({
        where:   { clienteId: req.portalUser.sub },
        include: { plan: { select: { nombre: true, tipo: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.factura.findMany({
        where:   { clienteId: req.portalUser.sub, deletedAt: null, esCotizacion: false },
        select:  { id: true, noFactura: true, total: true, estado: true, fechaEmision: true, fechaVence: true },
        orderBy: { fechaEmision: 'desc' },
        take: 20,
      }),
    ])
    const deudaTotal = facturas
      .filter(f => f.estado === 'Vencida')
      .reduce((s, f) => s + Number(f.total), 0)
    res.json({ servicios, facturas, deudaTotal })
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
    if (factura.clienteId !== req.portalUser.sub) return res.status(403).json({ error: 'Acceso denegado.' })
    const buf = await buildFacturaPDFBuffer(factura)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="factura-${factura.noFactura}.pdf"`)
    res.setHeader('Content-Length', buf.length)
    res.end(buf)
  } catch { if (!res.headersSent) res.status(500).json({ error: 'Error al generar PDF.' }) }
})

// ─── Auth Routes ──────────────────────────────────────────────────────────────

const generateKeyPairAsync = util.promisify(crypto.generateKeyPair);

app.get('/api/auth/challenge', async (req, res) => {
  try {
    const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const cid = crypto.randomUUID();
    challengeStore.set(cid, { privateKey, exp: Date.now() + 120_000 });
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
    const registro = await prisma.asistencia.create({
      data,
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

app.patch('/api/prospectos/:id/convertir', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const prospecto = await prisma.prospecto.findUnique({ where: { id: req.params.id } });
    if (!prospecto) return res.status(404).json({ error: 'Prospecto no encontrado.' });
    if (prospecto.estado === 'Convertido') return res.status(409).json({ error: 'Prospecto ya fue convertido.' });
    const updated = await prisma.prospecto.update({ where: { id: req.params.id }, data: { estado: 'Convertido' } });
    res.json({ prospecto: formatProspecto(updated) });
  } catch (error) {
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
  sku:         z.string().min(1).max(50).transform(stripTags),
  nombre:      z.string().min(2).max(200).transform(stripTags),
  precio:      z.coerce.number().nonnegative(),
  categoriaId: z.number().int().positive(),
  tipoItem:    z.enum(['ARTICULO', 'SERVICIO']).optional(),
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
    const { search, categoriaId, tipoItem, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (categoriaId) { const cid = parseInt(categoriaId); if (cid > 0) where.categoriaId = cid; }
    if (tipoItem && ['ARTICULO', 'SERVICIO'].includes(tipoItem)) where.tipoItem = tipoItem;
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
  descripcion: z.string().optional().nullable(),
  tipo:        z.enum(['Recurrente', 'VentaUnica', 'Servicio']),
  categoria:   z.enum(['WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'Mixto', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV']),
  precio:      z.number().min(0),
  costo:       z.number().min(0).optional().default(0),
  stock:       z.number().int().optional().nullable(),
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
    const items = await prisma.itemCatalogo.findMany({ where, orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }] })
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos')
    const data = canSeeCosts ? items : items.map(({ costo, ...rest }) => rest)
    res.json({ data })
  } catch (e) { console.error('[GET /api/catalogo]', e.message); res.status(500).json({ error: 'Error interno.' }) }
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
  clienteId:     z.string().uuid(),
  tecnicoId:     z.number().int().optional().nullable(),
  tipoOT:        z.enum(['ISP', 'CCTV', 'Reparacion', 'CercoElectrico', 'VentaDirecta', 'General']).default('General'),
  estado:        z.string().default('Pendiente'),
  notasTecnicas: z.string().optional().nullable(),
  metadatos:     z.record(z.unknown()).default({}),
  lineas:        z.array(lineaOTSchema).min(1, 'Agrega al menos un item.'),
})

app.get('/api/ordenes', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
  try {
    const { estado, tipoOT, clienteId, tecnicoId, limit = '50', offset = '0' } = req.query
    const where = {}
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

app.post('/api/ordenes', verificarJWT, billingLimiter, requerirPermiso('ot:crear'), async (req, res) => {
  try {
    const { lineas, ...otData } = ordenTrabajoSchema.parse(req.body)
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

// ─── Facturas ────────────────────────────────────────────────────────────────

app.post('/api/facturas', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  const { ordenId } = req.body
  if (!ordenId) return res.status(400).json({ error: 'ordenId requerido.' })
  try {
    const factura = await prisma.$transaction(async (tx) => {
      // 1. OT + líneas + cliente
      const ot = await tx.ordenTrabajo.findUnique({
        where:   { id: ordenId },
        include: { cliente: true, lineas: true, facturas: { select: { id: true } } },
      })
      if (!ot)                      throw Object.assign(new Error('Orden no encontrada.'),        { status: 404 })
      if (ot.facturas.length > 0)   throw Object.assign(new Error('Esta orden ya tiene factura.'), { status: 409 })
      if (ot.estado === 'Cancelada') throw Object.assign(new Error('No se puede facturar una OT cancelada.'), { status: 422 })

      // 2. Tipo NCF del cliente
      const tipoNcf = ot.cliente.tipoNcf ?? 'B02'

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

    // 2. Load all products in one query
    const productoIds = [...new Set(lineas.map(l => l.productoId))]
    const productos = await tx.producto.findMany({
      where:  { id: { in: productoIds } },
      select: { id: true, nombre: true, sku: true, stockActual: true, precio: true, tipoItem: true },
    })
    const pMap = Object.fromEntries(productos.map(p => [p.id, p]))
    for (const l of lineas) {
      if (!pMap[l.productoId]) throw Object.assign(new Error(`Producto ID ${l.productoId} no encontrado.`), { status: 404 })
    }

    // 3. Stock check — only ARTICULO items, only for real invoices
    if (!esCotizacion) {
      const cantPorArticulo = {}
      for (const l of lineas) {
        if (pMap[l.productoId].tipoItem !== 'SERVICIO')
          cantPorArticulo[l.productoId] = (cantPorArticulo[l.productoId] || 0) + l.cantidad
      }
      for (const [pid, cant] of Object.entries(cantPorArticulo)) {
        const p = pMap[Number(pid)]
        if (p.stockActual < cant)
          throw Object.assign(new Error(`Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${cant}.`), { status: 400 })
      }
    }

    // 4. Build enriched lines + totals (with discounts)
    const lineasEnriquecidas = lineas.map(l => {
      const p   = pMap[l.productoId]
      const pu  = l.precioUnitario ?? Number(p.precio)
      const pct = l.descuentoPorcentaje ?? 0
      const mon = l.descuentoMonto ?? 0
      return { productoId: l.productoId, descripcion: p.nombre, cantidad: l.cantidad,
               precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon,
               _tipoItem: p.tipoItem }
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

    // 6. Create Factura + LineaFactura (nested write)
    const lineaData = lineasEnriquecidas.map(({ _tipoItem, ...rest }) => rest)
    const f = await tx.factura.create({
      data: {
        noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
        ncf, tipoNcf, esCotizacion,
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

    // 7. Deduct stock + Kardex (ARTICULO only, real invoices only)
    if (!esCotizacion) {
      const cantPorArticulo = {}
      for (const l of lineasEnriquecidas) {
        if (l._tipoItem !== 'SERVICIO')
          cantPorArticulo[l.productoId] = (cantPorArticulo[l.productoId] || 0) + l.cantidad
      }
      await Promise.all(
        Object.entries(cantPorArticulo).flatMap(([pid, cant]) => [
          tx.producto.update({ where: { id: Number(pid) }, data: { stockActual: { decrement: cant } } }),
          tx.movimientoInventario.create({ data: { productoId: Number(pid), tipo: 'Salida', cantidad: cant } }),
        ])
      )
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
    const { clienteId, limit = '20', offset = '0' } = req.query
    const where = { esCotizacion: true }
    if (clienteId) where.clienteId = clienteId
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
  } catch { res.status(500).json({ error: 'Error interno.' }) }
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
    if (original.lineas.some(l => !l.productoId))
      return res.status(422).json({ error: 'Cotización contiene líneas sin referencia de producto. Recrea manualmente.' })

    // Re-check current prices
    const productoIds = original.lineas.map(l => l.productoId)
    const prods = await prisma.producto.findMany({ where: { id: { in: productoIds } }, select: { id: true, nombre: true, precio: true, stockActual: true, tipoItem: true } })
    const pMap = Object.fromEntries(prods.map(p => [p.id, p]))

    const lineasRevividas = original.lineas.map(l => {
      const actual = pMap[l.productoId]
      const precioActual = actual ? Number(actual.precio) : Number(l.precioUnitario)
      return {
        productoId:          l.productoId,
        cantidad:            l.cantidad,
        precioUnitario:      precioActual,
        descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
        descuentoMonto:      Number(l.descuentoMonto ?? 0),
        _meta: {
          descripcion:         l.descripcion,
          precioEnCotizacion:  Number(l.precioUnitario),
          precioActual,
          precioActualizado:   actual !== null && precioActual !== Number(l.precioUnitario),
          stockDisponible:     actual?.stockActual ?? null,
          tipoItem:            actual?.tipoItem ?? null,
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
    const { estado, clienteId, limit = '50', offset = '0' } = req.query
    const where = { deletedAt: null }
    if (estado)    where.estado    = estado
    if (clienteId) where.clienteId = clienteId
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
  } catch { res.status(500).json({ error: 'Error interno.' }) }
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

    const data = { estado }
    if (estado === 'Pagada') data.fechaPago = new Date()

    const factura = await prisma.factura.update({ where: { id: req.params.id }, data })
    auditReq('factura:estado', req, { facturaId: factura.id, estado, ncf: factura.ncf })
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

// ─── PDF Builder (shared by route + email) ────────────────────────────────────

async function buildFacturaPDFBuffer(factura) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc    = new PDFDocument({ size: 'A4', margin: 50 })
      const chunks = []
      doc.on('data', c => chunks.push(c))
      doc.on('end',  () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      const fmtMoney = n => `RD$ ${Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`
      const fmtDate  = d => d ? new Date(d).toLocaleDateString('es-DO', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—'
      const W = 495

      // Logo placeholder
      doc.rect(50, 44, 62, 48).fillAndStroke('#1e3a5f', '#0e2744')
      doc.fontSize(17).font('Helvetica-Bold').fillColor('#60a5fa').text('ACR', 52, 53, { width: 58, align: 'center' })
      doc.fontSize(6.5).font('Helvetica').fillColor('#93c5fd').text('NETWORKS', 52, 73, { width: 58, align: 'center' })
      doc.fontSize(5.5).font('Helvetica').fillColor('#64748b').text('& SOLUTIONS', 52, 82, { width: 58, align: 'center' })

      // Header text
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#1e3a5f').text('ACR Networks & Solutions', 124, 46)
      doc.fontSize(8.5).font('Helvetica').fillColor('#555').text('Proveedor WISP · CCTV · Redes · Seguridad Electrónica', 124, 68)
      doc.fontSize(8).font('Helvetica').fillColor('#6b7280').text('Santo Domingo, República Dominicana', 124, 81)

      // NCF box
      doc.roundedRect(370, 45, 175, 40, 5).fillAndStroke('#1e3a5f', '#1e3a5f')
      doc.fontSize(8).font('Helvetica').fillColor('#fff').text('COMPROBANTE FISCAL', 378, 51, { width: 160, align: 'center' })
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#fff').text(factura.ncf ?? 'N/A', 378, 63, { width: 160, align: 'center' })

      doc.moveTo(50, 96).lineTo(545, 96).strokeColor('#1e3a5f').lineWidth(2).stroke()

      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1e3a5f').text('FACTURA', 50, 108)
      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text(`No. Factura: ${factura.noFactura}`, 50, 126)
        .text(`Emisión: ${fmtDate(factura.fechaEmision)}`, 50, 140)
        .text(`Vence: ${fmtDate(factura.fechaVence)}`, 50, 154)
        .text(`Estado: ${factura.estado}`, 50, 168)

      doc.roundedRect(280, 108, 265, 70, 4).fillAndStroke('#f4f7fb', '#dde5ef')
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f').text('CLIENTE', 292, 116)
      doc.font('Helvetica').fillColor('#222')
        .text(factura.cliente?.razonSocial ?? '—', 292, 128, { width: 240 })
        .text(`RNC: ${factura.cliente?.rnc ?? '—'}`, 292, 140)
        .text(factura.cliente?.direccion ?? '', 292, 152, { width: 240 })
        .text(`Tel: ${factura.cliente?.telefonoPrincipal ?? '—'}`, 292, 164)

      // QR DGII
      if (factura.ncf) {
        try {
          const qrUrl = `https://dgii.gov.do/app/verificaNCF?ncf=${factura.ncf}`
          const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 60, margin: 1 })
          const qrBuf = Buffer.from(qrDataUrl.split(',')[1], 'base64')
          doc.image(qrBuf, 490, 108, { width: 55 })
          doc.fontSize(6).font('Helvetica').fillColor('#888').text('Verificar NCF', 490, 166, { width: 55, align: 'center' })
        } catch {}
      }

      const tableTop = 200
      doc.moveTo(50, tableTop).lineTo(545, tableTop).strokeColor('#1e3a5f').lineWidth(1.5).stroke()
      doc.rect(50, tableTop, W, 18).fill('#1e3a5f')
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff')
        .text('#',           55, tableTop + 5, { width: 18 })
        .text('Descripción', 78, tableTop + 5, { width: 230 })
        .text('Cant',       318, tableTop + 5, { width: 40,  align: 'right' })
        .text('P. Unit.',   368, tableTop + 5, { width: 80,  align: 'right' })
        .text('Total',      458, tableTop + 5, { width: 80,  align: 'right' })

      // OT lineas (itemCatalogo-based) take precedence; fallback to direct LineaFactura (POS)
      const otLineas  = factura.orden?.lineas ?? []
      const posLineas = factura.lineas ?? []
      const lineas = otLineas.length > 0 ? otLineas : posLineas
      let y = tableTop + 18
      lineas.forEach((l, i) => {
        const desc  = l.itemCatalogo?.nombre ?? l.descripcion ?? '—'
        const dscPct = Number(l.descuentoPorcentaje ?? 0)
        const dscMon = Number(l.descuentoMonto ?? 0)
        const efectivo = Math.max(0, Number(l.precioUnitario) * (1 - dscPct / 100) - dscMon)
        const total = Math.round(efectivo * l.cantidad * 100) / 100
        if (i % 2 === 0) doc.rect(50, y, W, 16).fill('#f9fafc')
        doc.fontSize(8).font('Helvetica').fillColor('#222')
          .text(String(i + 1),   55,  y + 4, { width: 18 })
          .text(desc,             78,  y + 4, { width: 230 })
          .text(String(l.cantidad), 318, y + 4, { width: 40, align: 'right' })
          .text(fmtMoney(efectivo), 368, y + 4, { width: 80, align: 'right' })
          .text(fmtMoney(total),    458, y + 4, { width: 80, align: 'right' })
        y += 16
      })
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').lineWidth(0.5).stroke()
      y += 10

      const totRow = (label, val, bold = false) => {
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? '#1e3a5f' : '#333')
          .text(label, 360, y, { width: 100, align: 'right' })
          .font('Helvetica-Bold').fillColor(bold ? '#1e3a5f' : '#333')
          .text(val,   468, y, { width: 75,  align: 'right' })
        y += 16
      }
      totRow('Subtotal:', fmtMoney(factura.subtotal))
      totRow('ITBIS (18%):', fmtMoney(factura.itbis))
      doc.moveTo(360, y).lineTo(543, y).strokeColor('#1e3a5f').lineWidth(1).stroke(); y += 6
      totRow('TOTAL:', fmtMoney(factura.total), true)

      doc.moveTo(50, 756).lineTo(545, 756).strokeColor('#1e3a5f').lineWidth(1).stroke()
      doc.rect(50, 757, W, 38).fill('#0f1e2f')
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#60a5fa').text('ACR Networks & Solutions, S.R.L.', 58, 763)
      doc.fontSize(7).font('Helvetica').fillColor('#94a3b8')
        .text('RNC: 1-30-99999-9  ·  Av. Winston Churchill, Torre ACR, Piso 3, Santo Domingo, D.N.', 58, 775, { width: W - 8 })
        .text('Tel: (809) 555-0100  ·  info@acrnetworks.com.do  ·  www.acrnetworks.com.do', 58, 784, { width: W - 8 })
      doc.fontSize(6).font('Helvetica').fillColor('#475569')
        .text('Documento generado electrónicamente · Válido sin firma ni sello', 58, 787, { width: W - 8, align: 'right' })

      doc.end()
    } catch (e) { reject(e) }
  })
}

// ─── PDF Fiscal ───────────────────────────────────────────────────────────────

app.get('/api/facturas/:id/pdf', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const factura = await prisma.factura.findUnique({
      where: { id: req.params.id },
      include: {
        cliente: true,
        lineas:  true,
        orden: { include: { lineas: { include: { itemCatalogo: { select: { nombre: true } } } } } },
      },
    })
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada.' })
    const buf = await buildFacturaPDFBuffer(factura)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="factura-${factura.noFactura}.pdf"`)
    res.setHeader('Content-Length', buf.length)
    res.end(buf)
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar PDF.' })
  }
})

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ ok: true, db: 'up', uptime: Math.floor(process.uptime()) })
  } catch {
    res.status(503).json({ ok: false, db: 'down' })
  }
})

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

          const tipoNcf = otFull.cliente.tipoNcf ?? 'B02'
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

async function startServer() {
  try {
    await prisma.$connect();
    console.log('[DB] Prisma connected to Supabase successfully.');
    await seedNomenclaturas();
  } catch (err) {
    console.error('[DB] CRITICAL: Prisma failed to connect to database:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[SERVER] ERP backend running on port ${PORT}`);
    console.log(`[ENV] NODE_ENV=${process.env.NODE_ENV ?? 'development'} | CORS=${[...ALLOWED_ORIGINS].join(', ')}`);
  });
}

startServer();
