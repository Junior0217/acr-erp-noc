/**
 * backend/routes/ventas.js
 *
 * Ventas router: facturas, cotizaciones, NCF config, POS, carrito,
 * órdenes de trabajo (OT), órdenes de instalación, taller (RMA), planes,
 * catálogo interno, notas de crédito/débito, bulk PDF.
 */

const express = require('express');

function makeRateLimitStore() { return undefined; }

// ─── Helpers de descripción estructurada (compartidos con productos/items) ──
const stripTags = v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;
const descripcionEstructuradaSchema = require('zod').z.object({
  v:         require('zod').z.literal(1),
  titulo:    require('zod').z.string().min(1).max(200),
  bullets:   require('zod').z.array(require('zod').z.string().min(1).max(200)).max(30).default([]),
  imagenUrl: require('zod').z.string().max(500).nullable().optional(),
});
const descripcionFlexSchema = require('zod').z.union([
  require('zod').z.string().max(2000),
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
  // Stub: routers no comparten redisClient; el limiter cae al MemoryStore default.
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

function createVentasRouter(deps) {
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
    generarPdfDeFactura, buildPdfData, subirPdfAlStorage,
    invalidarPdfCache, renderPdfDoc, generarPdfDocumento, persistirVerifyHash,
    facturaVerifyHash, PUBLIC_VERIFY_BASE, emailTransporter, sendFacturaPDF,
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt,
    supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
    detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
    storeResetToken, consumeResetToken,
    signPortalToken, setPortalCookie, getOrCreatePortalSettings,
    NIVEL_PROPIETARIO_ABSOLUTO, requerirTOTP, protegerPropietario,
    } = deps;

  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTPEstricto, vaultCooldownGuard,
  } = middlewares;

  const {
    passwordSchema, empleadoSchema, empleadoUpdateSchema, asistenciaSchema,
    clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema,
    prospectoSchema, prospectoUpdateSchema, portalRegisterSchema, portalLoginSchema,
    credencialSchema, activoSchema, prestamoSchema, timelineEventoSchema, checkoutSchema,
    azulWebhookSchema,
  } = schemas;

  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, getClientIp, nullStr, optIdent, emptyStr, optCedulaRD,
    reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
  } = helpers;

  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, } = limiters;

  // ─── Existing handlers ───────────────────────────────────────────
  router.get('/_meta/ventas-router', (req, res) => res.json({ ok: true, router: 'ventas', migrated: 0 }));

  // ─── Migrated from monolith ──────────────────────────────────────
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

// ─── Reversión Admin (God Mode) — solo sistema:owner ──────────────────────────
// Permite revertir una factura Pagada/Anulada de vuelta a Borrador en caso de
// error humano. Restaura stock si la factura tenía líneas de Producto físico.
// SIEMPRE registra un AuditCaja tipo factura:revertida con quién, cuándo, motivo.
router.post('/facturas/:id/revertir', verificarJWT, billingLimiter, requerirPermiso('sistema:owner'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const motivo = String(req.body?.motivo ?? '').slice(0, 500)
    if (!motivo || motivo.length < 10) {
      return res.status(400).json({ error: 'Motivo requerido (mínimo 10 caracteres) para reversión.', code: 'MOTIVO_REQUIRED' })
    }
    const existing = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { lineas: { include: { producto: { select: { id: true, tipoItem: true } } } } },
    })
    if (!existing) return res.status(404).json({ error: 'Factura no encontrada.' })
    if (!['Pagada', 'Anulada'].includes(existing.estado)) {
      return res.status(409).json({ error: `No se puede revertir factura en estado ${existing.estado}.` })
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // Si la factura estaba Pagada, restauramos stock de líneas físicas (la salida
      // había ocurrido al emitir). Si estaba Anulada, NO restauramos (el stock ya
      // volvió cuando se anuló, o nunca se descontó si la factura no llegó a Pagada).
      let stockRestaurado = 0
      if (existing.estado === 'Pagada') {
        for (const l of existing.lineas) {
          if (l.productoId && l.producto?.tipoItem !== 'SERVICIO' && Number(l.cantidad) > 0) {
            await tx.producto.update({
              where: { id: l.productoId },
              data:  { stockActual: { increment: l.cantidad } },
            })
            await tx.movimientoInventario.create({
              data: { productoId: l.productoId, tipo: 'Entrada', cantidad: l.cantidad },
            })
            stockRestaurado++
          }
        }
      }
      const updated = await tx.factura.update({
        where: { id: existing.id },
        data:  { estado: 'Borrador', fechaPago: null, pdfUrl: null, pdfInvalidatedAt: new Date() },
      })
      return { updated, stockRestaurado }
    })

    auditReq('factura:revertida_god_mode', req, { facturaId: existing.id, estadoAnterior: existing.estado, motivo, stockRestaurado: resultado.stockRestaurado })
    // Append-only audit con hash chain — la reversión es operación crítica que
    // exige trazabilidad inmutable verificable post-facto.
    await appendAuditCaja({
      tipo:       'factura_revertida',
      empleadoId: req.user?.sub ?? null,
      facturaId:  existing.id,
      monto:      Number(existing.total),
      detalle:    `God Mode: ${existing.estado} → Borrador. Stock restaurado: ${resultado.stockRestaurado}. Motivo: ${motivo}`,
      ip:         req.ip,
      ua:         (req.headers['user-agent'] ?? '').slice(0, 200),
    }).catch(() => {})
    res.json({ ok: true, factura: resultado.updated, stockRestaurado: resultado.stockRestaurado })
  } catch (e) {
    console.error('[FACTURA REVERTIR]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Notas de Crédito (DGII B04) ──────────────────────────────────────────────
// Emite una Nota de Crédito que ANULA por completo una factura origen y revierte
// su impacto (stock + estado). El documento resultante es una Factura con:
//   - esNotaCredito = true
//   - facturaOrigenId apuntando a la factura modificada
//   - ncf  = secuencia DGII B04 (auto-upsert si la fila ConfiguracionNCF no existe)
//   - noFactura = secuencia interna 'NC-000001' vía generarSiguienteCodigo('notaCredito')
//   - subtotal/itbis/total como NEGATIVOS conceptuales (almacenamos positivos pero
//     el PDF imprime "Nota de Crédito" y la factura origen queda Anulada).
//
// Autorización:
//   - Permiso 'factura:anular' o 'sistema:owner'.
//   - pinSupervisor (EmpresaPerfil.pinSupervisor) obligatorio en body.
//   - motivo mínimo 10 caracteres (queda en motivoNotaModificatoria + AuditCaja).
//
// El stock se RESTAURA solo si la factura origen estaba en 'Pagada' (mismo
// criterio que /revertir): si estaba Emitida, el stock nunca salió.
const notaCreditoSchema = z.object({
  motivo:        z.string().min(10, 'Motivo de mínimo 10 caracteres.').max(500),
  pinSupervisor: z.string().min(4).max(8).regex(/^\d+$/, 'PIN solo dígitos.'),
})

router.post('/facturas/:id/nota-credito', verificarJWT, billingLimiter, async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const puedeAnular = permisos.includes('sistema:owner') || permisos.includes('factura:anular')
    if (!puedeAnular) {
      auditReq('nc:denied_perm', req, { facturaId: req.params.id })
      return res.status(403).json({ error: 'Emitir Nota de Crédito requiere permiso "factura:anular".', code: 'NC_PERMISSION' })
    }

    const parsed = notaCreditoSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos.' })
    }
    const { motivo, pinSupervisor } = parsed.data

    const empCfg = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } })
    const pinReal = empCfg?.pinSupervisor ?? '1234'
    if (pinSupervisor !== pinReal) {
      auditReq('nc:pin_fail', req, { facturaId: req.params.id })
      return res.status(401).json({ error: 'PIN de supervisor inválido.', code: 'NC_PIN_INVALID' })
    }

    const origen = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { lineas: { include: { producto: { select: { id: true, tipoItem: true } } } } },
    })
    if (!origen)                         return res.status(404).json({ error: 'Factura origen no encontrada.' })
    if (origen.esCotizacion)             return res.status(409).json({ error: 'No se puede emitir NC sobre una cotización.' })
    if (origen.esNotaCredito)            return res.status(409).json({ error: 'No se puede emitir NC sobre otra Nota de Crédito.' })
    if (origen.esNotaDebito)             return res.status(409).json({ error: 'No se puede emitir NC sobre una Nota de Débito (emite NC contra la factura original).' })
    if (origen.estado === 'Anulada')     return res.status(409).json({ error: 'La factura origen ya está Anulada.' })
    if (origen.estado === 'Borrador')    return res.status(409).json({ error: 'La factura origen aún está en Borrador, no requiere NC.' })

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Secuencia NCF B04 — atomic upsert + increment.
      //    Si la fila no existe, la creamos con prefijo B04 / límite 99,999,999.
      await tx.$executeRaw`
        INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
        VALUES ('B04', 'Nota de Crédito', 'Notas de Crédito (DGII B04)', 0, 99999999, true, NOW(), NOW())
        ON CONFLICT ("tipoNcf") DO NOTHING
      `
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = 'Nota de Crédito'
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
        RETURNING *
      `
      if (!rows || rows.length === 0) {
        throw Object.assign(new Error('Secuencia NCF B04 agotada o inactiva. Revisa Configuración > Secuencias NCF.'), { status: 422 })
      }
      const seq        = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncfNC      = `${rows[0].prefijo}${seq}`
      const noFacturaNC = await generarSiguienteCodigo('notaCredito', tx)

      // 2. Restaurar stock SOLO si la origen estaba Pagada (la salida había ocurrido).
      let stockRestaurado = 0
      if (origen.estado === 'Pagada') {
        for (const l of origen.lineas) {
          if (l.productoId && l.producto?.tipoItem !== 'SERVICIO' && Number(l.cantidad) > 0) {
            await tx.producto.update({ where: { id: l.productoId }, data: { stockActual: { increment: l.cantidad } } })
            await tx.movimientoInventario.create({ data: { productoId: l.productoId, tipo: 'Entrada', cantidad: l.cantidad } })
            stockRestaurado++
          }
        }
      }

      // 3. Crear la Nota de Crédito como Factura(esNotaCredito=true).
      //    Copia las mismas líneas de la origen (totales idénticos en magnitud).
      //    El estado inicial es 'Emitida' — no requiere flujo de cobro.
      const nc = await tx.factura.create({
        data: {
          noFactura:         noFacturaNC,
          clienteId:         origen.clienteId,
          ordenId:           origen.ordenId,
          empleadoId:        req.user?.sub ?? null,
          estado:            'Emitida',
          subtotal:          origen.subtotal,
          itbis:             origen.itbis,
          total:             origen.total,
          ncf:               ncfNC,
          tipoNcf:           'Nota de Crédito',
          fechaEmision:      new Date(),
          fechaVence:        null,
          esNotaCredito:           true,
          facturaOrigenId:         origen.id,
          motivoNotaModificatoria: motivo,
          notas:                   `Anula a ${origen.noFactura}${origen.ncf ? ` (NCF ${origen.ncf})` : ''}. Motivo: ${motivo}`,
          lineas: {
            create: origen.lineas.map(l => ({
              productoId:          l.productoId ?? null,
              descripcion:         l.descripcion,
              cantidad:            l.cantidad,
              precioUnitario:      l.precioUnitario,
              descuentoPorcentaje: l.descuentoPorcentaje,
              descuentoMonto:      l.descuentoMonto,
            })),
          },
        },
      })

      // 4. Anular la factura origen + invalidar cache PDF.
      const origenAnulada = await tx.factura.update({
        where: { id: origen.id },
        data:  { estado: 'Anulada', pdfUrl: null, pdfInvalidatedAt: new Date() },
      })

      return { nc, origenAnulada, stockRestaurado }
    })

    invalidarPdfCache(resultado.nc.id).catch(() => {})
    invalidarPdfCache(resultado.origenAnulada.id).catch(() => {})

    auditReq('nc:emitida', req, {
      ncId:          resultado.nc.id,
      ncfNC:         resultado.nc.ncf,
      origenId:      origen.id,
      ncfOrigen:     origen.ncf,
      total:         Number(origen.total),
      stockRestaurado: resultado.stockRestaurado,
      motivo,
    })
    await appendAuditCaja({
      tipo:       'nota_credito_emitida',
      empleadoId: req.user?.sub ?? null,
      facturaId:  resultado.nc.id,
      monto:      Number(origen.total),
      detalle:    `NC ${resultado.nc.ncf} anula a ${origen.noFactura} (NCF ${origen.ncf ?? '—'}). Stock restaurado: ${resultado.stockRestaurado}. Motivo: ${motivo}`,
      ip:         req.ip,
      ua:         (req.headers['user-agent'] ?? '').slice(0, 200),
    }).catch(() => {})

    res.status(201).json({
      ok: true,
      notaCredito: resultado.nc,
      origen:      resultado.origenAnulada,
      stockRestaurado: resultado.stockRestaurado,
    })
  } catch (e) {
    console.error('[NC EMITIR]', e.status ?? 500, e.message)
    res.status(e.status ?? 500).json({ error: e.message ?? 'Error interno emitiendo Nota de Crédito.' })
  }
})

// ─── Notas de Débito (DGII B03) ──────────────────────────────────────────────
// Emite una Nota de Débito que AÑADE un cargo adicional contra una factura
// origen (penalidad, interés por mora, ajuste de precio al alza). A diferencia
// de la NC:
//   - NO restaura inventario (no hubo devolución física de mercancía).
//   - NO anula la factura origen — solo la vincula vía facturaOrigenId.
//   - El monto a cobrar es INPUT del usuario (no copia los totales del origen).
//   - Una sola línea descriptiva con el motivo + monto.
//
// El estado inicial es 'Emitida' — el cliente debe pagarla como un cargo extra.
const notaDebitoSchema = z.object({
  motivo:        z.string().min(10, 'Motivo de mínimo 10 caracteres.').max(500),
  pinSupervisor: z.string().min(4).max(8).regex(/^\d+$/, 'PIN solo dígitos.'),
  monto:         z.number().positive('El monto debe ser positivo.').max(99999999),
  aplicarItbis:  z.boolean().optional().default(false),
})

router.post('/facturas/:id/nota-debito', verificarJWT, billingLimiter, async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    // Usa el mismo permiso 'factura:anular' (umbral correcto para emitir
    // comprobantes modificatorios fiscales). Si quieres separarlo a futuro,
    // crea 'factura:nota_debito'.
    const puede = permisos.includes('sistema:owner') || permisos.includes('factura:anular')
    if (!puede) {
      auditReq('nd:denied_perm', req, { facturaId: req.params.id })
      return res.status(403).json({ error: 'Emitir Nota de Débito requiere permiso "factura:anular".', code: 'ND_PERMISSION' })
    }

    const parsed = notaDebitoSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos.' })
    }
    const { motivo, pinSupervisor, monto, aplicarItbis } = parsed.data

    const empCfg = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } })
    const pinReal = empCfg?.pinSupervisor ?? '1234'
    if (pinSupervisor !== pinReal) {
      auditReq('nd:pin_fail', req, { facturaId: req.params.id })
      return res.status(401).json({ error: 'PIN de supervisor inválido.', code: 'ND_PIN_INVALID' })
    }

    const origen = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      select:  { id: true, noFactura: true, ncf: true, clienteId: true, ordenId: true, estado: true, esCotizacion: true, esNotaCredito: true, esNotaDebito: true },
    })
    if (!origen)                      return res.status(404).json({ error: 'Factura origen no encontrada.' })
    if (origen.esCotizacion)          return res.status(409).json({ error: 'No se puede emitir ND sobre una cotización.' })
    if (origen.esNotaCredito)         return res.status(409).json({ error: 'No se puede emitir ND sobre una Nota de Crédito.' })
    if (origen.esNotaDebito)          return res.status(409).json({ error: 'No se puede emitir ND sobre otra Nota de Débito.' })
    if (origen.estado === 'Anulada')  return res.status(409).json({ error: 'La factura origen está Anulada, no admite ajustes.' })
    if (origen.estado === 'Borrador') return res.status(409).json({ error: 'La factura origen aún está en Borrador, no requiere ND.' })

    // Totales del ND: subtotal = monto neto, itbis 18% opcional, total = subtotal + itbis.
    const subtotal = Math.round(Number(monto) * 100) / 100
    const itbis    = aplicarItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
    const total    = Math.round((subtotal + itbis) * 100) / 100

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Secuencia NCF B03 — atomic upsert + increment.
      await tx.$executeRaw`
        INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
        VALUES ('B03', 'Nota de Débito', 'Notas de Débito (DGII B03)', 0, 99999999, true, NOW(), NOW())
        ON CONFLICT ("tipoNcf") DO NOTHING
      `
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = 'Nota de Débito'
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
        RETURNING *
      `
      if (!rows || rows.length === 0) {
        throw Object.assign(new Error('Secuencia NCF B03 agotada o inactiva. Revisa Configuración > Secuencias NCF.'), { status: 422 })
      }
      const seq         = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncfND       = `${rows[0].prefijo}${seq}`
      const noFacturaND = await generarSiguienteCodigo('notaDebito', tx)

      // 2. Crear la Nota de Débito como Factura(esNotaDebito=true) con UNA línea
      //    descriptiva del cargo. NO toca inventario ni anula la factura origen.
      const nd = await tx.factura.create({
        data: {
          noFactura:               noFacturaND,
          clienteId:               origen.clienteId,
          ordenId:                 origen.ordenId,
          empleadoId:              req.user?.sub ?? null,
          estado:                  'Emitida',
          subtotal,
          itbis,
          total,
          ncf:                     ncfND,
          tipoNcf:                 'Nota de Débito',
          fechaEmision:            new Date(),
          fechaVence:              new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          esNotaDebito:            true,
          facturaOrigenId:         origen.id,
          motivoNotaModificatoria: motivo,
          notas:                   `Cargo adicional contra ${origen.noFactura}${origen.ncf ? ` (NCF ${origen.ncf})` : ''}. Motivo: ${motivo}`,
          lineas: {
            create: [{
              descripcion:    `Ajuste / Cargo adicional · ${motivo}`,
              cantidad:       1,
              precioUnitario: subtotal,
            }],
          },
        },
      })

      return { nd, stockRestaurado: 0 }
    })

    invalidarPdfCache(resultado.nd.id).catch(() => {})

    auditReq('nd:emitida', req, {
      ndId:      resultado.nd.id,
      ncfND:     resultado.nd.ncf,
      origenId:  origen.id,
      ncfOrigen: origen.ncf,
      monto:     total,
      motivo,
    })
    await appendAuditCaja({
      tipo:       'nota_debito_emitida',
      empleadoId: req.user?.sub ?? null,
      facturaId:  resultado.nd.id,
      monto:      total,
      detalle:    `ND ${resultado.nd.ncf} carga RD$${total.toFixed(2)} contra ${origen.noFactura} (NCF ${origen.ncf ?? '—'}). Motivo: ${motivo}`,
      ip:         req.ip,
      ua:         (req.headers['user-agent'] ?? '').slice(0, 200),
    }).catch(() => {})

    res.status(201).json({ ok: true, notaDebito: resultado.nd })
  } catch (e) {
    console.error('[ND EMITIR]', e.status ?? 500, e.message)
    res.status(e.status ?? 500).json({ error: e.message ?? 'Error interno emitiendo Nota de Débito.' })
  }
})

