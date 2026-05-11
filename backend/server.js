require('dotenv').config();
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
const prisma = new PrismaClient().$extends({
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

app.use(helmet());
app.use(cookieParser(process.env.COOKIE_SECRET));

const DEV_ORIGINS  = ['http://localhost:5173', 'http://127.0.0.1:5173']
const PROD_ORIGINS = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : []
const ALLOWED_ORIGINS = new Set([...DEV_ORIGINS, ...PROD_ORIGINS])

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    cb(new Error(`CORS: origen no permitido → ${origin}`))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-CSRF-Token'],
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
  message: { error: 'Demasiadas peticiones, intente de nuevo más tarde.' }
});
app.use('/api/', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: reqFingerprint,
  message: { error: 'Demasiados intentos. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
});

const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: reqFingerprint,
  message: { error: 'Demasiados intentos de PIN. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
});

const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  // Authenticated: key by user ID (immune to IP changes). Unauthenticated: fingerprint fallback.
  keyGenerator: (req) => req.user?.sub ? `billing:${req.user.sub}` : reqFingerprint(req),
  message: { error: 'Límite de operaciones de facturación alcanzado. Intente en 1 minuto.' },
});

app.use(express.json({ limit: '50kb' }));

// ─── CSRF Double-Submit Cookie ────────────────────────────────────────────────
const CSRF_SKIP = new Set(['/api/auth/login', '/api/auth/challenge', '/api/auth/2fa/verify', '/api/auth/logout'])
function csrfMiddleware(req, res, next) {
  const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'
  if (!mutating || CSRF_SKIP.has(req.path)) return next()
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
  .regex(/[!@#$%^&*]/, 'Requiere al menos un símbolo especial (!@#$%^&*).');

const empleadoSchema = z.object({
  nombre:   z.string().min(2).max(100),
  cargo:    z.string().max(200).default('Técnico'),
  email:    z.string().email().trim(),
  roleIds:  z.array(z.number().int().positive()).optional().default([]),
  password: passwordSchema,
});

const empleadoUpdateSchema = z.object({
  nombre:   z.string().min(2).max(100).optional(),
  cargo:    z.string().max(200).optional(),
  email:    z.string().email().trim().optional(),
  roleIds:  z.array(z.number().int().positive()).optional(),
  password: passwordSchema.optional(),
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
  try {
    const target = await prisma.empleado.findUnique({
      where: { id: targetId },
      include: { roles: { where: { activo: true }, select: { permisos: true } } },
    });
    if (!target) return next();
    const targetPerms = target.roles.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []);
    if (targetPerms.includes('sistema:owner') && !req.user?.permisos?.includes('sistema:owner')) {
      return res.status(403).json({ error: 'El propietario es inmutable.' });
    }
    next();
  } catch { next(); }
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

function completarLogin(empleado, req, res, rememberMe = false) {
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
    const jwtStr = jwt.sign({ sub: empleado.id, nombre: empleado.nombre, permisos, jti, ua }, process.env.JWT_SECRET, { expiresIn: jwtTTL })
    const token  = wrapJWT(jwtStr)
    const csrf   = crypto.randomBytes(32).toString('hex')
    res.cookie('csrf', csrf, { httpOnly: false, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: ttl })
    res.cookie('token', token, { httpOnly: true, signed: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: ttl })
    return { id: empleado.id, nombre: empleado.nombre, cargo: empleado.cargo, permisos }
  })
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/api/auth/challenge', async (req, res) => {
  try {
    const { publicKey, privateKey } = await new Promise((resolve, reject) =>
      crypto.generateKeyPair('rsa', {
        modulusLength: 2048,
        publicKeyEncoding:  { type: 'spki',  format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }, (err, pub, priv) => err ? reject(err) : resolve({ publicKey: pub, privateKey: priv }))
    );
    const cid = crypto.randomUUID();
    challengeStore.set(cid, { privateKey, exp: Date.now() + 120_000 });
    res.json({ cid, publicKey: Buffer.from(publicKey).toString('base64') });
  } catch { res.status(500).json({ error: 'Error generando challenge.' }); }
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

    // Block login if any active role mandates 2FA but the employee hasn't configured it yet
    const requires2FAByRole = empleado.roles.some(r => r.require2FA)
    if (requires2FAByRole && !empleado.twoFactorEnabled) {
      auditReq('auth:2fa_required_blocked', req, { email }, { userId: empleado.id, userName: empleado.nombre })
      return res.status(403).json({ error: 'Tu rol requiere autenticación de 2 pasos. Por favor, contacta al administrador para configurarlo.' })
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
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorEnabled: true } })
    const permisos = Array.isArray(req.user.permisos) ? req.user.permisos : []
    res.json({ id: req.user.sub, nombre: req.user.nombre, permisos, twoFactorEnabled: emp?.twoFactorEnabled ?? false })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

app.get('/api/auth/permissions', verificarJWT, (req, res) => {
  res.json(PERMISSIONS_MAP);
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
    const secret = decryptTOTP(empleado.twoFactorSecret)
    if (!authenticator.verify({ token: totp, secret })) {
      auditReq('auth:2fa_fail', req, {}, { userId: empleado.id, userName: empleado.nombre })
      return res.status(401).json({ error: 'PIN inválido.' })
    }
    auditReq('auth:login_success', req, { via: '2fa' }, { userId: empleado.id, userName: empleado.nombre })
    const payload = await completarLogin(empleado, req, res, entry.rememberMe ?? false)
    res.json(payload)
  } catch (e) {
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
    const e = await prisma.empleado.create({
      data: { ...data, passwordHash, roles: { connect: roleIds.map(id => ({ id })) } },
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
    const where = {};
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
    const { roleIds, ...data } = empleadoUpdateSchema.parse(req.body);
    const updateData = { ...data };
    if (roleIds !== undefined) updateData.roles = { set: roleIds.map(rid => ({ id: rid })) };
    const e = await prisma.empleado.update({
      where: { id }, data: updateData,
      select: { id: true, nombre: true, cargo: true, email: true, bloqueado: true, creadoEn: true, roles: { select: { id: true, nombre: true } } },
    });
    res.json(e);
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Empleado no encontrado.' });
    if (e.code === 'P2002') return res.status(409).json({ error: 'El email ya está registrado.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.delete('/api/empleados/:id', verificarJWT, protegerPropietario, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    await prisma.empleado.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Empleado no encontrado.' });
    if (e.code === 'P2003') return res.status(409).json({ error: 'No se puede eliminar: el técnico tiene órdenes asignadas.' });
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
    const { search, categoriaId, page = '1', limit = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (categoriaId) { const cid = parseInt(categoriaId); if (cid > 0) where.categoriaId = cid; }
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
  } catch {
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
    const servicio = await prisma.servicio.create({ data, include: { cliente: { select: { id: true, razonSocial: true, noCliente: true, telefonoPrincipal: true } }, plan: { select: { id: true, nombre: true, tipo: true } } } });
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
      const rolesToAssign = await prisma.rol.findMany({ where: { id: { in: roleIds } } })
      for (const rol of rolesToAssign) {
        const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : []
        const escalated = rolPerms.find(p => !callerPerms.has(p))
        if (escalated) return res.status(403).json({ error: `No puedes asignar el rol "${rol.nombre}": contiene permiso "${escalated}" que tú no posees.` })
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
});
const rolUpdateSchema = rolSchema.partial();

app.get('/api/roles', verificarJWT, async (req, res) => {
  try {
    const roles = await prisma.rol.findMany({
      include:  { _count: { select: { empleados: true } } },
      orderBy:  { nombre: 'asc' },
    });
    res.json({ data: roles });
  } catch { res.status(500).json({ error: 'Error al obtener roles.' }); }
});

app.post('/api/roles', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  try {
    const data = rolSchema.parse(req.body);
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
    const data = rolUpdateSchema.parse(req.body);
    const rol  = await prisma.rol.update({ where: { id }, data, include: { _count: { select: { empleados: true } } } });
    auditReq('admin:rol_actualizado', req, { rolId: id });
    res.json(rol);
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Rol no encontrado.' });
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un rol con ese nombre.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

app.delete('/api/roles/:id', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const rol = await prisma.rol.findUnique({ where: { id }, include: { _count: { select: { empleados: true } } } });
    if (!rol) return res.status(404).json({ error: 'Rol no encontrado.' });
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
  } catch { res.status(500).json({ error: 'Error interno.' }) }
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
      const ot = await tx.ordenTrabajo.create({ data: otData })
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

app.get('/api/facturas', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const { estado, clienteId, limit = '50', offset = '0' } = req.query
    const where = {}
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

      // Header
      doc.fontSize(20).font('Helvetica-Bold').fillColor('#1e3a5f').text('ACR Networks & Solutions', 50, 50)
      doc.fontSize(9).font('Helvetica').fillColor('#555').text('Proveedor WISP · CCTV · Redes · Seguridad Electrónica', 50, 74)

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

      const lineas = factura.orden?.lineas ?? []
      let y = tableTop + 18
      lineas.forEach((l, i) => {
        const desc  = l.itemCatalogo?.nombre ?? l.descripcion
        const total = Number(l.precioUnitario) * l.cantidad
        if (i % 2 === 0) doc.rect(50, y, W, 16).fill('#f9fafc')
        doc.fontSize(8).font('Helvetica').fillColor('#222')
          .text(String(i + 1),              55,  y + 4, { width: 18 })
          .text(desc,                        78,  y + 4, { width: 230 })
          .text(String(l.cantidad),          318, y + 4, { width: 40,  align: 'right' })
          .text(fmtMoney(l.precioUnitario),  368, y + 4, { width: 80,  align: 'right' })
          .text(fmtMoney(total),             458, y + 4, { width: 80,  align: 'right' })
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

      doc.moveTo(50, 770).lineTo(545, 770).strokeColor('#1e3a5f').lineWidth(1).stroke()
      doc.fontSize(7).font('Helvetica').fillColor('#888')
        .text('ACR Networks & Solutions · Documento generado electrónicamente · Este documento es válido sin firma ni sello.', 50, 775, { align: 'center', width: W })

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ERP seguro corriendo en el puerto ${PORT}`));
