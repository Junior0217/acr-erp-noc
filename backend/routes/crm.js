/**
 * backend/routes/crm.js
 *
 * CRM router: clientes, suplidores, prospectos. Más rutas (portal, vault,
 * activos, timeline, credenciales, usuarios-portal) seguirán migrándose
 * por fases — por ahora el monolito sigue manejándolas.
 */

const express = require('express');

function makeRateLimitStore() { return undefined; }  // Stub: routers no comparten redisClient; el limiter cae al MemoryStore default.
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

function createCrmRouter(deps) {
  const router = express.Router();
  const jwt    = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const QRCode = require('qrcode');
  const util   = require('util');
  const { authenticator } = require('otplib');
  const { wrapJWT, unwrapJWT, encryptTOTP, decryptTOTP, PORTAL_JWT_SECRET } = require('../shared/jwt-crypto');
  let archiver = null; try { archiver = require('archiver'); } catch {}

  const {
    prisma, auditReq, middlewares = {}, schemas = {}, helpers = {}, limiters = {},
    completarLogin, twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
    generarSiguienteCodigo, generarPdfDeFactura, buildPdfData, subirPdfAlStorage,
    invalidarPdfCache, renderPdfDoc, generarPdfDocumento, persistirVerifyHash,
    facturaVerifyHash, PUBLIC_VERIFY_BASE, emailTransporter, sendFacturaPDF,
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt, signPortalToken, supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, OT_FOTOS_BUCKET,
    KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
    detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
    generarPin, NIVEL_PROPIETARIO_ABSOLUTO, requerirTOTP, protegerPropietario,
    SECUENCIA_DEFAULTS,
  } = deps;

  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, } = middlewares;

  const {
    passwordSchema, empleadoSchema, empleadoUpdateSchema, asistenciaSchema,
    clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema,
    prospectoSchema, prospectoUpdateSchema, prestamoSchema, ticketTallerSchema,
    ticketEstadoSchema, ordenFotoSchema, } = schemas;

  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, getClientIp, nullStr, optIdent, emptyStr, optCedulaRD,
    reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
  } = helpers;

  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter, portalLoginLimiter,
    uploadLimiter, uploadMulter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // ─── Existing handlers ───────────────────────────────────────────
  router.get('/clientes', async (req, res) => {
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
    } catch {
      res.status(500).json({ error: 'Error al obtener clientes' });
    }
  });

  router.post('/clientes', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const { prospectoOrigenId, ...body } = req.body;
      const data = clienteSchema.parse(body);
      const cliente = await prisma.$transaction(async (tx) => {
        if (!data.noCliente) data.noCliente = await generarSiguienteCodigo('cliente', tx);
        const c = await tx.cliente.create({ data });
        if (prospectoOrigenId) {
          if (!validUUID(prospectoOrigenId)) throw Object.assign(new Error('prospectoOrigenId inválido.'), { status: 400 });
          await tx.prospecto.update({ where: { id: prospectoOrigenId }, data: { estado: 'Convertido' } });
        }
        return c;
      });
      res.status(201).json(formatCliente(cliente));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de cliente ya existe.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/clientes/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

  router.delete('/clientes/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const existing = await prisma.cliente.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Cliente no encontrado.' });
      await prisma.cliente.update({
        where: { id: req.params.id },
        data: { activo: false, deletedAt: new Date() },
      });
      auditReq('crm:cliente_eliminado', req, { clienteId: req.params.id });
      res.status(204).end();
    } catch {
      res.status(500).json({ error: 'Error al eliminar cliente.' });
    }
  });

  router.patch('/clientes/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const current = await prisma.cliente.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Cliente no encontrado.' });
      const updated = await prisma.cliente.update({
        where: { id: req.params.id },
        data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
      });
      res.json(formatCliente(updated));
    } catch {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  });

  // ─── Suplidores ───────────────────────────────────────────────────────────
  router.get('/suplidores', async (req, res) => {
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
    } catch {
      res.status(500).json({ error: 'Error al obtener suplidores' });
    }
  });

  router.post('/suplidores', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const data = suplidorSchema.parse(req.body);
      res.status(201).json(formatSuplidor(await prisma.suplidor.create({ data })));
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de suplidor ya existe.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/suplidores/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

  router.patch('/suplidores/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const current = await prisma.suplidor.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Suplidor no encontrado.' });
      const updated = await prisma.suplidor.update({
        where: { id: req.params.id },
        data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
      });
      res.json(formatSuplidor(updated));
    } catch {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  });

  // ─── Prospectos ───────────────────────────────────────────────────────────
  router.get('/prospectos', async (req, res) => {
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
    } catch {
      res.status(500).json({ error: 'Error al obtener prospectos' });
    }
  });

  router.post('/prospectos', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const data = prospectoSchema.parse(req.body);
      res.status(201).json(formatProspecto(await prisma.prospecto.create({ data })));
    } catch {
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/prospectos/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

  router.delete('/prospectos/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      await prisma.prospecto.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Prospecto no encontrado.' });
      res.status(500).json({ error: 'Error al eliminar prospecto' });
    }
  });

  router.patch('/prospectos/:id/convertir', verificarJWT, async (req, res) => {
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

  // ─── Migrated from monolith ──────────────────────────────────────
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

// ─── Usuarios Portal (NOC Admin) ──────────────────────────────────────────────

router.get('/usuarios-portal', verificarJWT, requerirPermiso('crm:ver'), async (req, res) => {
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

router.post('/usuarios-portal/:id/vincular', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
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

module.exports = createCrmRouter;
