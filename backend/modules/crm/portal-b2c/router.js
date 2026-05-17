/**
 * backend/modules/crm/portal-b2c/router.js
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

function createPortalB2cRouter(deps) {
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
    NIVEL_PROPIETARIO_ABSOLUTO, protegerPropietario,
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
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter, portalLoginLimiter,
    uploadLimiter, uploadMulter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) =================================
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
router.get('/portal/auth/csrf', verificarPortalJWT, (req, res) => {
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

router.get('/portal/catalog', async (req, res) => {
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

router.get('/portal/settings', async (req, res) => {
  try {
    const settings = await getOrCreatePortalSettings()
    res.json(settings)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

router.put('/portal/settings', verificarJWT, requerirPermiso('sistema:config'), async (req, res) => {
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

router.post('/portal/auth/register', portalLoginLimiter, async (req, res) => {
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

router.post('/portal/auth/login', portalLoginLimiter, async (req, res) => {
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

router.post('/portal/auth/logout', (req, res) => {
  res.clearCookie('pct')
  res.clearCookie('pct-csrf')
  res.status(204).end()
})

router.get('/portal/auth/me', verificarPortalJWT, async (req, res) => {
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

router.post('/portal/auth/forgot-password', forgotLimiter, async (req, res) => {
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

router.post('/portal/auth/reset-password', async (req, res) => {
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

router.post('/portal/sos', verificarPortalJWT, async (req, res) => {
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

router.post('/portal/cotizacion', verificarPortalJWT, async (req, res) => {
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

    await persistirVerifyHash(factura)
    auditReq('portal:cotizacion', req, { facturaId: factura.id, total, lineas: lineas.length }, { userId: null, userName: req.portalUser.nombre })
    res.status(201).json({ id: factura.id, noFactura: factura.noFactura, total, lineas: factura.lineas.length })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[PORTAL COTIZACION]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.get('/portal/cotizaciones', verificarPortalJWT, async (req, res) => {
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

router.get('/portal/dashboard', verificarPortalJWT, async (req, res) => {
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

router.get('/portal/facturas/:id/pdf', verificarPortalJWT, async (req, res) => {
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


// ─── E-commerce: Checkout + Webhook (Azul gateway prep) ───────────────────────

const checkoutSchema = z.object({
  items: z.array(z.object({
    itemCatalogoId: z.string().uuid(),
    cantidad:       z.number().int().min(1).max(99),
  })).min(1).max(50),
  metodoPago: z.enum(['Tarjeta','Transferencia']).default('Tarjeta'),
})

const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })

router.post('/portal/checkout', checkoutLimiter, verificarPortalJWT, async (req, res) => {
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
    await persistirVerifyHash(factura)
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

router.post('/webhooks/azul', express.raw({ type: '*/*', limit: '50kb' }), async (req, res) => {
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




  return router;
}

module.exports = createPortalB2cRouter;
