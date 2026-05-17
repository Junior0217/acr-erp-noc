/**
 * backend/modules/admin/reportes/router.js
 *
 * Auto-extraido de routes/admin.js (Stage 4 DDD split).
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


function createReportesRouter(deps) {
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
  } = deps;
  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTP, requerirTOTPEstricto, vaultCooldownGuard,
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
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) =================================
// ─── Dashboard (KPIs) ─────────────────────────────────────────────────────────

// POOL NOTE FOR CTO: Supabase session-mode PgBouncer limits connections per session.
// Add to your .env to cap Prisma's pool and prevent EMAXCONNSESSION:
//   DATABASE_URL="postgresql://...?connection_limit=5&pool_timeout=10&pgbouncer=true"
// connection_limit=5  → Prisma opens at most 5 simultaneous DB connections
// pool_timeout=10     → queries wait up to 10s for a free slot before failing
// pgbouncer=true      → disables Prisma's session-level prepared statements (required for PgBouncer)

router.get('/dashboard', verificarJWT, async (req, res) => {
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


// ─── Reportes ─────────────────────────────────────────────────────────────────

router.get('/reportes/semanal', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const ahora     = new Date();
    const inicioDia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    const inicioSemana = new Date(inicioDia);
    inicioSemana.setDate(inicioDia.getDate() - 6);

    const [facturas, ots, facturasMes] = await Promise.all([
      prisma.factura.findMany({
        where:   { esCotizacion: false, deletedAt: null, estado: 'Pagada', fechaEmision: { gte: inicioSemana } },
        select:  { total: true, fechaEmision: true, lineas: { select: { itemCatalogo: { select: { tipoItem: true, nombre: true } } } } },
      }),
      prisma.ordenTrabajo.findMany({
        where:   { deletedAt: null, estado: 'Cerrada', updatedAt: { gte: inicioSemana } },
        select:  { id: true, noOT: true, tipoOT: true, updatedAt: true, tecnico: { select: { id: true, nombre: true } } },
      }),
      prisma.factura.findMany({
        where:   { esCotizacion: false, deletedAt: null, estado: 'Pagada',
                   fechaEmision: { gte: new Date(ahora.getFullYear(), ahora.getMonth(), 1) } },
        select:  { total: true },
      }),
    ]);

    const ingresosPorCategoria = {};
    let totalSemana = 0;
    for (const f of facturas) {
      const monto = Number(f.total);
      totalSemana += monto;
      const tipos = [...new Set(f.lineas.map(l => l.itemCatalogo?.tipoItem).filter(Boolean))];
      const cat = tipos.length > 0 ? tipos[0] : 'Otro';
      ingresosPorCategoria[cat] = (ingresosPorCategoria[cat] ?? 0) + monto;
    }

    const ingresoPorDia = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(inicioSemana);
      d.setDate(d.getDate() + i);
      ingresoPorDia[d.toISOString().slice(0, 10)] = 0;
    }
    for (const f of facturas) {
      const key = new Date(f.fechaEmision).toISOString().slice(0, 10);
      if (key in ingresoPorDia) ingresoPorDia[key] += Number(f.total);
    }

    res.json({
      semana:     { inicio: inicioSemana, fin: ahora },
      totalSemana,
      totalMes:   facturasMes.reduce((s, f) => s + Number(f.total), 0),
      ingresosPorCategoria,
      ingresoPorDia,
      otsCerradas: ots.length,
      otsDetalle:  ots.map(o => ({ id: o.id, noOT: o.noOT, tipoOT: o.tipoOT, updatedAt: o.updatedAt, tecnicoNombre: o.tecnico?.nombre ?? null })),
    });
  } catch (e) {
    console.error('[REPORTE SEMANAL]', e.message, e.stack);
    // Never explode the frontend: return safe empty shape on backend errors
    res.json({
      semana:               { inicio: null, fin: null },
      totalSemana:          0,
      totalMes:             0,
      ingresosPorCategoria: {},
      ingresoPorDia:        {},
      otsCerradas:          0,
      otsDetalle:           [],
      _error:               'Datos incompletos. Reintenta en unos segundos.',
    });
  }
});

router.get('/reportes/comisiones', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const year  = parseInt(anio)  || new Date().getFullYear();
    const month = parseInt(mes)   || new Date().getMonth() + 1;
    const inicio = new Date(year, month - 1, 1);
    const fin    = new Date(year, month,     1);

    const ots = await prisma.ordenTrabajo.findMany({
      where:   {
        deletedAt: null,
        estado:    'Cerrada',
        tecnicoId: { not: null },
        tipoOT:    { in: ['Reparacion', 'Instalacion', 'CCTV'] },
        updatedAt: { gte: inicio, lt: fin },
      },
      select: {
        id: true, noOT: true, tipoOT: true, updatedAt: true,
        tecnico:  { select: { id: true, nombre: true } },
        facturas: { select: { total: true, estado: true }, take: 1 },
      },
    });

    const TASA = { Reparacion: 0.10, Instalacion: 0.08, CCTV: 0.10 };

    const porTecnico = {};
    for (const ot of ots) {
      const fact = (ot.facturas || [])[0];
      const total  = Number(fact?.total ?? 0);
      const tasa   = TASA[ot.tipoOT] ?? 0.08;
      const comision = total * tasa;
      const nombre = ot.tecnico?.nombre ?? 'Desconocido';
      if (!porTecnico[nombre]) porTecnico[nombre] = { nombre, ots: 0, totalFacturado: 0, comisionTotal: 0, detalle: [] };
      porTecnico[nombre].ots++;
      porTecnico[nombre].totalFacturado += total;
      porTecnico[nombre].comisionTotal  += comision;
      porTecnico[nombre].detalle.push({ noOT: ot.noOT, tipoOT: ot.tipoOT, total, tasa, comision, fecha: ot.updatedAt });
    }

    res.json({
      periodo:   { mes: month, anio: year },
      tecnicos:  Object.values(porTecnico).sort((a, b) => b.comisionTotal - a.comisionTotal),
      totalComisiones: Object.values(porTecnico).reduce((s, t) => s + t.comisionTotal, 0),
    });
  } catch (e) {
    console.error('[REPORTE COMISIONES]', e.message, e.stack);
    res.json({ periodo: { mes: null, anio: null }, tecnicos: [], totalComisiones: 0, _error: 'Datos incompletos.' });
  }
});




  return router;
}

module.exports = createReportesRouter;
