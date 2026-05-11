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
const PERMISSIONS_MAP = require('./shared/permissions.map.js');

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

const prisma = new PrismaClient();

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

// Rolling 12-month cleanup (runs daily)
setInterval(async () => {
  try {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12)
    await prisma.auditLog.deleteMany({ where: { creadoEn: { lt: cutoff } } })
  } catch {}
}, 24 * 60 * 60_000)

const app = express();

app.use(helmet());
app.use(cookieParser(process.env.COOKIE_SECRET));

const corsOptions = {
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-CSRF-Token'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Demasiadas peticiones, intente de nuevo más tarde.' }
});
app.use('/api/', limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
});

const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos de PIN. Intente en 15 minutos.' },
  skipSuccessfulRequests: true,
});

app.use(express.json());

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

app.delete('/api/admin/sessions/:jti', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
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
    const where = {};
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
    await prisma.cliente.delete({ where: { id: req.params.id } });
    auditReq('crm:cliente_eliminado', req, { clienteId: req.params.id });
    res.status(204).end();
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Cliente no encontrado.' });
    if (error.code === 'P2003') return res.status(409).json({ error: 'No se puede eliminar: el cliente tiene servicios activos.' });
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

app.get('/api/dashboard', verificarJWT, async (req, res) => {
  try {
    if (dashCache && Date.now() < dashCacheExp) return res.json(dashCache);
    const [
      activos, pendientes, enInstalacion, suspendidos, cancelados,
      ordenesPendientes,
      stockCritico,
      totalClientes, clientesActivos,
      totalTecnicos,
      ingresosMensuales,
    ] = await Promise.all([
      prisma.servicio.count({ where: { estado: 'Activo'         } }),
      prisma.servicio.count({ where: { estado: 'Pendiente'      } }),
      prisma.servicio.count({ where: { estado: 'EnInstalacion'  } }),
      prisma.servicio.count({ where: { estado: 'Suspendido'     } }),
      prisma.servicio.count({ where: { estado: 'Cancelado'      } }),
      prisma.ordenInstalacion.count({ where: { estado: 'Pendiente' } }),
      prisma.producto.findMany({
        where: { stockActual: { lte: 5 } },
        select: { id: true, nombre: true, sku: true, stockActual: true },
        orderBy: { stockActual: 'asc' }, take: 10,
      }),
      prisma.cliente.count(),
      prisma.cliente.count({ where: { activo: true } }),
      prisma.empleado.count(),
      prisma.servicio.aggregate({ where: { estado: 'Activo' }, _sum: { precioMensual: true } }),
    ]);
    dashCache = {
      servicios: { activos, pendientes, enInstalacion, suspendidos, cancelados },
      ordenesPendientes,
      stockCritico,
      ingresosMensualesEstimados: Number(ingresosMensuales._sum.precioMensual ?? 0),
      clientes: { total: totalClientes, activos: clientesActivos },
      tecnicos: totalTecnicos,
    };
    dashCacheExp = Date.now() + 60_000;
    res.json(dashCache);
  } catch {
    res.status(500).json({ error: 'Error al obtener dashboard.' });
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

// ─── Server ───────────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ERP seguro corriendo en el puerto ${PORT}`));