// ─── Audit hash chain helpers + verify endpoint ──────────────────────────────
// Cada INSERT a AuditCaja debería pasar por appendAuditCaja() para mantener
// la cadena. El secret rotable AUDIT_SECRET protege contra reescritura post-facto.
const AUDIT_SECRET = process.env.AUDIT_SECRET ?? process.env.JWT_SECRET ?? 'change-me-audit-secret'

function _canonicalizar(row) {
  const safe = {
    tipo: row.tipo ?? '',
    empleadoId: row.empleadoId ?? null,
    facturaId: row.facturaId ?? null,
    monto: row.monto != null ? String(row.monto) : null,
    descPct: row.descPct != null ? String(row.descPct) : null,
    detalle: row.detalle ?? '',
    ip: row.ip ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  }
  return JSON.stringify(safe, Object.keys(safe).sort())
}

async function appendAuditCaja(data) {
  // Lee el último hash conocido para encadenar.
  const last = await prisma.auditCaja.findFirst({
    where:   { hash: { not: null } },
    orderBy: { id: 'desc' },
    select:  { hash: true },
  })
  const prevHash = last?.hash ?? 'GENESIS'
  const payload  = _canonicalizar({ ...data, createdAt: data.createdAt ?? new Date() })
  const hash     = crypto.createHmac('sha256', AUDIT_SECRET).update(payload + '|' + prevHash).digest('hex')
  return prisma.auditCaja.create({ data: { ...data, prevHash, hash } })
}

