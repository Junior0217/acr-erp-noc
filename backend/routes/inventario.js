/**
 * backend/routes/inventario.js
 *
 * Inventario router: categorías, productos, movimientos (kardex). Más rutas
 * (prestamos, upload imágenes) se migrarán por fases.
 */

const express = require('express');
const { z } = require('zod');

function createInventarioRouter(deps) {
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
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt,
    supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, OT_FOTOS_BUCKET,
    KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
    detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
    generarPin, storeResetToken, consumeResetToken,
    signPortalToken, setPortalCookie, getOrCreatePortalSettings,
    NIVEL_PROPIETARIO_ABSOLUTO, requerirTOTP, protegerPropietario,
    SECUENCIA_DEFAULTS,
  } = deps;

  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTPEstricto, vaultCooldownGuard,
  } = middlewares;

  const {
    passwordSchema, empleadoSchema, empleadoUpdateSchema, asistenciaSchema,
    clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema,
    prospectoSchema, prospectoUpdateSchema, portalRegisterSchema, portalLoginSchema,
    credencialSchema, activoSchema, ticketTallerSchema,
    ticketEstadoSchema, ordenFotoSchema, timelineEventoSchema, checkoutSchema,
    azulWebhookSchema,
  } = schemas;

  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, getClientIp,
    reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
  } = helpers;

  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // ─── Existing handlers ───────────────────────────────────────────
  router.get('/categorias', async (req, res) => {
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

  router.post('/categorias', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    try {
      const data = categoriaSchema.parse(req.body);
      const cat = await prisma.categoria.create({ data, include: { _count: { select: { productos: true } } } });
      res.status(201).json(cat);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  router.put('/categorias/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
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

  router.delete('/categorias/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
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

  // ─── Productos ────────────────────────────────────────────────────────────
  router.get('/productos', async (req, res) => {
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

  router.post('/productos', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    try {
      const data = productoSchema.parse(req.body);
      if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion);
      const producto = await prisma.$transaction(async (tx) => {
        if (!data.sku) data.sku = await generarSiguienteCodigo('producto', tx);
        return tx.producto.create({
          data, include: { categoria: { select: { id: true, nombre: true } } },
        });
      });
      res.status(201).json(formatProducto(producto));
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un producto con ese SKU.' });
      if (e.code === 'P2003') return res.status(400).json({ error: 'Categoría no válida.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  router.put('/productos/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      const data = productoUpdateSchema.parse(req.body);
      if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion);
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

  router.delete('/productos/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
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

  // ─── Movimientos (Kardex) ─────────────────────────────────────────────────
  router.get('/movimientos', async (req, res) => {
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

  // ─── Migrated from monolith ──────────────────────────────────────
// ─── MSP: Préstamos de Equipos ────────────────────────────────────────────────

const prestamoSchema = z.object({
  clienteId:  z.string().uuid(),
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().min(1).default(1),
  diasLimite: z.number().int().min(1).max(180).default(15),
  notas:      z.string().max(500).optional().nullable(),
})

router.get('/prestamos', verificarJWT, requerirPermiso('ot:ver'), async (req, res) => {
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

router.post('/prestamos', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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

router.patch('/prestamos/:id/devolver', verificarJWT, requerirPermiso('ot:editar'), async (req, res) => {
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



  return router;
}

module.exports = createInventarioRouter;
