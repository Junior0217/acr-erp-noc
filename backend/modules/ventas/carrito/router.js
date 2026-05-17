/**
 * backend/modules/ventas/carrito/router.js
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

function createCarritoRouter(deps) {
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




  return router;
}

module.exports = createCarritoRouter;