// Endpoint verificación integridad: recorre las últimas N filas, recalcula hash
// y reporta cualquier inconsistencia. Solo owner. Coste O(N) — usa take limitado.
router.get('/auditoria/caja/verify', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10), 5000)
    const rows = await prisma.auditCaja.findMany({
      orderBy: { id: 'asc' },
      take:    limit,
    })
    let prev = 'GENESIS'
    let roto = null
    for (const r of rows) {
      if (!r.hash) continue   // filas legacy pre-chain
      const expected = crypto.createHmac('sha256', AUDIT_SECRET).update(_canonicalizar(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex')
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }
        break
      }
      prev = r.hash
    }
    res.json({ ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto })
  } catch (e) {
    console.error('[AUDIT VERIFY]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Verifica integridad de AuditLog (mismo principio que AuditCaja). Filas legacy
// pre-chain (hash=null) se omiten. Coste O(N) — se acota con limit.
router.get('/auditoria/log/verify', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10), 5000)
    const rows = await prisma.auditLog.findMany({
      orderBy: { id: 'asc' },
      take:    limit,
    })
    let prev = 'GENESIS'
    let roto = null
    for (const r of rows) {
      if (!r.hash) continue
      const expected = crypto.createHmac('sha256', AUDIT_SECRET).update(_canonicalizarLog(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex')
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }
        break
      }
      prev = r.hash
    }
    res.json({ ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto })
  } catch (e) {
    console.error('[AUDIT LOG VERIFY]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
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
  // Hash computado UNA sola vez; mismo valor para QR + texto verify.
  const legacyHash      = facturaVerifyHash(factura, 'pdf-legacy')
  const legacyVerifyUrl = `${PUBLIC_VERIFY_BASE}/verify/${legacyHash}`
  // Soporta tanto factura.lineas (POS) como factura.orden.lineas (OT) — coge la primera no vacía.
  const lineasSrc = (factura.lineas?.length ? factura.lineas : factura.orden?.lineas) ?? []
  const items = lineasSrc.map(l => ({
    codigo:         l.producto?.sku ?? l.itemCatalogo?.sku ?? (l.producto?.id ? `ART-${String(l.producto.id).padStart(3, '0')}` : null),
    descripcion:    l.descripcion ?? l.itemCatalogo?.nombre ?? '—',
    detalle:        l.itemCatalogo?.descripcion ?? null,
    sku:            l.producto?.sku ?? null,
    cantidad:       l.cantidad,
    precioUnitario: Number(l.precioUnitario),
  }))
  const html = renderPdfDoc({
    tipo:         factura.esCotizacion ? 'cotizacion'
                  : factura.esNotaCredito ? 'nota-credito'
                  : factura.esNotaDebito  ? 'nota-debito'
                  : 'factura',
    numero:       factura.noFactura,
    ncf:          factura.ncf ?? null,
    tipoNcf:      factura.tipoNcf ?? null,
    empresa:      empresaConAssets,
    cliente: {
      razonSocial: c.razonSocial,
      noCliente:   c.noCliente,
      rnc:         c.rnc,
      contacto:    c.nombreContacto ?? c.contacto ?? null,
      cedula:      c.cedula,
      direccion:   c.direccion,
      sector:      c.sector,
      provincia:   c.provincia,
      telefono:    c.telefono ?? c.telefonoPrincipal ?? c.telefonoContacto ?? null,
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
    esNotaCredito:           !!factura.esNotaCredito,
    esNotaDebito:            !!factura.esNotaDebito,
    facturaOrigen:           factura.facturaOrigen
      ? { noFactura: factura.facturaOrigen.noFactura, ncf: factura.facturaOrigen.ncf, tipoNcf: factura.facturaOrigen.tipoNcf }
      : null,
    motivoNotaModificatoria: factura.motivoNotaModificatoria ?? null,
    verify:       { hash: legacyHash, url: legacyVerifyUrl },
    verifyQrDataUri: await renderVerifyQr(legacyVerifyUrl),
  })
  return generarPdfDocumento(html)
}

// (Ruta /api/facturas/:id/pdf registrada arriba, unificada con renderPdfDoc.)

// ─── Health detallado (requiere HEALTH_TOKEN) ────────────────────────────────
// /api/health (sin auth) está registrado arriba del rate-limiter para Render.

router.get('/health/detailed', async (req, res) => {
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
          const noFactura = await generarSiguienteCodigo('factura', tx)
          const subtotal  = otFull.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0)
          const itbis     = otFull.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
          const total     = Math.round((subtotal + itbis) * 100) / 100

          return tx.factura.create({
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
        }).then(async (facturaCreada) => {
          // Hash post-commit: persistirVerifyHash usa el prisma global y necesita
          // que la row ya esté visible para findUnique (read committed).
          if (facturaCreada?.id) await persistirVerifyHash(facturaCreada)
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

// ─── Pre-render asíncrono de PDFs (latencia cero) ────────────────────────────
// Cada 5 min escanea facturas/cotizaciones de los últimos 7 días con pdfUrl IS NULL
// y las renderiza en background. Cuando el usuario clickea "Ver PDF" después,
// el cache hit es 100% — Puppeteer ni se invoca, redirect directo a Supabase.
//
// Guardrails:
//   - Lock single-flight (_pdfCronRunning) evita overlap si el render se demora.
//   - Cap por corrida (15 documentos máx) — evita saturar Render Free Tier.
//   - Concurrency 2 dentro de la corrida — el page pool tiene 2 páginas idle.
//   - Skip si SUPABASE_STORAGE no configurado (sin destino válido).
let _pdfCronRunning = false
const PDF_PRERENDER_BATCH    = 15
const PDF_PRERENDER_CONCURRENCY = 2

// H11: máximo 5 intentos por factura para evitar romper el batch entero por una
// fila tóxica (data corruption, assets gigantes, infinite-loop en HTML inválido).
const PDF_PRERENDER_MAX_ATTEMPTS = 5

async function prerenderPdfsBatch() {
  if (_pdfCronRunning) return
  if (!supabase)       return
  _pdfCronRunning = true
  const t0 = Date.now()
  let ok = 0, fail = 0, skipped = 0
  try {
    const desde = new Date(Date.now() - 7 * 86_400_000)
    const candidatos = await prisma.factura.findMany({
      where:  {
        pdfUrl: null,
        deletedAt: null,
        fechaEmision: { gte: desde },
        // H11: excluye filas que ya rebasaron el umbral de intentos.
        pdfRenderAttempts: { lt: PDF_PRERENDER_MAX_ATTEMPTS },
      },
      select: { id: true, esCotizacion: true, noFactura: true, pdfRenderAttempts: true },
      orderBy: [{ pdfRenderAttempts: 'asc' }, { fechaEmision: 'desc' }],
      take:   PDF_PRERENDER_BATCH,
    })
    if (candidatos.length === 0) return

    async function renderOne(c) {
      try {
        const f = await prisma.factura.findUnique({
          where:   { id: c.id },
          include: {
            cliente:       true,
            lineas:        { include: { producto: { select: { sku: true, nombre: true } } } },
            facturaOrigen: { select: { noFactura: true, ncf: true, tipoNcf: true } },
          },
        })
        if (!f || f.deletedAt) return
        // M8: snapshot del timestamp de invalidación ANTES de rendrir.
        const invalidatedAtBefore = f.pdfInvalidatedAt
        const data    = await buildPdfData(f)
        const tipo    = f.esCotizacion ? 'cotizacion'
                       : f.esNotaCredito ? 'nota-credito'
                       : f.esNotaDebito  ? 'nota-debito'
                       : 'factura'
        const html    = renderPdfDoc({ tipo, numero: f.noFactura, ...data })
        const pdfBuf  = await generarPdfDocumento(html)

        // M8: re-check pdfInvalidatedAt — si cambió mid-flight, otra ruta mutó
        // la factura y nuestro PDF es OBSOLETO. Descartar sin subir/persistir.
        const reFetch = await prisma.factura.findUnique({
          where: { id: f.id },
          select: { pdfInvalidatedAt: true, deletedAt: true },
        })
        if (reFetch?.deletedAt) return
        if (reFetch?.pdfInvalidatedAt && (!invalidatedAtBefore || reFetch.pdfInvalidatedAt > invalidatedAtBefore)) {
          console.warn(`[PDF CRON] ${c.noFactura} invalidated mid-render — descartando.`)
          return
        }

        const url = await subirPdfAlStorage(pdfBuf, f)
        if (url) {
          // Render OK: pdfUrl set, attempts no se incrementa (queda donde estaba).
          // updateMany con WHERE pdfInvalidatedAt sin cambio -> CAS final atómico.
          const r = await prisma.factura.updateMany({
            where: {
              id: f.id,
              OR: [
                { pdfInvalidatedAt: null },
                { pdfInvalidatedAt: invalidatedAtBefore ?? new Date(0) },
              ],
            },
            data: { pdfUrl: url },
          })
          if (r.count === 0) {
            console.warn(`[PDF CRON] ${c.noFactura} CAS rechazó update — invalidación tardía.`)
          }
          ok++
        } else {
          // Upload falló pero el render OK - cuenta como fail e incrementa attempts.
          await prisma.factura.update({ where: { id: f.id }, data: { pdfRenderAttempts: (c.pdfRenderAttempts ?? 0) + 1 } }).catch(() => {})
          fail++
        }
      } catch (e) {
        console.error(`[PDF CRON] ${c.noFactura} (attempt ${(c.pdfRenderAttempts ?? 0) + 1}/${PDF_PRERENDER_MAX_ATTEMPTS}):`, e.message)
        // Incrementa contador: el siguiente batch puede saltarse esta fila si supera el umbral.
        await prisma.factura.update({
          where: { id: c.id },
          data:  { pdfRenderAttempts: (c.pdfRenderAttempts ?? 0) + 1 },
        }).catch(() => {})
        if ((c.pdfRenderAttempts ?? 0) + 1 >= PDF_PRERENDER_MAX_ATTEMPTS) {
          console.warn(`[PDF CRON] ${c.noFactura} ALCANZÓ ${PDF_PRERENDER_MAX_ATTEMPTS} intentos. Excluida hasta reset manual.`)
          skipped++
        }
        fail++
      }
    }

    // Worker pool simple: N workers tomando del cursor.
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(PDF_PRERENDER_CONCURRENCY, candidatos.length) }, async () => {
        while (cursor < candidatos.length) {
          const idx = cursor++
          await renderOne(candidatos[idx])
        }
      })
    )

    console.log(`[PDF CRON] batch ${candidatos.length} docs en ${Date.now() - t0}ms · ok=${ok} fail=${fail} dead=${skipped}`)
  } catch (e) {
    console.error('[PDF CRON]', e.message)
  } finally {
    _pdfCronRunning = false
  }
}

// */5 * * * *  →  cada 5 min en TZ de RD.
cron.schedule('*/5 * * * *', prerenderPdfsBatch, { timezone: 'America/Santo_Domingo' })

// ─── Carrito Temporal (POS) ───────────────────────────────────────────────────

const CARRITO_INCLUDE = {
  cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, tipoNcf: true, tipoEmpresa: true } },
  lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true, precio: true, stockActual: true, tipoItem: true } } }, orderBy: { id: 'asc' } },
}

router.get('/carrito', verificarJWT, async (req, res) => {
  try {
    let c = await prisma.carritoTemp.findUnique({ where: { empleadoId: req.user.sub }, include: CARRITO_INCLUDE })
    // Nuevo carrito → applyItbis arranca ON. DGII default es factura con ITBIS;
    // mostrar el toggle en azul evita que el cajero crea que está "apagado" por
    // bug visual (el schema default era false antes y daba esa impresión).
    if (!c) c = await prisma.carritoTemp.create({ data: { empleadoId: req.user.sub, applyItbis: true }, include: CARRITO_INCLUDE })
    res.json(formatCarrito(c))
  } catch { res.status(500).json({ error: 'Error al obtener carrito.' }) }
})

