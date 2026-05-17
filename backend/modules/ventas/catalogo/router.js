/**
 * backend/modules/ventas/catalogo/router.js
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

function createCatalogoRouter(deps) {
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
    checkoutLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) ==================================
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

module.exports = createCatalogoRouter;
