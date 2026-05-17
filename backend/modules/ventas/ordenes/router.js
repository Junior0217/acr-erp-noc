/**
 * backend/modules/ventas/ordenes/router.js
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

function createOrdenesRouter(deps) {
  const router = express.Router();

  const {
    prisma, auditReq, middlewares = {}, schemas = {}, helpers = {}, limiters = {},
    completarLogin, twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
    generarSiguienteCodigo, generarPdfDeFactura, buildPdfData, subirPdfAlStorage,
    invalidarPdfCache, renderPdfDoc, generarPdfDocumento, persistirVerifyHash,
    facturaVerifyHash, PUBLIC_VERIFY_BASE, emailTransporter, sendFacturaPDF,
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt,
    supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
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




  return router;
}

module.exports = createOrdenesRouter;