router.patch('/carrito', verificarJWT, async (req, res) => {
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

router.post('/carrito/item', verificarJWT, async (req, res) => {
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

router.patch('/carrito/item/:lineaId', verificarJWT, async (req, res) => {
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

router.delete('/carrito/item/:lineaId', verificarJWT, async (req, res) => {
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

router.delete('/carrito', verificarJWT, async (req, res) => {
  try {
    const c = await prisma.carritoTemp.findUnique({ where: { empleadoId: req.user.sub } })
    if (c) await prisma.lineaCarrito.deleteMany({ where: { carritoId: c.id } })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error al vaciar carrito.' }) }
})

router.post('/carrito/checkout', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  const schema = z.object({
    esCotizacion:       z.boolean().optional().default(false),
    tipoNcfOverride:    z.string().optional(),
    descuentoGlobalPct: z.number().min(0).max(100).optional().default(0),
    descuentoGlobalMonto: z.number().min(0).optional().default(0),
    pinSupervisor:      z.string().max(20).optional(),
    condicionesOverride: z.object({
      validez:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
      pago:     z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
      entrega:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
      garantia: z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    }).optional(),
    notasOverride:      z.string().max(2000).nullable().optional(),
  })
  try {
    const { esCotizacion, tipoNcfOverride, descuentoGlobalPct, descuentoGlobalMonto, pinSupervisor, condicionesOverride, notasOverride } = schema.parse(req.body)
    const carrito = await prisma.carritoTemp.findUnique({
      where: { empleadoId: req.user.sub },
      include: { lineas: true },
    })
    if (!carrito || carrito.lineas.length === 0) return res.status(400).json({ error: 'Carrito vacío.' })
    // Rigor Enterprise: el carrito DEBE tener clienteId. Sin walk-in / sin
    // contacto manual. El cajero debe seleccionar (o crear via CRM) un cliente
    // real antes de checkout. Hard-fail con código accionable para que la UI
    // pueda guiar al cajero al selector.
    if (!carrito.clienteId) {
      return res.status(400).json({
        error: 'Selecciona un cliente de la base de datos antes de emitir.',
        code:  'CLIENTE_REQUERIDO',
      })
    }
    const lineas = carrito.lineas.map(l => ({
      productoId:          l.productoId,
      cantidad:            l.cantidad,
      precioUnitario:      Number(l.precioUnitario),
      descuentoPorcentaje: Number(l.descuentoPorcentaje),
      descuentoMonto:      Number(l.descuentoMonto),
    }))
    const _permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const _puedeOverride = _permisos.includes('sistema:owner') || _permisos.includes('pos:override_precio')
    const factura = await procesarFacturaPOS({
      inputClienteId: carrito.clienteId,
      applyItbis:     carrito.applyItbis,
      diasVence:      carrito.diasVence,
      esCotizacion,
      lineas,
      tipoNcfOverride,
      descuentoGlobalPct,
      descuentoGlobalMonto,
      puedeOverridePrecio: _puedeOverride,
      empleadoId:          req.user?.sub ?? null,
      condicionesOverride,
      notasOverride,
    })
    await persistirVerifyHash(factura)
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

// ─── POS — Venta directa desde ItemCatalogo ───────────────────────────────────

// Línea POS acepta DOS modos:
//   1) itemCatalogoId (UUID): venta desde el catálogo comercial (ItemCatalogo).
//   2) productoId    (Int) : venta DIRECTA de inventario físico (Producto) — usado
//      por el banner de cross-sell que sugiere productos no atados a un item.
// Exactly-one-of validado abajo con .refine.
const lineaPOSCatalogoSchema = z.object({
  itemCatalogoId:      z.string().uuid().optional(),
  productoId:          z.number().int().positive().optional(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
}).refine(
  l => (l.itemCatalogoId && !l.productoId) || (!l.itemCatalogoId && l.productoId),
  { message: 'Cada línea debe traer itemCatalogoId (UUID) o productoId (Int), no ambos.' }
)

const pagoMetodoSchema = z.object({
  metodo: z.enum(['Efectivo', 'Transferencia', 'Tarjeta', 'Cheque', 'Otro']),
  // M4: tope mínimo defensivo. positive() ya rechaza 0/negativo pero acepta 1e-12;
  // 0.01 es 1 centavo, el mínimo monetario real en DOP/USD. Bloquea pagos basura.
  monto:  z.number().min(0.01, 'Monto debe ser ≥ RD$0.01.').max(10_000_000, 'Monto excesivo.'),
  refer:  z.string().max(60).optional().nullable(),
})

const posVentaSchema = z.object({
  // Rigor Enterprise: clienteId OBLIGATORIO en TODA venta POS (cotización o
  // factura). Cero walk-in / nombre libre — la trazabilidad fiscal y CRM
  // requiere relación dura con tabla Cliente. nombreTemporal eliminado.
  clienteId:           z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente).' }),
  tipoNcf:             z.string().optional(),
  applyItbis:          z.boolean().optional().default(true),
  diasVence:           z.number().int().min(0).max(365).optional().default(30),
  esCotizacion:        z.boolean().optional().default(false),
  descuentoGlobalPct:  z.number().min(0).max(100).optional().default(0),
  descuentoGlobalMonto:z.number().min(0).optional().default(0),
  pinSupervisor:       z.string().max(20).optional(),         // requerido si desc > 15%
  pagos:               z.array(pagoMetodoSchema).max(20, 'Máximo 20 métodos de pago por factura.').optional(),  // null = no desglosado (legacy). H8: cap anti-DoS
  lineas:              z.array(lineaPOSCatalogoSchema).min(1),
  // Override per-documento de condiciones comerciales y notas. La UI las
  // togglea con PIN supervisor; el shape {incluir:false, texto:...} oculta
  // la fila en el PDF. Si campo viene undefined, mergeCondiciones cae al
  // default de EmpresaPerfil.condicionesDefault.
  condicionesOverride: z.object({
    validez:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    pago:     z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    entrega:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    garantia: z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
  }).optional(),
  notasOverride: z.string().max(2000).nullable().optional(),
})

// Validación previa del PIN supervisor sin emitir factura. La UI lo usa para
// desbloquear los inputs de descuento (global y por línea) en el carrito y
// POS. La verificación real al emitir sigue ocurriendo en /api/pos/venta,
// este endpoint solo confirma "el PIN es correcto, deja al cajero seguir".
const pinVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  keyGenerator: (req) => req.user?.sub ? `pin:${req.user.sub}` : reqFingerprint(req),
  store: makeRateLimitStore(),
  skipSuccessfulRequests: true,
  message: { valid: false, error: 'Demasiados intentos de PIN. Espera 5 minutos.' },
})
router.post('/pos/verificar-pin', verificarJWT, pinVerifyLimiter, async (req, res) => {
  try {
    const pin = String(req.body?.pin ?? '').trim()
    if (!/^\d{4,12}$/.test(pin)) {
      return res.status(400).json({ valid: false, error: 'PIN debe contener 4-12 dígitos.' })
    }
    const empCfg = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } })
    const pinReal = empCfg?.pinSupervisor ?? '1234'
    // Comparación con timingSafeEqual evita timing-attacks por longitud.
    const a = Buffer.from(pin.padEnd(16, '\0'))
    const b = Buffer.from(String(pinReal).padEnd(16, '\0'))
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
    if (!ok) {
      auditReq('pos:pin_invalid', req)
      return res.status(401).json({ valid: false, error: 'PIN inválido.' })
    }
    auditReq('pos:pin_ok', req)
    return res.json({ valid: true })
  } catch (e) {
    console.error('[POS verificar-pin]', e.message)
    return res.status(500).json({ valid: false, error: 'Error de verificación.' })
  }
})

router.post('/pos/venta', verificarJWT, billingLimiter, async (req, res) => {
  try {
    const { clienteId: inputClienteId, tipoNcf: tipoNcfOverride, applyItbis, diasVence, esCotizacion, descuentoGlobalPct, descuentoGlobalMonto, pinSupervisor, pagos, lineas, condicionesOverride, notasOverride } = posVentaSchema.parse(req.body)
    const permReq = esCotizacion ? 'pos:cotizar' : 'pos:facturar'
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    if (!permisos.includes('sistema:owner') && !permisos.includes(permReq))
      return res.status(403).json({ error: `Se requiere permiso "${permReq}".` })

    // ─── Pre-fetch precios DB para gate de PIN basado en % EFECTIVO ─────────
    // C2/C5: el cliente NO puede sobreescribir precioUnitario salvo que tenga
    // permiso 'pos:override_precio'. Calculamos subtotalBruto desde DB para
    // que el gate PIN considere tanto % global como descuentoMonto (efectivo).
    const puedeOverridePrecio = permisos.includes('sistema:owner') || permisos.includes('pos:override_precio')
    const isOwner = permisos.includes('sistema:owner')
    const empCfg  = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true, maxDescuentoCajero: true } })
    const maxDescuentoCajero = Number(empCfg?.maxDescuentoCajero ?? 15)

    const _pidsForGate = [...new Set(lineas.filter(l => l.productoId).map(l => l.productoId))]
    const _iidsForGate = [...new Set(lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))]
    const [_prodGate, _itemGate] = await Promise.all([
      _pidsForGate.length ? prisma.producto.findMany({ where: { id: { in: _pidsForGate } }, select: { id: true, nombre: true, precio: true, stockActual: true, tipoItem: true } }) : [],
      _iidsForGate.length ? prisma.itemCatalogo.findMany({
        where: { id: { in: _iidsForGate } },
        select: {
          id: true, nombre: true, precio: true, productoId: true, esBundle: true,
          producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
          componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
        },
      }) : [],
    ])
    const _pMapGate = Object.fromEntries(_prodGate.map(p => [p.id, Number(p.precio)]))
    const _iMapGate = Object.fromEntries(_itemGate.map(i => [i.id, Number(i.precio)]))
    const _itemFullMap = Object.fromEntries(_itemGate.map(i => [i.id, i]))

    // M10 + Bundles: pre-flight stock check expandiendo bundles. Cada línea se
    // explota a {productoId, cantidad} (bundle multiplica componentes × line.qty)
    // y se agrega antes de comparar contra stockActual. Esto evita falsos OK
    // cuando dos líneas distintas pegan al mismo producto físico (ej. 2 kits CCTV
    // que comparten el mismo modelo de cámara).
    const _stockMapDirect = Object.fromEntries(_prodGate.map(p => [p.id, p]))
    if (!esCotizacion) {
      const requeridos = {}   // productoId -> cantidad total requerida
      const nombresPorPid = {} // para mensajes amistosos
      for (const l of lineas) {
        if (l.productoId) {
          const p = _stockMapDirect[l.productoId]
          if (!p || p.tipoItem === 'SERVICIO') continue
          requeridos[p.id] = (requeridos[p.id] ?? 0) + l.cantidad
          nombresPorPid[p.id] = p.nombre
        } else if (l.itemCatalogoId) {
          const it = _itemFullMap[l.itemCatalogoId]
          if (!it) continue
          // Bundle: explota a componentes.
          if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
            for (const c of it.componentes) {
              if (!c.producto || c.producto.tipoItem === 'SERVICIO') continue
              const cantTotal = c.cantidad * l.cantidad
              requeridos[c.productoId] = (requeridos[c.productoId] ?? 0) + cantTotal
              nombresPorPid[c.productoId] = c.producto.nombre
            }
          } else if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
            requeridos[it.productoId] = (requeridos[it.productoId] ?? 0) + l.cantidad
            nombresPorPid[it.productoId] = it.producto?.nombre ?? it.nombre
          }
        }
      }
      // Verificar disponibilidad por producto (un solo query por chunk).
      const pidsRequeridos = Object.keys(requeridos).map(Number)
      if (pidsRequeridos.length > 0) {
        const stockActuales = await prisma.producto.findMany({
          where:  { id: { in: pidsRequeridos } },
          select: { id: true, nombre: true, stockActual: true },
        })
        for (const p of stockActuales) {
          const req = requeridos[p.id]
          if (Number(p.stockActual) < req) {
            return res.status(422).json({
              error: `Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${req} (incluye expansión de bundles).`,
              code:  'STOCK_INSUFICIENTE',
              productoId: p.id,
            })
          }
        }
      }
    }
    let _subtotalBrutoGate = 0
    for (const l of lineas) {
      const precioBase = l.productoId
        ? (puedeOverridePrecio && l.precioUnitario != null ? Number(l.precioUnitario) : (_pMapGate[l.productoId] ?? 0))
        : (puedeOverridePrecio && l.precioUnitario != null ? Number(l.precioUnitario) : (_iMapGate[l.itemCatalogoId] ?? 0))
      _subtotalBrutoGate += totalLinea(precioBase, l.descuentoPorcentaje ?? 0, l.descuentoMonto ?? 0, l.cantidad)
    }
    const _descMontoEfectivo = _subtotalBrutoGate > 0 ? Math.min(descuentoGlobalMonto, _subtotalBrutoGate) : 0
    const _descMontoComoPct  = _subtotalBrutoGate > 0 ? (_descMontoEfectivo / _subtotalBrutoGate) * 100 : 0
    const descEfectivoPct    = Math.max(descuentoGlobalPct, _descMontoComoPct)

    if (!isOwner && !esCotizacion && descEfectivoPct > maxDescuentoCajero) {
      const pinReal = empCfg?.pinSupervisor ?? '1234'
      if (!pinSupervisor || pinSupervisor !== pinReal) {
        auditReq('pos:descuento_pin_fail', req, { descuentoPctEfectivo: descEfectivoPct.toFixed(2), max: maxDescuentoCajero })
        try {
          await prisma.auditCaja.create({ data: {
            tipo: 'descuento_rechazado', empleadoId: req.user?.sub ?? null,
            descPct: Math.round(descEfectivoPct * 100) / 100,
            detalle: `Cajero intentó descuento efectivo ${descEfectivoPct.toFixed(2)}% (límite ${maxDescuentoCajero}%) sin PIN válido`,
            ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
          }})
        } catch {}
        return res.status(403).json({
          error: `Descuento efectivo ${descEfectivoPct.toFixed(2)}% excede ${maxDescuentoCajero}%. Requiere PIN de supervisor.`,
          code:  'PIN_REQUIRED',
        })
      }
      auditReq('pos:descuento_pin_ok', req, { descuentoPctEfectivo: descEfectivoPct.toFixed(2), max: maxDescuentoCajero })
      try {
        await prisma.auditCaja.create({ data: {
          tipo: 'descuento_pin', empleadoId: req.user?.sub ?? null,
          descPct: Math.round(descEfectivoPct * 100) / 100,
          detalle: `PIN supervisor validó descuento efectivo ${descEfectivoPct.toFixed(2)}% (límite ${maxDescuentoCajero}%)`,
          ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
        }})
      } catch {}
    }

    const factura = await prisma.$transaction(async (tx) => {
      // 1. Resolve client — DEBE ser un Cliente real de DB. Sin walk-in / sin upsert
      // de "Consumidor Final" fantasma. Si no llega clienteId, Zod ya rechazó la
      // petición; este findUnique es la última barrera ante un UUID inexistente.
      const cliente = await tx.cliente.findUnique({ where: { id: inputClienteId } })
      if (!cliente) throw Object.assign(new Error('Cliente no encontrado en la base de datos.'), { status: 404 })

      // 2. Carga ItemCatalogos + Productos físicos según lo que traiga cada línea.
      const itemIds = [...new Set(lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))]
      const prodIds = [...new Set(lineas.filter(l => l.productoId).map(l => l.productoId))]
      const [items, prods] = await Promise.all([
        itemIds.length ? tx.itemCatalogo.findMany({
          where: { id: { in: itemIds } },
          // descripcion + producto.sku necesarios para snapshot fiel al PDF.
          select: { id: true, nombre: true, descripcion: true, precio: true, tipoItem: true, stock: true, productoId: true,
                    producto: { select: { sku: true } } },
        }) : [],
        prodIds.length ? tx.producto.findMany({
          where: { id: { in: prodIds } },
          select: { id: true, sku: true, nombre: true, descripcion: true, precio: true, stockActual: true },
        }) : [],
      ])
      const iMap = Object.fromEntries(items.map(i => [i.id, i]))
      const pMap = Object.fromEntries(prods.map(p => [p.id, p]))
      for (const l of lineas) {
        if (l.itemCatalogoId && !iMap[l.itemCatalogoId]) throw Object.assign(new Error(`Item catálogo ${l.itemCatalogoId} no encontrado.`), { status: 404 })
        if (l.productoId     && !pMap[l.productoId])     throw Object.assign(new Error(`Producto ${l.productoId} no encontrado.`), { status: 404 })
      }

      // 3. Build enriched lines + totals.
      // CRÍTICO: la descripcion enriquecida (markdown title + bullets) DEBE viajar
      // como snapshot al LineaFactura. Si solo guardamos item.nombre, el PDF
      // pierde el detalle (Smart Markdown necesita el texto largo para parsear).
      // Formato: si hay descripción rica -> "**título**\n descripción", el parser
      // del PDF la reconoce como heading + body automáticamente.
      const composeDesc = (titulo, descripcion) => {
        const desc = (descripcion ?? '').trim()
        if (!desc) return titulo
        // Formato estructurado v=1: lo pasamos íntegro (el renderer PDF lo entiende).
        // Si el JSON no trae titulo propio, sobreescribimos con el del producto.
        if (desc.length > 1 && desc[0] === '{') {
          try {
            const obj = JSON.parse(desc)
            if (obj && obj.v === 1) {
              if (!obj.titulo || !obj.titulo.trim()) obj.titulo = titulo
              return JSON.stringify(obj)
            }
          } catch {}
        }
        return `**${titulo}**\n${desc}`
      }
      const lineasEnriquecidas = lineas.map(l => {
        if (l.productoId) {
          const p = pMap[l.productoId]
          // C2: precio autoritativo DB. Cliente solo puede override si tiene 'pos:override_precio'.
          const pu = (puedeOverridePrecio && l.precioUnitario != null)
            ? Number(l.precioUnitario)
            : Number(p.precio)
          return {
            descripcion: composeDesc(p.nombre, p.descripcion),
            cantidad: l.cantidad, precioUnitario: pu,
            productoId:  p.id,                  // -> Factura.lineas.producto.sku flows to PDF
            descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
            descuentoMonto:      l.descuentoMonto ?? 0,
            _isProducto: true,
          }
        }
        const item = iMap[l.itemCatalogoId]
        const pu = (puedeOverridePrecio && l.precioUnitario != null)
          ? Number(l.precioUnitario)
          : Number(item.precio)
        return {
          descripcion: composeDesc(item.nombre, item.descripcion),
          cantidad: l.cantidad, precioUnitario: pu,
          // Si el ItemCatalogo está atado a un Producto físico, copia productoId
          // para que el PDF tire el SKU del producto vinculado.
          productoId:  item.productoId ?? null,
          descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
          descuentoMonto:      l.descuentoMonto ?? 0,
        }
      })
      const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100
      const globalDesc    = descuentoGlobalPct > 0 ? Math.round(subtotalBruto * (descuentoGlobalPct / 100) * 100) / 100 : Math.min(descuentoGlobalMonto, subtotalBruto)
      const subtotal      = Math.round((subtotalBruto - globalDesc) * 100) / 100
      const itbisAmt      = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
      const total         = Math.round((subtotal + itbisAmt) * 100) / 100

      // 4. NCF (DGII) + noFactura (secuenciador centralizado)
      let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado
      if (esCotizacion) {
        noFactura = await generarSiguienteCodigo('cotizacion', tx)
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
        noFactura = await generarSiguienteCodigo('factura', tx)
        estado    = 'Emitida'
      }

      // Validación cobro mixto: la suma de pagos debe igualar total (±0.01 tolerance).
      let pagosValidados = null
      if (!esCotizacion && Array.isArray(pagos) && pagos.length > 0) {
        const suma = pagos.reduce((s, p) => s + Number(p.monto), 0)
        if (Math.abs(suma - total) > 0.01) {
          throw Object.assign(new Error(`Suma de pagos (RD$ ${suma.toFixed(2)}) no coincide con total (RD$ ${total.toFixed(2)}).`), { status: 400 })
        }
        pagosValidados = pagos.map(p => ({ metodo: p.metodo, monto: Number(p.monto), refer: p.refer ?? null }))
      }

      // Notas finales: override del usuario (autorizado por PIN) > auto-generadas.
      // Si notasOverride viene null se persiste null (oculta la sección en PDF).
      // Si viene undefined (sin override), se aplica la nota auto-generada
      // legacy de POS para mantener trazabilidad mínima. Sin variante walk-in:
      // todo documento se emite a un Cliente real, así que la nota refleja eso.
      const notasFinales = (notasOverride !== undefined)
        ? (notasOverride === '' ? null : notasOverride)
        : (esCotizacion
            ? `Cotización POS (catálogo) — ${lineas.length} línea(s)`
            : `Factura POS (catálogo) — ${lineas.length} línea(s)`)

      // 5. Create Factura (no productoId — catalog items don't deduct stock)
      return tx.factura.create({
        data: {
          noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
          ncf, tipoNcf, esCotizacion,
          empleadoId: req.user?.sub ?? null,    // C6: ownership trail (RBAC Kanban)
          pagos: pagosValidados,
          notas: notasFinales,
          // condiciones override per-doc: cada campo {incluir, texto}. Si el
          // user togglea OFF "Validez" en el carrito, llega { validez: {incluir:false} }
          // → mergeCondiciones en buildPdfData retorna null para validez → PDF oculta la fila.
          condiciones: condicionesOverride ?? {},
          fechaVence: diasVence > 0 ? new Date(Date.now() + diasVence * 86_400_000) : null,
          // Strip marker interno (_isProducto) antes de Prisma. productoId pasa intacto al schema.
          lineas: { createMany: { data: lineasEnriquecidas.map(({ _isProducto, ...rest }) => rest) } },
        },
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
          lineas:  true,
        },
      })
    })
    await persistirVerifyHash(factura)
    auditReq(esCotizacion ? 'cotizacion:crear' : 'factura:pos_catalogo', req, { facturaId: factura.id, total: Number(factura.total) })

    // ── Reservas de stock al cotizar (TTL 72h) ──────────────────────────────
    // Para cada línea cuyo ItemCatalogo está vinculado a un Producto físico,
    // crea registro en ReservaInventario. Al listar /api/catalogo, el stock
    // efectivo será stockActual - SUM(reservas activas) → evita doble venta.
    if (esCotizacion) {
      try {
        // ItemCatalogo vinculados a producto físico:
        const catIds = [...new Set(lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))]
        let linkMap = {}
        if (catIds.length > 0) {
          const itemsLink = await prisma.itemCatalogo.findMany({
            where: { id: { in: catIds } }, select: { id: true, productoId: true },
          })
          linkMap = Object.fromEntries(itemsLink.map(i => [i.id, i.productoId]))
        }
        const exp = new Date(Date.now() + 72 * 3600_000)
        const reservas = lineas
          .map(l => ({
            productoId: l.productoId ?? linkMap[l.itemCatalogoId] ?? null,
            cantidad:   l.cantidad,
          }))
          .filter(r => r.productoId)
        if (reservas.length > 0) {
          await prisma.reservaInventario.createMany({
            data: reservas.map(r => ({
              productoId: r.productoId, cantidad: r.cantidad,
              facturaId: factura.id, expiraEn: exp,
              motivo: `Cotización ${factura.noFactura}`,
            })),
          })
        }
      } catch (e) { console.error('[RESERVA]', e.message) }
    }

    // Deducción de stock + Kardex para líneas con productoId real (ventas directas
    // de inventario, no cotizaciones). Itemcatalogo→producto se maneja aparte si aplica.
    if (!esCotizacion) {
      try {
        // Bundles + items directos: expandimos cada línea y agregamos antes de
        // ejecutar el UPDATE. Garantiza que un kit CCTV descuente las 4 cámaras
        // + 1 DVR + cable del stockActual real.
        const aDescontar = {}  // productoId -> cantidad acumulada
        for (const l of lineas) {
          const comps = await expandirLineaAComponentes(prisma, l)
          for (const c of comps) {
            aDescontar[c.productoId] = (aDescontar[c.productoId] ?? 0) + c.cantidad
          }
        }
        for (const [pidStr, cant] of Object.entries(aDescontar)) {
          const pid = Number(pidStr)
          const rows = await prisma.$queryRaw`
            UPDATE "Producto" SET "stockActual" = "stockActual" - ${cant}
            WHERE id = ${pid} AND "stockActual" >= ${cant}
            RETURNING id, "stockActual"
          `
          if (!rows || rows.length === 0) {
            console.error(`[POS] STOCK DRIFT producto ${pid} - venta facturada SIN deducción. Factura ${factura.noFactura}`)
            await prisma.auditCaja.create({ data: {
              tipo: 'stock_drift', empleadoId: req.user?.sub ?? null,
              facturaId: factura.id,
              detalle: `Stock drift productoId=${pid} cantidad=${cant} (post-bundle expansion) — investigar reconciliación.`,
              ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
            }}).catch(() => {})
            continue
          }
          await prisma.movimientoInventario.create({ data: { productoId: pid, tipo: 'Salida', cantidad: cant } })
        }
      } catch (e) { console.error('[POS STOCK]', e.message) }
    }

    // AuditCaja: log venta concretada (no cotización) para fraud trail.
    if (!esCotizacion) {
      try {
        await prisma.auditCaja.create({ data: {
          tipo: 'venta', empleadoId: req.user?.sub ?? null,
          facturaId: factura.id, monto: Number(factura.total),
          descPct: descuentoGlobalPct || null,
          detalle: `${factura.noFactura} · NCF ${factura.ncf ?? '—'} · ${lineas.length} líneas`,
          ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
        }})
      } catch (e) { console.error('[AUDIT CAJA]', e.message) }
    }
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[POS VENTA]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al procesar venta.' })
  }
})

