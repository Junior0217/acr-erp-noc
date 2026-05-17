/**
 * backend/modules/ventas/cotizaciones/router.js
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

function createCotizacionesRouter(deps) {
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
// ─── Cotizaciones ─────────────────────────────────────────────────────────────

router.get('/cotizaciones', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
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

router.post('/cotizaciones/:id/revivir', verificarJWT, requerirPermiso('factura:emitir'), async (req, res) => {
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
    const _permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const _puedeOverride = _permisos.includes('sistema:owner') || _permisos.includes('pos:override_precio')
    const nuevaFactura = await procesarFacturaPOS({
      inputClienteId: original.clienteId,
      applyItbis:     Number(original.itbis) > 0,
      diasVence:      original.fechaVence ? Math.max(0, Math.round((new Date(original.fechaVence) - Date.now()) / 86_400_000)) : 30,
      esCotizacion:   false,
      lineas:         lineasParaProcesar,
      puedeOverridePrecio: _puedeOverride,
      empleadoId:          req.user?.sub ?? null,
    })
    await persistirVerifyHash(nuevaFactura)
    auditReq('cotizacion:revivir', req, { originalId: original.id, nuevaId: nuevaFactura.id })
    res.status(201).json({ factura: nuevaFactura, lineas: lineasRevividas })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[COTIZACION REVIVIR]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al revivir la cotización.' })
  }
})

router.get('/facturas/:id', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
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

router.get('/facturas', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
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

router.patch('/facturas/:id/estado', verificarJWT, billingLimiter, requerirPermiso('factura:editar'), async (req, res) => {
  try {
    const { estado, totp } = req.body
    const allowed = ['Pagada', 'Anulada', 'Vencida']
    if (!allowed.includes(estado)) return res.status(400).json({ error: `Estado inválido. Permitidos: ${allowed.join(', ')}.` })

    const existing = await prisma.factura.findUnique({ where: { id: req.params.id } })
    if (!existing)                 return res.status(404).json({ error: 'Factura no encontrada.' })
    if (existing.estado === 'Anulada') return res.status(409).json({ error: 'Factura ya anulada. No se puede modificar.' })
    if (existing.estado === estado) return res.status(409).json({ error: `Factura ya está en estado ${estado}.` })

    // H3: ANULACIÓN exige permiso dedicado 'factura:anular' + 2FA para montos altos.
    // El permiso 'factura:editar' (POST pagos, cambios de estado de cobro) NO basta.
    if (estado === 'Anulada') {
      const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
      const puedeAnular = permisos.includes('sistema:owner') || permisos.includes('factura:anular')
      if (!puedeAnular) {
        auditReq('factura:anular_denied_perm', req, { facturaId: existing.id, total: Number(existing.total) })
        return res.status(403).json({ error: 'Anular factura requiere permiso "factura:anular".', code: 'ANULAR_PERMISSION' })
      }
      // 2FA obligatorio si total > umbral configurable (RD$50,000 default)
      const UMBRAL_2FA_ANULACION = Number(process.env.UMBRAL_2FA_ANULACION ?? 50000)
      if (Number(existing.total) > UMBRAL_2FA_ANULACION) {
        const emp = await prisma.empleado.findUnique({
          where: { id: req.user.sub },
          select: { twoFactorEnabled: true, twoFactorSecret: true },
        })
        if (!emp?.twoFactorEnabled || !emp?.twoFactorSecret) {
          return res.status(403).json({
            error: `Anular factura de RD$${Number(existing.total).toFixed(2)} requiere 2FA activo en tu cuenta.`,
            code:  'TWOFA_REQUIRED_ACCOUNT',
          })
        }
        if (!totp || !/^\d{6}$/.test(String(totp))) {
          return res.status(401).json({
            error: 'Anular factura de alto monto requiere PIN 2FA.',
            code:  'TWOFA_PIN_REQUIRED',
          })
        }
        try {
          const secret = decryptTOTP(emp.twoFactorSecret)
          if (!authenticator.verify({ token: String(totp), secret })) {
            auditReq('factura:anular_2fa_fail', req, { facturaId: existing.id, total: Number(existing.total) })
            return res.status(401).json({ error: 'PIN 2FA inválido.', code: 'TWOFA_INVALID' })
          }
        } catch {
          return res.status(500).json({ error: 'Error validando 2FA.' })
        }
        auditReq('factura:anular_2fa_ok', req, { facturaId: existing.id, total: Number(existing.total) })
      }
    }

    const data = { estado, pdfUrl: null } // invalida cache — el badge ESTADO cambia en el PDF
    if (estado === 'Pagada') data.fechaPago = new Date()

    const factura = await prisma.factura.update({ where: { id: req.params.id }, data })
    invalidarPdfCache(factura.id).catch(() => {})
    auditReq('factura:estado', req, { facturaId: factura.id, estado, ncf: factura.ncf })
    if (estado === 'Anulada') {
      auditReq('factura:anulada', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(existing.total) })
      try {
        await prisma.auditCaja.create({ data: {
          tipo: 'anulacion', empleadoId: req.user?.sub ?? null,
          facturaId: factura.id, monto: Number(existing.total),
          detalle: `Anulación · NCF ${factura.ncf ?? '—'} · ${factura.noFactura}`,
          ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
        }})
      } catch {}
    }
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




  return router;
}

module.exports = createCotizacionesRouter;