// ─── POS / Manual Invoice ─────────────────────────────────────────────────────

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

// ─── Auto-secuenciador centralizado (núcleo ERP) ──────────────────────────────
// Atómico vía UPDATE-RETURNING sobre EmpresaPerfil.id=1 con jsonb_set. La fila
// se bloquea exclusivamente durante el UPDATE; dos cajeros concurrentes serializan
// y reciben códigos distintos (no race). Defaults se aplican si la entidad no
// existe aún en secuenciasConfig — un INSERT diferido no hace falta.
const SECUENCIA_DEFAULTS = {
  factura:     { prefijo: 'FAC', actual: 0, padding: 6 },
  cotizacion:  { prefijo: 'COT', actual: 0, padding: 6 },
  producto:    { prefijo: 'ART', actual: 0, padding: 6 },
  servicio:    { prefijo: 'SVC', actual: 0, padding: 6 },
  cliente:     { prefijo: 'CLI', actual: 0, padding: 6 },
  rma:         { prefijo: 'RMA', actual: 0, padding: 5 },
  plan:        { prefijo: 'PLN', actual: 0, padding: 6 },
  // Secuenciador interno para el "noFactura" de Notas de Crédito (NC-000001).
  // El NCF B04 sigue su PROPIA secuencia DGII en ConfiguracionNCF — son
  // numeradores independientes (no confundir interno vs fiscal).
  notaCredito: { prefijo: 'NC',  actual: 0, padding: 6 },
  // Idem para Nota de Débito interna (ND-000001) — NCF B03 vive aparte en
  // ConfiguracionNCF para que el numerador fiscal nunca dependa del interno.
  notaDebito:  { prefijo: 'ND',  actual: 0, padding: 6 },
}

async function generarSiguienteCodigo(entidad, tx) {
  const def = SECUENCIA_DEFAULTS[entidad]
  if (!def) throw new Error(`Entidad de secuencia desconocida: "${entidad}".`)
  const db = tx ?? prisma
  // jsonb_set asegura que la rama exista. Si la entidad no había sido configurada,
  // sembramos con defaults antes de incrementar.
  const seedPath = `{${entidad}}`
  const actualPath = `{${entidad},actual}`
  const rows = await db.$queryRawUnsafe(`
    UPDATE "EmpresaPerfil"
    SET    "secuenciasConfig" =
      jsonb_set(
        jsonb_set(
          COALESCE("secuenciasConfig", '{}'::jsonb),
          '${seedPath}',
          COALESCE("secuenciasConfig"->'${entidad}', $1::jsonb),
          true
        ),
        '${actualPath}',
        (
          (COALESCE(("secuenciasConfig"->'${entidad}'->>'actual')::int, ${def.actual}) + 1)::text
        )::jsonb,
        true
      )
    WHERE  id = 1
    RETURNING
      COALESCE("secuenciasConfig"->'${entidad}'->>'prefijo', $2)        AS prefijo,
      (("secuenciasConfig"->'${entidad}'->>'actual')::int)              AS actual,
      COALESCE(("secuenciasConfig"->'${entidad}'->>'padding')::int, $3) AS padding
  `, JSON.stringify(def), def.prefijo, def.padding)
  if (!rows || rows.length === 0) {
    // Fila id=1 no existe — crearla con defaults y reintentar una sola vez.
    await db.empresaPerfil.upsert({
      where:  { id: 1 },
      update: {},
      create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig: { [entidad]: def } },
    })
    return generarSiguienteCodigo(entidad, tx)
  }
  const { prefijo, actual, padding } = rows[0]
  return `${prefijo}-${String(actual).padStart(Number(padding) || 6, '0')}`
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
  // Rigor Enterprise: clienteId OBLIGATORIO. Cero clientes walk-in / manuales.
  // Toda factura/cotización debe vincularse a un cliente real de la tabla Cliente.
  clienteId:    z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente en CRM).' }),
  itbis:        z.boolean().optional().default(true),
  diasVence:    z.number().int().min(0).max(365).optional().default(30),
  esCotizacion: z.boolean().optional().default(false),
  lineas:       z.array(lineaPOSSchema).min(1, 'Se requiere al menos una línea.'),
})

// Shared transaction: used by /api/facturas/manual and /api/carrito/checkout
// C2: puedeOverridePrecio gating + empleadoId trace.
// ─── BOM helper: expande líneas a lista plana de componentes físicos ─────────
// Devuelve un array de { productoId, cantidad, nombre } para cada línea:
//   - Línea con productoId directo  → 1 entry (la propia línea)
//   - Línea con itemCatalogo bundle → N entries (uno por componente, qty × line.qty)
//   - Línea con itemCatalogo simple vinculado a Producto → 1 entry (item.productoId)
//   - Línea de servicio puro → array vacío (no consume stock)
// Usado por OT (reservas) y POS (stock check + deducción).
async function expandirLineaAComponentes(tx, linea) {
  // Guards defensivos: una línea ausente o sin cantidad válida no consume stock.
  if (!linea || typeof linea !== 'object') return []
  const cantidad = Number(linea.cantidad)
  if (!Number.isFinite(cantidad) || cantidad <= 0) return []
  if (linea.productoId) {
    return [{ productoId: linea.productoId, cantidad, source: 'direct' }]
  }
  if (linea.itemCatalogoId) {
    let it
    try {
      it = await tx.itemCatalogo.findUnique({
        where:   { id: linea.itemCatalogoId },
        include: {
          componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
          producto:    { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
        },
      })
    } catch (e) {
      console.warn(`[expandirLineaAComponentes] lookup falló id=${linea.itemCatalogoId}:`, e.message)
      return []
    }
    if (!it) return []
    // Bundle: explota a lista de componentes (cantidades multiplicadas por la línea).
    if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
      return it.componentes
        .filter(c => c?.producto && c.producto.tipoItem !== 'SERVICIO' && Number(c.cantidad) > 0)
        .map(c => ({
          productoId: c.productoId,
          cantidad:   Number(c.cantidad) * cantidad,
          nombre:     c.producto.nombre ?? 'Componente',
          source:     'bundle',
          bundleItemId: it.id,
        }))
    }
    // Item simple vinculado a Producto físico (no bundle)
    if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
      return [{ productoId: it.productoId, cantidad, nombre: it.producto?.nombre ?? it.nombre ?? 'Producto', source: 'linked' }]
    }
  }
  return []
}

async function procesarFacturaPOS({ inputClienteId, applyItbis, diasVence, esCotizacion, lineas, tipoNcfOverride, descuentoGlobalPct = 0, descuentoGlobalMonto = 0, puedeOverridePrecio = false, empleadoId = null, condicionesOverride = undefined, notasOverride = undefined }) {
  // Rigor Enterprise: clienteId obligatorio. Sin walk-in. Esta guard se ejecuta
  // ANTES de abrir la $transaction para evitar costos inútiles si falta el
  // cliente. La barrera Zod en las rutas que invocan procesarFacturaPOS también
  // valida — este check es defense-in-depth para callers internos (revivir, etc).
  if (!inputClienteId) {
    throw Object.assign(new Error('clienteId es obligatorio — vincula el documento a un cliente real.'), { status: 400 })
  }
  return prisma.$transaction(async (tx) => {
    // 1. Resolve client — siempre via findUnique sobre Cliente real.
    const cliente = await tx.cliente.findUnique({ where: { id: inputClienteId } })
    if (!cliente) throw Object.assign(new Error('Cliente no encontrado en la base de datos.'), { status: 404 })

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
    // C2: precio autoritativo DB. Si cliente no tiene 'pos:override_precio',
    // ignoramos l.precioUnitario y usamos Producto.precio actual.
    const lineasEnriquecidas = lineas.map(l => {
      if (l.productoId) {
        const p   = pMap[l.productoId]
        const pu  = (puedeOverridePrecio && l.precioUnitario != null)
          ? Number(l.precioUnitario)
          : Number(p.precio)
        const pct = l.descuentoPorcentaje ?? 0
        const mon = l.descuentoMonto ?? 0
        return { productoId: l.productoId, descripcion: l.descripcion ?? p.nombre, cantidad: l.cantidad,
                 precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, _tipoItem: p.tipoItem }
      }
      // Description-only line (POS catalog item — no inventory tracking).
      // Aquí precio sí puede venir del cliente (no hay producto físico que validar).
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
      noFactura = await generarSiguienteCodigo('cotizacion', tx)
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
      noFactura = await generarSiguienteCodigo('factura', tx)
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
    // Notas: override del usuario (PIN-autorizado) > auto-generadas. Si el
    // user envió notasOverride === '' (toggle OFF), persistimos null y el
    // PDF oculta la sección Notas vía mergeCondiciones/templater.
    // Sin variante walk-in: clienteId es siempre real.
    const notasFinales = (notasOverride !== undefined)
      ? (notasOverride === '' ? null : notasOverride)
      : (esCotizacion
          ? `Cotización POS — ${lineas.length} línea(s)`
          : `Factura manual POS — ${lineas.length} línea(s)`)
    const f = await tx.factura.create({
      data: {
        noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
        ncf, tipoNcf, esCotizacion,
        empleadoId,                              // C6: ownership trail
        snapshot,
        notas:      notasFinales,
        // condiciones override per-doc: {validez,pago,entrega,garantia} cada
        // uno con {incluir, texto?}. mergeCondiciones en buildPdfData filtra
        // los incluir=false para que el PDF oculte esas filas.
        condiciones: condicionesOverride ?? {},
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

router.post('/facturas/manual', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  try {
    const { clienteId, itbis: applyItbis, diasVence, esCotizacion, lineas } = facturaManualSchema.parse(req.body)
    const _permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const puedeOverridePrecio = _permisos.includes('sistema:owner') || _permisos.includes('pos:override_precio')
    const factura = await procesarFacturaPOS({ inputClienteId: clienteId, applyItbis, diasVence, esCotizacion, lineas, puedeOverridePrecio, empleadoId: req.user?.sub ?? null })
    await persistirVerifyHash(factura)
    auditReq(esCotizacion ? 'cotizacion:crear' : 'factura:manual', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total), lineas: factura.lineas.length })
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[FACTURA MANUAL]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al generar la factura.' })
  }
})

// ─── Facturas ────────────────────────────────────────────────────────────────

router.post('/facturas', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
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

      // 4. NCF (DGII compliance) + noFactura (interno auto-secuenciador del owner).
      const seq       = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncf       = `${rows[0].prefijo}${seq}`
      // noFactura ahora usa el secuenciador centralizado configurable por owner.
      // NCF sigue su lógica DGII independiente (no se mezclan responsabilidades).
      const noFactura = await generarSiguienteCodigo('factura', tx)

      // 5. Cálculo de totales — EXCLUYE líneas marcadas como consumoInterno
      // (materiales gastados en instalación que NO se facturan al cliente).
      // El descuento real de stock para esas líneas ocurre al cerrar la OT.
      const lineasFacturables = ot.lineas.filter(l => !l.consumoInterno)
      const subtotal = lineasFacturables.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0)
      const itbis    = ot.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
      const total    = Math.round((subtotal + itbis) * 100) / 100

      // 6. Crear Factura en estado Emitida
      const f = await tx.factura.create({
        data: {
          noFactura,
          clienteId:  ot.clienteId,
          ordenId:    ot.id,
          empleadoId: req.user?.sub ?? null,
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

    // Hash lifecycle: persistimos verifyHash SYNCHRONOUSLY antes de responder.
    // Cualquier PDF/QR generado después leerá un row que ya tiene el hash final.
    await persistirVerifyHash(factura)
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

// ─── Órdenes de Trabajo ───────────────────────────────────────────────────────

const lineaOTSchema = z.object({
  itemCatalogoId: z.string().uuid().optional().nullable(),
  productoId:     z.number().int().optional().nullable(),
  descripcion:    z.string().min(1).max(2000),
  cantidad:       z.number().int().min(1).default(1),
  precioUnitario: z.number().min(0),
  // BOM oculto: si true, descuenta stock al cerrar OT pero NO se factura.
  consumoInterno: z.boolean().optional().default(false),
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

router.get('/ordenes', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
  try {
    const { estado, tipoOT, clienteId, tecnicoId, search, clienteNombre, desde, hasta, limit = '50', offset = '0' } = req.query
    const where = { deletedAt: null }
    if (estado)    where.estado    = estado
    if (tipoOT)    where.tipoOT    = tipoOT
    if (clienteId) where.clienteId = clienteId
    if (tecnicoId) where.tecnicoId = parseInt(tecnicoId)
    if (search)    where.noOT      = { contains: search, mode: 'insensitive' }
    if (clienteNombre) where.cliente = { razonSocial: { contains: clienteNombre, mode: 'insensitive' } }
    if (desde || hasta) {
      where.createdAt = {}
      if (desde) where.createdAt.gte = new Date(desde)
      if (hasta) { const h = new Date(hasta); h.setHours(23, 59, 59, 999); where.createdAt.lte = h }
    }
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

// TTL para reservas creadas por OT en estado Pendiente.
// Si la OT no avanza en 7 días, un cron las libera (ver expirarReservasOTPendientes).
const OT_RESERVA_TTL_MS = 7 * 86_400_000

router.post('/ordenes', verificarJWT, billingLimiter, requerirPermiso('ot:crear'), async (req, res) => {
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

      // Reservas de stock: para cada línea, expandimos a componentes físicos
      // (item simple, item bundle, o producto directo) y creamos ReservaInventario.
      // Las reservas NO descuentan del stockActual aún — solo "marcan" para que
      // el POS sepa que ese inventario está comprometido. Stock disponible real
      // = stockActual - SUM(reservas liberada=false).
      const expiraEn = new Date(Date.now() + OT_RESERVA_TTL_MS)
      const reservasACrear = []
      for (const l of lineas) {
        const comps = await expandirLineaAComponentes(tx, l)
        for (const c of comps) {
          reservasACrear.push({
            productoId: c.productoId,
            cantidad:   c.cantidad,
            ordenId:    ot.id,
            expiraEn,
            motivo:     `OT ${noOT} · ${c.source}${c.nombre ? ' · ' + c.nombre : ''}`,
          })
        }
      }
      if (reservasACrear.length > 0) {
        await tx.reservaInventario.createMany({ data: reservasACrear })
      }

      return tx.ordenTrabajo.findUnique({
        where: { id: ot.id },
        include: {
          cliente: { select: { id: true, razonSocial: true } },
          lineas:  { include: { itemCatalogo: { select: { nombre: true } } } },
          reservas:{ select: { id: true, productoId: true, cantidad: true, expiraEn: true } },
        },
      })
    })
    auditReq('ot:crear', req, { ordenId: orden.id, tipoOT: orden.tipoOT, clienteId: orden.clienteId, reservas: orden.reservas?.length ?? 0 })
    res.status(201).json(orden)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[OT CREAR]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.delete('/ordenes/:id', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
  try {
    const ot = await prisma.ordenTrabajo.findUnique({ where: { id: req.params.id }, select: { id: true, estaFacturada: true, deletedAt: true } })
    if (!ot || ot.deletedAt)          return res.status(404).json({ error: 'OT no encontrada.' })
    if (ot.estaFacturada)             return res.status(409).json({ error: 'No se puede eliminar una OT ya facturada.' })
    await prisma.ordenTrabajo.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
    auditReq('ot:eliminar', req, { otId: req.params.id })
    res.status(204).end()
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Catálogo UNIVERSAL: búsqueda unificada (POS / Facturas / Cotizaciones) ──
// Devuelve resultados mezclados de tres fuentes con shape común:
//   ItemCatalogo (la vitrina comercial)  → kind=item
//   Producto físico no vinculado a item  → kind=producto (entradas legacy)
//   Plan ISP                             → kind=plan
// El consumidor (PanelPOS, FormularioFactura) renderiza un badge por `kind`.
router.get('/catalogo/buscar', verificarJWT, async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50)
    const incluir = String(req.query.incluir ?? 'item,producto,plan').split(',').map(s => s.trim()).filter(Boolean)
    const onlyActivos = req.query.activo !== 'false'

    const tasks = []

    if (incluir.includes('item')) {
      tasks.push(
        prisma.itemCatalogo.findMany({
          where: {
            ...(onlyActivos ? { activo: true } : {}),
            ...(q ? { OR: [
              { nombre:      { contains: q, mode: 'insensitive' } },
              { codigo:      { contains: q, mode: 'insensitive' } },
              { descripcion: { contains: q, mode: 'insensitive' } },
            ] } : {}),
          },
          take: limit,
          orderBy: [{ tipoItem: 'asc' }, { nombre: 'asc' }],
          include: { producto: { select: { id: true, sku: true, stockActual: true, imagenUrl: true } } },
        }).then(rows => rows.map(it => ({
          kind:          'item',
          id:            it.id,
          codigo:        it.codigo ?? `ITM-${String(it.id).slice(0, 6).toUpperCase()}`,
          nombre:        it.nombre ?? 'Sin nombre',
          descripcion:   it.descripcion ?? null,
          imagenUrl:     it.imagenUrl ?? it.producto?.imagenUrl ?? null,
          tipo:          it.tipo ?? 'Servicio',
          categoria:     it.categoria ?? null,
          tipoItem:      it.tipoItem ?? 'SERVICIO',
          esBundle:      !!it.esBundle,
          precio:        Number(it.precio ?? 0),
          productoId:    it.productoId ?? null,
          stockActual:   it.producto?.stockActual ?? null,
          sku:           it.producto?.sku ?? null,
          activo:        it.activo !== false,
        })))
      )
    }

    if (incluir.includes('producto')) {
      // Solo productos que NO están vinculados a un ItemCatalogo (evita duplicar).
      tasks.push(
        prisma.producto.findMany({
          where: {
            ...(q ? { OR: [
              { nombre: { contains: q, mode: 'insensitive' } },
              { sku:    { contains: q, mode: 'insensitive' } },
            ] } : {}),
            // Excluye productos ya vinculados desde algún ItemCatalogo activo
            itemsCatalogo: { none: onlyActivos ? { activo: true } : {} },
          },
          take: limit,
          orderBy: { nombre: 'asc' },
          select: { id: true, sku: true, nombre: true, descripcion: true, precio: true, stockActual: true, tipoItem: true, imagenUrl: true },
        }).then(rows => rows.map(p => ({
          kind:        'producto',
          id:          p.id,
          codigo:      p.sku ?? `P-${p.id}`,
          nombre:      p.nombre ?? 'Sin nombre',
          descripcion: p.descripcion ?? null,
          imagenUrl:   p.imagenUrl ?? null,
          tipo:        'VentaUnica',
          tipoItem:    p.tipoItem ?? 'ARTICULO',
          precio:      Number(p.precio ?? 0),
          productoId:  p.id,
          stockActual: p.stockActual ?? 0,
          sku:         p.sku ?? null,
          activo:      true,
        })))
      )
    }

    if (incluir.includes('plan')) {
      tasks.push(
        prisma.plan.findMany({
          where: {
            ...(onlyActivos ? { activo: true } : {}),
            ...(q ? { OR: [
              { nombre: { contains: q, mode: 'insensitive' } },
              { sku:    { contains: q, mode: 'insensitive' } },
            ] } : {}),
          },
          take: limit,
          orderBy: { nombre: 'asc' },
          select: { id: true, sku: true, nombre: true, tipo: true, precioMensualBase: true, activo: true },
        }).then(rows => rows.map(pl => ({
          kind:        'plan',
          id:          pl.id,
          codigo:      pl.sku ?? `PLN-${String(pl.id).slice(0, 6).toUpperCase()}`,
          nombre:      pl.nombre ?? 'Sin nombre',
          descripcion: null,
          imagenUrl:   null,
          tipo:        'Recurrente',
          categoria:   pl.tipo ?? 'Mixto',
          tipoItem:    'SERVICIO',
          precio:      Number(pl.precioMensualBase ?? 0),
          stockActual: null,
          activo:      pl.activo !== false,
        })))
      )
    }

    const buckets = await Promise.all(tasks)
    const unificado = buckets.flat().slice(0, limit * 3)
    res.json({ data: unificado, total: unificado.length, fuentes: incluir })
  } catch (e) {
    console.error('[GET /api/catalogo/buscar]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.delete('/catalogo/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
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

router.get('/ncf-config', verificarJWT, requerirPermiso('factura:ver'), async (req, res) => {
  try {
    const configs = await prisma.configuracionNCF.findMany({ orderBy: { tipoNcf: 'asc' } })
    res.json({ data: configs })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

router.post('/ncf-config', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
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

// ─── Catálogo de Items (Ventas) ───────────────────────────────────────────────

const itemCatalogoSchema = z.object({
  nombre:      z.string().min(1).max(120),
  // Acepta string legacy O objeto estructurado {v:1, titulo, bullets[], imagenUrl?}
  // que el EditorDescripcion envía. descripcionToRaw normaliza a JSON serializado.
  descripcion: descripcionFlexSchema,
  imagenUrl:   z.string().max(500).url().optional().nullable().or(z.literal('').transform(() => null)),
  tipo:        z.enum(['Recurrente', 'VentaUnica', 'Servicio']),
  categoria:   z.enum(['WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'Mixto', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV']),
  precio:      z.number().min(0),
  costo:       z.number().min(0).optional().default(0),
  stock:       z.number().int().optional().nullable(),
  productoId:  z.number().int().positive().optional().nullable(),
  // tipoItem distingue ARTICULO (consume stock) vs SERVICIO (intangible, sin stock).
  // Default SERVICIO para que items nuevos sin tipo explícito asuman lo más común.
  tipoItem:    z.enum(['ARTICULO', 'SERVICIO']).optional().default('SERVICIO'),
  esBundle:    z.boolean().optional().default(false),
  activo:      z.boolean().default(true),
})

router.get('/catalogo', verificarJWT, async (req, res) => {
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
    // Reservas activas (no liberadas, sin expirar) por producto — resta del stock efectivo.
    const prodIds = items.map(it => it.producto?.id).filter(Boolean)
    const reservas = prodIds.length > 0
      ? await prisma.reservaInventario.groupBy({
          by:   ['productoId'],
          _sum: { cantidad: true },
          where:{ productoId: { in: prodIds }, liberada: false, expiraEn: { gt: new Date() } },
        })
      : []
    const reservMap = Object.fromEntries(reservas.map(r => [r.productoId, r._sum.cantidad ?? 0]))
    // Resuelve campos efectivos: imagen y stock del Producto físico ganan si están atados.
    const enriched = items.map(it => {
      const pref = CODIGO_PREFIJO[it.tipo] ?? 'ITM'
      // Si el item no tiene `codigo` (legacy pre-rollout), genera uno estable basado
      // en el UUID. NO chocará con códigos seq nuevos porque incluye hex (no decimales).
      const codigoFallback = `${pref}-${String(it.id ?? '').replace(/-/g, '').slice(0, 6).toUpperCase()}`
      // Resta reservas activas al stock del producto físico.
      const reservadas = it.producto ? (reservMap[it.producto.id] ?? 0) : 0
      const stockBase  = it.producto ? it.producto.stockActual : it.stock
      const stockEff   = stockBase != null ? Math.max(0, stockBase - reservadas) : null
      return {
        ...it,
        codigo:     it.codigo ?? codigoFallback,
        imagenUrl:  it.imagenUrl ?? it.producto?.imagenUrl ?? null,
        stock:      stockEff,
        stockReservado: reservadas,
        stockFisico:    stockBase,
        stockSource: it.producto ? 'inventario' : (it.stock != null ? 'catalogo' : null),
        sku:        it.producto?.sku ?? null,
      }
    })
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos')
    const data = canSeeCosts ? enriched : enriched.map(({ costo, ...rest }) => rest)
    res.json({ data })
  } catch (e) { console.error('[GET /api/catalogo]', e.code, e.message); res.status(500).json({ error: 'Error interno.' }) }
})

// Prefijo por tipo para codigo legible. Lookup constante.
const CODIGO_PREFIJO = { Recurrente: 'REC', VentaUnica: 'ART', Servicio: 'SRV' }

// Asigna codigo incremental único por tipo (SRV-0001, ART-0001, REC-0001).
// Usa la query sobre el último codigo del mismo prefijo + 1. Sin SEQUENCE
// dedicado para no tocar más DDL — el UNIQUE INDEX protege de race conditions
// y reintenta si choca.
async function generarCodigoCatalogo(tipo) {
  const pref = CODIGO_PREFIJO[tipo] ?? 'ITM'
  for (let attempt = 0; attempt < 3; attempt++) {
    const ultimo = await prisma.itemCatalogo.findFirst({
      where:   { codigo: { startsWith: `${pref}-` } },
      orderBy: { codigo: 'desc' },
      select:  { codigo: true },
    })
    let n = 1
    if (ultimo?.codigo) {
      const m = ultimo.codigo.match(/^[A-Z]+-(\d+)$/)
      if (m) n = parseInt(m[1], 10) + 1
    }
    return `${pref}-${String(n + attempt).padStart(4, '0')}`
  }
}

router.post('/catalogo', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
  try {
    const data = itemCatalogoSchema.parse(req.body)
    if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion)
    const codigo = await generarCodigoCatalogo(data.tipo)
    const item = await prisma.itemCatalogo.create({ data: { ...data, codigo } })
    auditReq('catalogo:crear', req, { id: item.id, codigo, tipo: data.tipo, tipoItem: data.tipoItem })
    res.status(201).json(item)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.put('/catalogo/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
  try {
    const data = itemCatalogoSchema.parse(req.body)
    if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion)
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos')
    if (!canSeeCosts) {
      const existing = await prisma.itemCatalogo.findUnique({ where: { id: req.params.id }, select: { costo: true } })
      if (existing) data.costo = Number(existing.costo)
    }
    const item = await prisma.itemCatalogo.update({ where: { id: req.params.id }, data })
    auditReq('catalogo:editar', req, { id: item.id, codigo: item.codigo })
    res.json(item)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

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

// IMPORTANTE: estas rutas son de `OrdenInstalacion` (Servicios). Antes ocupaban
// `/api/ordenes` y SHADOW-bloqueaban las rutas de `OrdenTrabajo` (Ventas) — el
// panel de Ventas quedaba vacío. Renombradas a `/api/ordenes-instalacion` para
// liberar `/api/ordenes` que ahora sirve exclusivamente OrdenTrabajo (línea ~5192).
router.get('/ordenes-instalacion', async (req, res) => {
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

router.post('/ordenes-instalacion', verificarJWT, requerirPermiso('ot:crear'), async (req, res) => {
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

router.put('/ordenes-instalacion/:id', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

router.patch('/ordenes-instalacion/:id/completar', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

router.get('/servicios', async (req, res) => {
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

router.post('/servicios', verificarJWT, requerirPermiso('servicios:crear'), async (req, res) => {
  try {
    const data = servicioSchema.parse(req.body);
    const servicio = await prisma.$transaction(async (tx) => {
      const noServicio = await generarSiguienteCodigo('servicio', tx)
      return tx.servicio.create({ data: { ...data, noServicio }, include: { cliente: { select: { id: true, razonSocial: true, noCliente: true, telefonoPrincipal: true } }, plan: { select: { id: true, nombre: true, tipo: true } } } })
    })
    res.status(201).json(formatServicio(servicio));
  } catch (error) {
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

router.put('/servicios/:id', verificarJWT, requerirPermiso('servicios:crear'), async (req, res) => {
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

router.patch('/servicios/:id/estado', verificarJWT, requerirPermiso('servicios:crear'), async (req, res) => {
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

router.get('/planes', async (req, res) => {
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

router.get('/planes/:id', async (req, res) => {
  if (rejectBadId(req, res)) return;
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true, stockActual: true } } } } } });
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado.' });
    res.json(formatPlan(plan));
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener plan' });
  }
});

router.post('/planes', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
  try {
    const { plantillaEquipos, ...rest } = planSchema.parse(req.body);
    const plan = await prisma.$transaction(async (tx) => {
      const sku = await generarSiguienteCodigo('plan', tx)
      return tx.plan.create({
        data: { ...rest, sku, plantillaEquipos: { create: plantillaEquipos } },
        include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } },
      })
    })
    res.status(201).json(formatPlan(plan));
  } catch (error) {
    res.status(400).json({ error: 'Datos inválidos' });
  }
});

router.put('/planes/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
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

router.patch('/planes/:id/toggle', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
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

router.get('/taller', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
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

router.post('/taller', verificarJWT, requerirPermiso('ot:crear'), async (req, res) => {
  try {
    const data = ticketTallerSchema.parse(req.body)
    let pin, intento = 0
    while (intento < 5) {
      pin = generarPin()
      const colide = await prisma.ticketTaller.findUnique({ where: { codigoPin: pin } })
      if (!colide) break
      intento++
    }
    if (intento >= 5) return res.status(503).json({ error: 'No se pudo generar PIN único. Reintenta.' })
    const ticket = await prisma.$transaction(async (tx) => {
      // Auto-secuenciador centralizado: prefijo + número configurables por owner.
      const noTicket = await generarSiguienteCodigo('rma', tx)
      return tx.ticketTaller.create({
        data: { ...data, noTicket, codigoPin: pin },
        include: { cliente: { select: { razonSocial: true } } },
      })
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

router.patch('/taller/:id/estado', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

router.patch('/taller/:id', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

router.patch('/taller/:id/reabrir', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
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
// ─── MSP: OT close + auto-create ActivoCliente ────────────────────────────────

router.patch('/ordenes/:id/estado', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

    const resultado = await prisma.$transaction(async (tx) => {
      await tx.ordenTrabajo.update({ where: { id: req.params.id }, data: update })

      // Reservas de stock: Cancelada → libera; Cerrada → consume del stock.
      let reservasLiberadas = 0
      let stockDescontado  = 0
      if (data.estado === 'Cancelada') {
        const r = await tx.reservaInventario.deleteMany({
          where: { ordenId: ot.id, liberada: false },
        })
        reservasLiberadas = r.count
      } else if (data.estado === 'Cerrada') {
        // Consume cada reserva: UPDATE atómico stock - cantidad + Kardex Salida.
        // Si stockActual < cantidad reservada (drift), log y skip esa línea sin abortar
        // el cierre completo (las reservas son una previsión; el cierre es el hecho real).
        const reservas = await tx.reservaInventario.findMany({
          where: { ordenId: ot.id, liberada: false },
        })
        for (const r of reservas) {
          const rows = await tx.$queryRaw`
            UPDATE "Producto" SET "stockActual" = "stockActual" - ${r.cantidad}
            WHERE id = ${r.productoId} AND "stockActual" >= ${r.cantidad}
            RETURNING id, "stockActual"
          `
          if (!rows || rows.length === 0) {
            console.warn(`[OT CIERRE] Stock drift productoId=${r.productoId} cantidad=${r.cantidad} OT=${ot.id}`)
            await tx.auditCaja.create({ data: {
              tipo: 'stock_drift_ot', empleadoId: req.user?.sub ?? null,
              detalle: `Cierre OT ${ot.noOT ?? ot.id}: stock insuficiente productoId=${r.productoId} req=${r.cantidad}. Reserva consumida sin descontar.`,
            }}).catch(() => {})
          } else {
            await tx.movimientoInventario.create({
              data: { productoId: r.productoId, tipo: 'Salida', cantidad: r.cantidad },
            })
            stockDescontado++
          }
        }
        await tx.reservaInventario.deleteMany({ where: { ordenId: ot.id } })
        reservasLiberadas = reservas.length
      }

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
      return { reservasLiberadas, stockDescontado }
    })

    auditReq('ot:estado', req, { otId: ot.id, estado: data.estado, reservasLiberadas: resultado.reservasLiberadas, stockDescontado: resultado.stockDescontado })
    res.json({ ok: true, ...resultado })
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

router.get('/ordenes/:id/fotos', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
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

// Bucket dedicado para fotos de OT (separado de catálogo e inventario).
const OT_FOTOS_BUCKET = process.env.SUPABASE_OT_FOTOS_BUCKET ?? 'ot-fotos'
// Upload directo de foto (multipart) con watermark ya aplicado por el cliente.
// Maneja: validación MIME + upload Supabase + creación de OrdenFoto en una sola llamada.
// El watermark se inyecta CLIENT-SIDE (canvas) antes de enviar; el server confía pero
// re-procesa via sharp para normalizar a JPEG + cap 800x800 + EXIF strip (privacidad GPS doble).
router.post('/ordenes/:id/fotos/upload',
  uploadLimiter,
  verificarJWT,
  requerirPermiso('ot:editar'),
  uploadMulter.single('file'),
  async (req, res) => {
    if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
    try {
      if (!supabase) return res.status(503).json({ error: 'Storage no configurado.', code: 'STORAGE_DISABLED' })
      // Defensa contra Content-Type incorrecto: multer ignora silenciosamente si
      // el body NO es multipart -> req.file queda undefined. Devolvemos mensaje claro.
      const ct = String(req.headers['content-type'] ?? '')
      if (!ct.startsWith('multipart/form-data')) {
        return res.status(415).json({ error: 'Content-Type debe ser multipart/form-data.', code: 'WRONG_CT' })
      }
      if (!req.file) return res.status(400).json({ error: 'Archivo requerido (campo "file").', code: 'NO_FILE' })
      if (!req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: 'Archivo vacío.', code: 'EMPTY_FILE' })
      }

      const ot = await prisma.ordenTrabajo.findUnique({ where: { id: req.params.id }, select: { id: true, estado: true, estaFacturada: true } })
      if (!ot) return res.status(404).json({ error: 'OT no encontrada.' })
      if (ot.estado === 'Cerrada' && ot.estaFacturada) return res.status(423).json({ error: 'OT inmutable.' })

      const inputMime = detectMimeFromBuffer(req.file.buffer)
      if (!inputMime || !['image/png', 'image/jpeg', 'image/webp'].includes(inputMime)) {
        return res.status(415).json({ error: 'Solo PNG/JPG/WebP. SVG rechazado por seguridad.', code: 'INVALID_MIME' })
      }
      // Comprime + strip EXIF (sharp respeta rotate desde EXIF y luego descarta metadata).
      let buffer, finalMime, ext
      try {
        const c = await comprimirImagen(req.file.buffer, inputMime)
        buffer = c.buffer; finalMime = c.mime; ext = c.ext
      } catch (sharpErr) {
        console.error('[OT FOTO SHARP]', sharpErr?.message)
        return res.status(422).json({ error: 'Imagen corrupta o ilegible.', code: 'COMPRESS_FAIL' })
      }
      if (!buffer || buffer.length === 0) {
        return res.status(422).json({ error: 'Imagen post-compresión vacía.', code: 'EMPTY_AFTER_COMPRESS' })
      }
      const filename = `${ot.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
      const { error: upErr } = await supabase.storage.from(OT_FOTOS_BUCKET).upload(filename, buffer, {
        contentType: finalMime, cacheControl: '604800', upsert: false,
      })
      if (upErr) {
        console.error('[OT FOTO UPLOAD]', upErr.message)
        return res.status(502).json({ error: `Error al subir: ${upErr.message}` })
      }
      const { data: pub } = supabase.storage.from(OT_FOTOS_BUCKET).getPublicUrl(filename)

      // Validar lat/lng como strings cortas (mismo schema que /fotos JSON)
      const latitud  = req.body?.latitud  ? String(req.body.latitud).slice(0, 30)  : null
      const longitud = req.body?.longitud ? String(req.body.longitud).slice(0, 30) : null
      const descripcion = req.body?.descripcion ? String(req.body.descripcion).slice(0, 200) : null

      const foto = await prisma.ordenFoto.create({
        data: {
          ordenId:     ot.id,
          url:         pub?.publicUrl ?? '',
          latitud, longitud, descripcion,
          subidoPor:   req.user?.sub ?? null,
        },
        include: { empleado: { select: { id: true, nombre: true } } },
      })
      auditReq('ot:foto_upload_v2', req, { ordenId: ot.id, fotoId: foto.id, gps: !!latitud })
      res.status(201).json(foto)
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' })
      console.error('[OT FOTO UPLOAD]', e.message)
      res.status(500).json({ error: 'Error interno.' })
    }
  }
)

router.post('/ordenes/:id/fotos', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

router.delete('/ordenes/:ordenId/fotos/:fotoId', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

// ─── Catálogo público (sin precio para anti-scraping) ─────────────────────────

const catalogoPublicoLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
router.get('/catalogo-publico', catalogoPublicoLimiter, async (req, res) => {
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

router.get('/portal/catalogo', verificarPortalJWT, async (req, res) => {
  try {
    const items = await prisma.itemCatalogo.findMany({
      where: { activo: true, tipoItem: 'SERVICIO', categoria: { not: 'WISP' } },
      select: { id: true, nombre: true, descripcion: true, categoria: true, tipo: true, precio: true },
      orderBy: { categoria: 'asc' },
    })
    res.json({ data: items.map(i => ({ ...i, precio: Number(i.precio) })) })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})



  return router;
}

module.exports = createVentasRouter;
