/**
 * backend/routes/admin.js
 *
 * Admin router: empleados, asistencia, mapa NOC, tracking público por PIN,
 * incidencias de reconciliación, admin sessions. Más rutas (roles, dashboard,
 * config, reportes, etc.) seguirán migrándose por fases.
 */

const express = require('express');

function makeRateLimitStore() { return undefined; }  // Stub: routers no comparten redisClient; el limiter cae al MemoryStore default.
const rateLimit = require('express-rate-limit');
const bcrypt  = require('bcryptjs');
const { z }   = require('zod');

function createAdminRouter(deps) {
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
    generarPin, signPortalToken, setPortalCookie, getOrCreatePortalSettings,
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
    prospectoSchema, prospectoUpdateSchema, portalRegisterSchema, portalLoginSchema,
    credencialSchema, activoSchema, prestamoSchema, ticketTallerSchema,
    ticketEstadoSchema, ordenFotoSchema, timelineEventoSchema, checkoutSchema,
    azulWebhookSchema,
  } = schemas;

  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
  } = helpers;

  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // ─── Existing handlers ───────────────────────────────────────────
  router.get('/admin/sessions', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
    try {
      const sessions = await prisma.sessionToken.findMany({
        where: { expiresAt: { gt: new Date() } },
        select: {
          jti: true, userAgent: true, createdAt: true, expiresAt: true, ip: true,
          empleado: { select: { id: true, nombre: true, cargo: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ data: sessions, current: req.user.jti });
    } catch { res.status(500).json({ error: 'Error obteniendo sesiones.' }); }
  });

  router.delete('/admin/sessions/token/:jti', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
    const { jti } = req.params;
    try {
      const session = await prisma.sessionToken.findUnique({ where: { jti }, include: { empleado: { select: { id: true } } } });
      if (!session) return res.status(404).json({ error: 'Sesión no encontrada.' });
      if (session.jti === req.user.jti) return res.status(400).json({ error: 'Usa /logout para cerrar tu propia sesión.' });
      await prisma.sessionToken.delete({ where: { jti } });
      auditReq('auth:session_force_revoked', req, { jti, targetEmpleadoId: session.empleado.id });
      res.status(204).end();
    } catch { res.status(500).json({ error: 'Error cerrando sesión.' }); }
  });

  // ─── Empleados ────────────────────────────────────────────────────────────
  router.post('/empleados', verificarJWT, requerirPermiso('rrhh:editar'), async (req, res) => {
    try {
      const { roleIds, password, ...data } = empleadoSchema.parse(req.body);
      const passwordHash = await bcrypt.hash(password, 12);
      let cargo = 'Técnico';
      if (roleIds.length) {
        const roles = await prisma.rol.findMany({ where: { id: { in: roleIds } }, select: { nombre: true, nivel: true }, orderBy: { nivel: 'desc' } });
        if (roles.length) cargo = roles[0].nombre;
      }
      const e = await prisma.empleado.create({
        data: { ...data, cargo, passwordHash, roles: { connect: roleIds.map(id => ({ id })) } },
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

  router.get('/empleados', verificarJWT, async (req, res) => {
    try {
      const { search } = req.query;
      const where = { deletedAt: null };
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

  router.put('/empleados/:id', verificarJWT, requerirPermiso('rrhh:editar'), protegerPropietario, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      const { roleIds, password, ...data } = empleadoUpdateSchema.parse(req.body);
      const updateData = { ...data };
      if (password) updateData.passwordHash = await bcrypt.hash(password, 12);
      if (roleIds !== undefined) {
        updateData.roles = { set: roleIds.map(rid => ({ id: rid })) };
        if (roleIds.length) {
          const roles = await prisma.rol.findMany({ where: { id: { in: roleIds } }, select: { nombre: true, nivel: true }, orderBy: { nivel: 'desc' } });
          if (roles.length) updateData.cargo = roles[0].nombre;
        }
      }
      const e = await prisma.empleado.update({
        where: { id }, data: updateData,
        select: { id: true, nombre: true, cargo: true, email: true, bloqueado: true, creadoEn: true, roles: { select: { id: true, nombre: true } } },
      });
      res.json(e);
    } catch (e) {
      if (e instanceof z.ZodError) {
        console.error('[ZOD ERROR RRHH]', e.errors);
        return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors });
      }
      if (e.code === 'P2025') return res.status(404).json({ error: 'Empleado no encontrado.' });
      if (e.code === 'P2002') return res.status(409).json({ error: 'El email ya está registrado.' });
      console.error('[EMPLEADO PUT ERROR]', e.message);
      res.status(500).json({ error: 'Error al actualizar empleado.' });
    }
  });

  router.delete('/empleados/:id', verificarJWT, protegerPropietario, requerirTOTP, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      await prisma.empleado.update({ where: { id }, data: { deletedAt: new Date() } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Empleado no encontrado.' });
      res.status(500).json({ error: 'Error al eliminar empleado.' });
    }
  });

  // ─── Asistencia ───────────────────────────────────────────────────────────
  function puedeGestionarAsistencia(req) {
    const perms = Array.isArray(req.user?.permisos) ? req.user.permisos : [];
    return perms.includes('sistema:owner') || perms.includes('rrhh:asistencia');
  }

  router.get('/asistencia', verificarJWT, async (req, res) => {
    try {
      const { empleadoId, mes, anio } = req.query;
      const where = {};
      if (!puedeGestionarAsistencia(req)) {
        where.empleadoId = req.user.sub;
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

  const ASISTENCIA_COOLDOWN_MS = 2 * 60 * 1000;

  router.post('/asistencia', verificarJWT, async (req, res) => {
    try {
      const data = asistenciaSchema.parse(req.body);
      if (!puedeGestionarAsistencia(req) && data.empleadoId !== req.user.sub) {
        return res.status(403).json({ error: 'Solo puedes registrar tu propia asistencia.' });
      }

      const ultima = await prisma.asistencia.findFirst({
        where:   { empleadoId: data.empleadoId },
        orderBy: { fechaHora: 'desc' },
      });
      if (ultima) {
        const elapsedMs = Date.now() - new Date(ultima.fechaHora).getTime();
        if (elapsedMs < ASISTENCIA_COOLDOWN_MS) {
          const restante = Math.ceil((ASISTENCIA_COOLDOWN_MS - elapsedMs) / 1000);
          return res.status(429).json({
            error: `Espera ${restante}s antes de registrar otra asistencia.`,
            code:  'ASISTENCIA_COOLDOWN',
          });
        }
        if (ultima.tipo === data.tipo) {
          return res.status(409).json({
            error: `No puedes registrar ${data.tipo} consecutiva. Falta registrar ${data.tipo === 'Entrada' ? 'Salida' : 'Entrada'} anterior.`,
            code:  'ASISTENCIA_TRANSICION_INVALIDA',
            ultimaEn: ultima.fechaHora,
          });
        }
      } else if (data.tipo === 'Salida') {
        return res.status(409).json({
          error: 'No existe Entrada previa para registrar Salida.',
          code:  'ASISTENCIA_SIN_ENTRADA',
        });
      }

      if (data.tipo === 'Entrada') {
        const hoy = new Date();
        const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
        const finDia    = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
        const yaEntrada = await prisma.asistencia.findFirst({
          where: { empleadoId: data.empleadoId, tipo: 'Entrada', fechaHora: { gte: inicioDia, lt: finDia } },
        });
        if (yaEntrada) return res.status(409).json({ error: 'Ya existe una Entrada registrada hoy para este empleado.' });
      }
      const registro = await prisma.asistencia.create({
        data: {
          empleadoId: data.empleadoId,
          tipo:       data.tipo,
          ...(data.latitud  != null && { latitud:  data.latitud }),
          ...(data.longitud != null && { longitud: data.longitud }),
        },
        include: { empleado: { select: { id: true, nombre: true } } },
      });
      res.status(201).json(registro);
    } catch (e) {
      if (e.code === 'P2003') return res.status(400).json({ error: 'Empleado no encontrado.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  // ─── Mapa NOC ─────────────────────────────────────────────────────────────
  router.get('/mapa-noc', async (req, res) => {
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
          lat, lng,
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
    } catch {
      res.status(500).json({ error: 'Error al obtener mapa NOC' });
    }
  });

  // ─── Incidencias de reconciliación ────────────────────────────────────────
  router.get('/incidencias', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
    try {
      const { tipo, severidad, resueltas } = req.query;
      const where = {};
      if (tipo)      where.tipo      = tipo;
      if (severidad) where.severidad = severidad;
      if (resueltas === 'true')  where.resueltoEn = { not: null };
      if (resueltas === 'false') where.resueltoEn = null;
      const data = await prisma.incidenciaReconciliacion.findMany({
        where,
        orderBy: [{ resueltoEn: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        include: { empleado: { select: { id: true, nombre: true } } },
      });
      res.json({ data });
    } catch { res.json({ data: [], _error: 'Error obteniendo incidencias' }); }
  });

  router.patch('/incidencias/:id/resolver', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    const { resolucion } = z.object({ resolucion: z.string().min(3).max(500) }).parse(req.body);
    try {
      const inc = await prisma.incidenciaReconciliacion.update({
        where: { id },
        data:  { resueltoEn: new Date(), resolucion, asignadoA: req.user.sub },
      });
      auditReq('reconciliacion:resolver', req, { incidenciaId: id });
      res.json(inc);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Incidencia no encontrada.' });
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // ─── Migrated from monolith ──────────────────────────────────────
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

// ─── Admin: Permisos y Sesiones ───────────────────────────────────────────────

router.get('/admin/empleados', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
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

router.patch('/admin/empleados/:id/roles', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
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
      const rolesToAssign = await prisma.rol.findMany({ where: { id: { in: roleIds } }, select: { id: true, nombre: true, permisos: true, nivel: true } })
      for (const rol of rolesToAssign) {
        const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : []
        const escalated = rolPerms.find(p => !callerPerms.has(p))
        if (escalated) return res.status(403).json({ error: `No puedes asignar el rol "${rol.nombre}": contiene permiso "${escalated}" que tú no posees.` })
      }
      // nivel check: cannot assign a role with nivel >= own nivelMax
      const callerRoles = await prisma.rol.findMany({ where: { empleados: { some: { id: req.user.sub } }, activo: true }, select: { nivel: true } })
      const callerNivel = callerRoles.length ? Math.max(...callerRoles.map(r => r.nivel ?? 0)) : 0
      for (const rol of rolesToAssign) {
        if ((rol.nivel ?? 0) >= callerNivel) {
          return res.status(403).json({ error: `No puedes asignar el rol "${rol.nombre}" (nivel ${rol.nivel}): tu nivel máximo es ${callerNivel}.` })
        }
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

router.patch('/admin/empleados/:id/permisos-extra', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
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
  nivel:       z.number().int().min(0).max(100).optional().default(0),
  require2FA:  z.boolean().optional().default(false),
});
const rolUpdateSchema = rolSchema.partial();

router.get('/roles', verificarJWT, async (req, res) => {
  try {
    const roles = await prisma.rol.findMany({
      select: {
        id:          true,
        nombre:      true,
        descripcion: true,
        permisos:    true,
        activo:      true,
        nivel:       true,
        require2FA:  true,
        createdAt:   true,
        updatedAt:   true,
        _count:      { select: { empleados: true } },
      },
      orderBy: { nombre: 'asc' },
    });
    res.json({ data: roles });
  } catch { res.status(500).json({ error: 'Error al obtener roles.' }); }
});

async function requerirTOTP(req, res, next) {
  try {
    const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorEnabled: true, twoFactorSecret: true } })
    if (!emp?.twoFactorEnabled) return next()
    const code = req.headers['x-totp'] || req.body?.totp
    if (!code) return res.status(403).json({ error: 'Esta acción destructiva requiere tu código TOTP de 2FA.' })
    const secret = decryptTOTP(emp.twoFactorSecret)
    if (!authenticator.verify({ token: String(code), secret })) return res.status(401).json({ error: 'Código TOTP inválido o expirado.' })
    next()
  } catch { next() }
}

async function callerNivelMax(userId) {
  const roles = await prisma.rol.findMany({ where: { empleados: { some: { id: userId } }, activo: true }, select: { nivel: true } });
  return roles.length ? Math.max(...roles.map(r => r.nivel ?? 0)) : 0;
}

router.post('/roles', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  try {
    const data = rolSchema.parse(req.body);
    if (!req.user.permisos?.includes('sistema:owner')) {
      const myNivel = await callerNivelMax(req.user.sub);
      if ((data.nivel ?? 0) >= myNivel)
        return res.status(403).json({ error: `No puedes crear un rol con nivel ${data.nivel}: tu nivel máximo es ${myNivel}.` });
    }
    const rol  = await prisma.rol.create({ data, include: { _count: { select: { empleados: true } } } });
    auditReq('admin:rol_creado', req, { rolId: rol.id, nombre: rol.nombre });
    res.status(201).json(rol);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un rol con ese nombre.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

router.put('/roles/:id', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const existing = await prisma.rol.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rol no encontrado.' });
    const existingPerms = Array.isArray(existing.permisos) ? existing.permisos : [];
    if (existingPerms.includes('sistema:owner') && !req.user?.permisos?.includes('sistema:owner'))
      return res.status(403).json({ error: 'El rol Owner solo puede ser modificado por el propietario del sistema.' });
    const data = rolUpdateSchema.parse(req.body);
    if (!req.user.permisos?.includes('sistema:owner') && data.nivel !== undefined) {
      const myNivel = await callerNivelMax(req.user.sub);
      if (data.nivel >= myNivel)
        return res.status(403).json({ error: `No puedes asignar nivel ${data.nivel}: tu nivel máximo es ${myNivel}.` });
    }
    const newPerms = Array.isArray(data.permisos) ? data.permisos : [];
    if (existingPerms.includes('sistema:owner') && !newPerms.includes('sistema:owner'))
      return res.status(403).json({ error: 'No se puede remover sistema:owner del rol Owner.' });
    const rol = await prisma.rol.update({ where: { id }, data, include: { _count: { select: { empleados: true } } } });
    auditReq('admin:rol_actualizado', req, { rolId: id });
    res.json(rol);
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Rol no encontrado.' });
    if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un rol con ese nombre.' });
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
    res.status(400).json({ error: 'Datos inválidos.' });
  }
});

router.delete('/roles/:id', verificarJWT, requerirPermiso('sistema:admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    const rol = await prisma.rol.findUnique({ where: { id }, include: { _count: { select: { empleados: true } } } });
    if (!rol) return res.status(404).json({ error: 'Rol no encontrado.' });
    const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : [];
    if (rolPerms.includes('sistema:owner'))
      return res.status(403).json({ error: 'El rol Owner es inmutable y no puede eliminarse.' });
    if (rol._count.empleados > 0) return res.status(409).json({ error: `No se puede eliminar: ${rol._count.empleados} usuario(s) tienen este rol asignado.` });
    await prisma.rol.delete({ where: { id } });
    auditReq('admin:rol_eliminado', req, { rolId: id, nombre: rol.nombre });
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Rol no encontrado.' });
    res.status(500).json({ error: 'Error al eliminar rol.' });
  }
});

router.patch('/admin/empleados/:id/password', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
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

router.patch('/admin/empleados/:id/bloquear', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
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

router.delete('/admin/sessions/:empleadoId', verificarJWT, requerirPermiso('sistema:admin'), protegerPropietario, async (req, res) => {
  const empleadoId = parseInt(req.params.empleadoId);
  if (!empleadoId || empleadoId < 1) return res.status(400).json({ error: 'ID inválido.' });
  try {
    await prisma.sessionToken.deleteMany({ where: { empleadoId } });
    auditReq('admin:sessions_killed', req, { targetId: empleadoId });
    res.status(204).end();
  } catch { res.status(500).json({ error: 'Error al cerrar sesiones.' }); }
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

// ─── Anti brute-force: in-memory tally + DB-persisted IpBlock ────────────────

const TRACK_FAIL_WINDOW_MS  = 5  * 60 * 1000      // 5 min sliding window
const TRACK_FAIL_THRESHOLD  = 5                   // 5 failures triggers block
const TRACK_BLOCK_DURATION  = 30 * 60 * 1000      // 30 min block

const failTally    = new Map()  // ip -> { count, firstFail }
const activeBlocks = new Map()  // ip -> expiresAt(ms)

async function hydrateIpBlocks() {
  try {
    const blocks = await prisma.ipBlock.findMany({ where: { expiraEn: { gt: new Date() } } })
    for (const b of blocks) activeBlocks.set(b.ip, b.expiraEn.getTime())
    console.log(`[IpBlock] hydrated ${blocks.length} active block(s)`)
  } catch (e) { console.error('[IpBlock hydrate]', e.message) }
}
hydrateIpBlocks()

function getClientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
       || req.socket?.remoteAddress
       || 'unknown').replace(/^::ffff:/, '')
}

function isIpBlocked(ip) {
  const exp = activeBlocks.get(ip)
  if (!exp) return false
  if (exp < Date.now()) { activeBlocks.delete(ip); return false }
  return true
}

async function registerTrackFailure(ip, motivo) {
  const now = Date.now()
  const entry = failTally.get(ip)
  if (!entry || (now - entry.firstFail) > TRACK_FAIL_WINDOW_MS) {
    failTally.set(ip, { count: 1, firstFail: now })
    return false
  }
  entry.count++
  if (entry.count >= TRACK_FAIL_THRESHOLD) {
    failTally.delete(ip)
    const expiraEn = new Date(now + TRACK_BLOCK_DURATION)
    activeBlocks.set(ip, expiraEn.getTime())
    try {
      await prisma.ipBlock.create({ data: { ip, motivo, intentos: TRACK_FAIL_THRESHOLD, expiraEn } })
      auditReq('security:ip_block', { headers: {}, socket: { remoteAddress: ip }, originalUrl: '/track' }, { ip, motivo, hasta: expiraEn })
    } catch (e) { console.error('[IpBlock persist]', e.message) }
    return true
  }
  return false
}

const trackingLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
router.get('/track/:pin', trackingLimiter, async (req, res) => {
  const ip = getClientIp(req)
  if (isIpBlocked(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. IP bloqueada temporalmente.' })
  }
  const pinRaw = (req.params.pin || '').toUpperCase()
  if (!/^[A-Z2-9]{6}$/.test(pinRaw)) {
    await registerTrackFailure(ip, 'PIN formato inválido')
    return res.status(400).json({ error: 'PIN inválido.' })
  }
  try {
    const t = await prisma.ticketTaller.findUnique({
      where:  { codigoPin: pinRaw },
      select: {
        noTicket: true, equipo: true, marca: true, modelo: true, estado: true,
        recibidoEn: true, diagnosticadoEn: true, listoEn: true, entregadoEn: true,
        diagnostico: true, costoEstimado: true,
        cliente: { select: { razonSocial: true } },
      },
    })
    if (!t) {
      await registerTrackFailure(ip, 'PIN no encontrado')
      return res.status(404).json({ error: 'Ticket no encontrado.' })
    }
    res.json(t)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// ─── Offboarding de empleados ─────────────────────────────────────────────────

router.post('/empleados/:id/offboard', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  const empleadoId = parseInt(req.params.id)
  if (!empleadoId) return res.status(400).json({ error: 'ID inválido.' })
  if (empleadoId === req.user.sub) return res.status(409).json({ error: 'No puedes desactivarte a ti mismo.' })
  try {
    const result = await prisma.$transaction(async (tx) => {
      const emp = await tx.empleado.findUnique({ where: { id: empleadoId }, select: { id: true, nombre: true, bloqueado: true } })
      if (!emp) throw Object.assign(new Error('Empleado no encontrado.'), { status: 404 })

      // 1. Bloquear y soft-delete
      await tx.empleado.update({
        where: { id: empleadoId },
        data:  { bloqueado: true, deletedAt: new Date() },
      })

      // 2. Revocar TODAS las sesiones activas
      const sessionsDeleted = await tx.sessionToken.deleteMany({ where: { empleadoId } })

      // 3. Limpiar carrito temporal
      await tx.carritoTemp.deleteMany({ where: { empleadoId } })

      // 4. Liberar OTs pendientes/en proceso (unassign + flag huérfana)
      const otsActivas = await tx.ordenTrabajo.findMany({
        where:  { tecnicoId: empleadoId, estado: { in: ['Pendiente', 'EnProceso'] }, deletedAt: null },
        select: { id: true, noOT: true, metadatos: true },
      })
      for (const ot of otsActivas) {
        await tx.ordenTrabajo.update({
          where: { id: ot.id },
          data:  {
            tecnicoId: null,
            metadatos: { ...(ot.metadatos ?? {}), huerfana: true, motivo: 'offboarding', ofrecidaPor: empleadoId, marcadaEn: new Date().toISOString() },
          },
        })
      }

      // 5. Liberar tickets de taller pendientes
      const ticketsActivos = await tx.ticketTaller.updateMany({
        where: { tecnicoId: empleadoId, estado: { in: ['Recibido', 'Diagnostico', 'EsperandoPieza'] } },
        data:  { tecnicoId: null },
      })

      return {
        empleado: emp,
        sessionsRevocadas: sessionsDeleted.count,
        otsLiberadas:      otsActivas.length,
        otsHuerfanas:      otsActivas.map(o => o.noOT),
        ticketsLiberados:  ticketsActivos.count,
      }
    })

    auditReq('rrhh:offboard', req, result)
    res.json(result)
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message })
    console.error('[OFFBOARD]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── API Dictionary: endpoint meta / introspección ────────────────────────────

// Mapping path -> módulo de negocio (NO refactor de URLs, solo agrupación lógica)
const MODULE_MAP = [
  { test: /^\/api\/_meta/,                                    modulo: 'Sistema',         emoji: '⚙️' },
  { test: /^\/api\/health/,                                   modulo: 'Sistema',         emoji: '⚙️' },
  { test: /^\/api\/auth\//,                                   modulo: 'Autenticación',   emoji: '🔐' },
  { test: /^\/api\/incidencias/,                              modulo: 'Seguridad',       emoji: '🛡️' },
  { test: /^\/api\/credenciales/,                             modulo: 'Seguridad (Vault)', emoji: '🔑' },
  { test: /^\/api\/empleados/,                                modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/asistencia/,                               modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/roles/,                                    modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/clientes/,                                 modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/suplidores/,                               modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/prospectos/,                               modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/usuarios-portal/,                          modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/(productos|categorias|inventario|kardex)/, modulo: 'Inventario',      emoji: '📦' },
  { test: /^\/api\/prestamos/,                                modulo: 'Inventario',      emoji: '📦' },
  { test: /^\/api\/(items-catalogo|catalogo)/,                modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/(facturas|cotizaciones|cotizacion|ncf)/,   modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/ordenes/,                                  modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/(servicios|planes|plantillas)/,            modulo: 'Servicios',       emoji: '🛠️' },
  { test: /^\/api\/taller/,                                   modulo: 'Taller (RMA)',    emoji: '🔧' },
  { test: /^\/api\/track/,                                    modulo: 'Tracking Público',emoji: '📍' },
  { test: /^\/api\/activos-cliente/,                          modulo: 'CMDB',            emoji: '🗂️' },
  { test: /^\/api\/reportes/,                                 modulo: 'Reportes',        emoji: '📊' },
  { test: /^\/api\/dashboard/,                                modulo: 'Dashboard',       emoji: '📈' },
  { test: /^\/api\/mapa-noc/,                                 modulo: 'NOC / Mapa',      emoji: '🗺️' },
  { test: /^\/api\/portal\/(auth|sos|dashboard|cotizacion|catalogo|checkout|settings|facturas)/, modulo: 'Portal B2C', emoji: '🌐' },
  { test: /^\/api\/webhooks/,                                 modulo: 'Webhooks',        emoji: '🪝' },
  { test: /^\/api\/carrito/,                                  modulo: 'Ventas',          emoji: '💼' },
]
function resolveModule(path) {
  for (const m of MODULE_MAP) if (m.test.test(path)) return { modulo: m.modulo, emoji: m.emoji }
  return { modulo: 'Otros', emoji: '❓' }
}

// Express 5.x: usa app.router (NO app._router). Robusto contra middlewares anidados.
function _scanRoutes(app) {
  const out = []
  const router = app.router ?? app._router // Express 5 vs 4 compat
  if (!router || !Array.isArray(router.stack)) return out

  function walk(stack, basePath = '') {
    for (const layer of stack) {
      try {
        if (layer.route) {
          // Express 5: route.path puede ser string, array de strings, o RegExp
          let pathStr = layer.route.path
          if (Array.isArray(pathStr)) pathStr = pathStr[0]
          if (pathStr instanceof RegExp) pathStr = pathStr.toString()
          if (typeof pathStr !== 'string') pathStr = String(pathStr ?? '')
          const path = basePath + pathStr
          const methodsObj = layer.route.methods || {}
          const methods = Object.keys(methodsObj).filter(m => methodsObj[m])
          for (const m of methods) {
            const handlerNames = (layer.route.stack || []).map(s => s?.name).filter(Boolean)
            const auth =
              handlerNames.includes('verificarJWT')          ? 'JWT'        :
              handlerNames.includes('verificarPortalJWT')    ? 'PortalJWT'  :
              handlerNames.some(h => /Limiter$/.test(h))     ? 'rate-limit' :
              'public'
            const permiso =
              handlerNames.find(h => h.startsWith('requerirPermiso')) ? 'role-restricted' : null
            const { modulo, emoji } = resolveModule(path)
            out.push({ method: m.toUpperCase(), path, modulo, emoji, auth, permiso })
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          walk(layer.handle.stack, basePath)
        }
      } catch (e) {
        console.error('[SCAN ROUTES] skip layer:', e.message)
      }
    }
  }
  walk(router.stack)
  return out
}

let _routesCache = null
router.get('/_meta/endpoints', verificarJWT, requerirPermiso('sistema:owner'), (req, res) => {
  try {
    if (!_routesCache || req.query.refresh === '1') {
      _routesCache = _scanRoutes(app)
        .filter(r => r.path.startsWith('/'))
        .sort((a, b) => a.modulo.localeCompare(b.modulo) || a.path.localeCompare(b.path))
    }
    const grouped = _routesCache.reduce((acc, r) => {
      const key = `${r.emoji} ${r.modulo}`
      ;(acc[key] = acc[key] || []).push(r)
      return acc
    }, {})
    res.json({
      total:     _routesCache.length,
      endpoints: _routesCache,
      grouped,
      modulos:   Object.keys(grouped).sort(),
      generadoEn: new Date(),
    })
  } catch (e) {
    console.error('[META ENDPOINTS]', e.message, e.stack)
    res.json({ total: 0, endpoints: [], grouped: {}, modulos: [], _error: 'Error escaneando rutas: ' + e.message })
  }
})

// ─── UsuarioPortal: Owner reset password (no revelar — bcrypt one-way) ───────

router.post('/usuarios-portal/:id/reset-password', verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const nuevoPassword = crypto.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + 'A1!'
    const hash = await bcrypt.hash(nuevoPassword, 12)
    const u = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { passwordHash: hash },
      select: { id: true, noUsuario: true, nombre: true, email: true },
    })
    auditReq('portal:password_reset_owner', req, { usuarioId: u.id, email: u.email })
    // Response devuelve el password temporal UNA VEZ (no se persiste en claro)
    res.json({ usuario: u, passwordTemporal: nuevoPassword, mensaje: 'Comparte este password con el cliente por canal seguro. Se mostrará una sola vez.' })
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' })
    console.error('[PORTAL RESET OWNER]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.post('/usuarios-portal/:id/bloquear', verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const u = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { activo: false },
      select: { id: true, activo: true },
    })
    auditReq('portal:bloquear_owner', req, { usuarioId: u.id })
    res.json(u)
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Verificación pública anti-tamper ─────────────────────────────────────────
// Genera el HMAC sobre cada factura activa y matchea el `:hash` que viene en el
// QR/link del PDF. NO valida contra una columna almacenada — el hash siempre
// se RECOMPUTA, así un PDF alterado revela inconsistencia (cambia el monto en
// Photoshop -> el hash mostrado ya no matchea con el real).
const verifyLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })

router.get('/publico/verify/:hash', verifyLimiter, async (req, res) => {
  try {
    const hash = String(req.params.hash || '').toLowerCase()
    if (!/^[a-f0-9]{24}$/.test(hash)) return res.status(400).json({ valid: false, error: 'Hash inválido.' })
    if (VERIFY_HASH_DEBUG) console.log(`[HASH verify-in] hash=${hash}`)

    // H4: lookup O(log n) por columna indexada verifyHash. Fallback al scan legacy
    // si la fila aún no tiene hash precomputado (facturas pre-H4 deployment).
    let match = await prisma.factura.findFirst({
      where:  { deletedAt: null, verifyHash: hash },
      select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
    })
    if (!match) {
      // Fallback expandido: facturas legacy sin verifyHash O con verifyHash
      // distinto (drift de normalización antes de cache-bust). Scan acotado.
      // Acepta ambos: rows sin hash (legacy puro) y rows con hash divergente
      // (post-cambio normalización) — recomputa y compara contra el hash entrante.
      const candidatos = await prisma.factura.findMany({
        where:  { deletedAt: null, OR: [{ verifyHash: null }, { verifyHash: { not: hash } }] },
        select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
        orderBy:{ fechaEmision: 'desc' },
        take:   20000,
      })
      match = candidatos.find(f => facturaVerifyHash(f, 'verify-scan') === hash) ?? null
      // Self-heal: backfill el hash en la primera consulta exitosa. Sobrescribe
      // cualquier verifyHash divergente para que el lookup O(log n) funcione
      // en el próximo scan sin caer al scan secuencial.
      if (match) {
        prisma.factura.update({ where: { id: match.id }, data: { verifyHash: hash } }).catch(() => {})
      }
    }
    const empresa = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { razonSocial: true, rnc: true } })
    if (!match) return res.status(404).json({ valid: false, error: 'Documento no encontrado o alterado.' })

    const cliente = await prisma.cliente.findUnique({ where: { id: match.clienteId }, select: { razonSocial: true } }).catch(() => null)
    res.json({
      valid:       true,
      tipo:        match.esCotizacion ? 'cotizacion' : 'factura',
      noFactura:   match.noFactura,
      ncf:         match.ncf,
      fechaEmision: match.fechaEmision,
      total:       Number(match.total),
      estado:      match.estado,
      cliente:     cliente?.razonSocial ?? null,
      empresa:     empresa ? { razonSocial: empresa.razonSocial, rnc: empresa.rnc } : null,
    })
  } catch (e) {
    console.error('[VERIFY]', e.code, e.message)
    res.status(500).json({ valid: false, error: 'Error interno.' })
  }
})

// Endpoint público para portal B2C (descarga su propia factura)
router.get('/portal/facturas/:id/pdf-v2', verificarPortalJWT, async (req, res) => {
  try {
    const fact = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { cliente: true, lineas: { include: { producto: { select: { sku: true, nombre: true } } } } },
    })
    if (!fact || fact.clienteId !== req.portalUser.clienteId) return res.status(404).json({ error: 'No encontrada.' })
    const data = await buildPdfData(fact)
    const html = renderPdfDoc({
      tipo:        fact.esCotizacion ? 'cotizacion' : 'factura',
      numero:      fact.noFactura,
      ...data,
    })
    const pdfBuf = await generarPdfDocumento(html)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${fact.noFactura}.pdf"`)
    res.end(pdfBuf)
  } catch (e) {
    console.error('[PDF PORTAL]', e.message)
    res.status(500).json({ error: 'Error generando PDF.' })
  }
})

// ─── EmpresaPerfil (Singleton ID=1) ──────────────────────────────────────────

// GET semi-público — campos de membrete + logos. Sin PII del representante.
const empresaPublicLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
router.get('/configuracion/empresa/publico', empresaPublicLimiter, async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: {
        rnc: true, razonSocial: true, nombreComercial: true, registroMercantil: true,
        direccion: true, sector: true, provincia: true, pais: true,
        telefono: true, email: true, website: true, assets: true, eslogan: true,
      },
    })
    if (!e) return res.status(404).json({ error: 'Perfil no inicializado.' })
    // Limpia el JSON de assets — sólo expone públicamente lo necesario para membrete:
    const safeAssets = {
      logoClaro:  e.assets?.logoClaro  ?? null,
      logoOscuro: e.assets?.logoOscuro ?? null,
    }
    res.json({ ...e, assets: safeAssets })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// GET autenticado — completo (incluye selloFisico, firmaGerente, PII representante)
router.get('/configuracion/empresa', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
    if (!e) return res.status(404).json({ error: 'Perfil no inicializado.' })
    res.json(e)
  } catch (err) {
    console.error('[GET /api/configuracion/empresa]', err.code, err.message, err.meta)
    res.status(500).json({ error: 'Error interno.', code: err.code ?? 'UNKNOWN' })
  }
})

// ─── Configurador secuencias (owner edita prefijos + actual + padding) ────────
router.get('/configuracion/secuencias', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { secuenciasConfig: true },
    })
    const config = (e?.secuenciasConfig && typeof e.secuenciasConfig === 'object') ? e.secuenciasConfig : {}
    // Merge defaults para que el frontend siempre reciba la lista completa, aunque
    // el owner solo haya configurado algunas entidades.
    const merged = {}
    for (const k of Object.keys(SECUENCIA_DEFAULTS)) {
      merged[k] = { ...SECUENCIA_DEFAULTS[k], ...(config[k] ?? {}) }
    }
    res.json({ secuencias: merged, defaults: SECUENCIA_DEFAULTS })
  } catch (e) {
    console.error('[GET secuencias]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

const secuenciaEntradaSchema = z.object({
  prefijo: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Solo mayúsculas y dígitos.'),
  actual:  z.coerce.number().int().min(0).max(99_999_999),
  padding: z.coerce.number().int().min(3).max(10),
})
const secuenciasPatchSchema = z.object({
  factura:    secuenciaEntradaSchema.optional(),
  cotizacion: secuenciaEntradaSchema.optional(),
  producto:   secuenciaEntradaSchema.optional(),
  servicio:   secuenciaEntradaSchema.optional(),
  cliente:    secuenciaEntradaSchema.optional(),
  rma:        secuenciaEntradaSchema.optional(),
  plan:       secuenciaEntradaSchema.optional(),
}).strict()

router.patch('/configuracion/secuencias', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const data = secuenciasPatchSchema.parse(req.body)
    const current = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { secuenciasConfig: true } })
    const baseConfig = (current?.secuenciasConfig && typeof current.secuenciasConfig === 'object') ? current.secuenciasConfig : {}
    const next = { ...baseConfig, ...data }
    await prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: { secuenciasConfig: next },
      create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig: next },
    })
    auditReq('empresa:secuencias_update', req, { entidades: Object.keys(data) })
    res.json({ secuencias: next })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[PATCH secuencias]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Endpoint de preview: muestra cómo lucirá el próximo código sin consumir secuencia.
router.get('/configuracion/secuencias/preview/:entidad', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const entidad = req.params.entidad
    const def = SECUENCIA_DEFAULTS[entidad]
    if (!def) return res.status(400).json({ error: 'Entidad desconocida.' })
    const e = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { secuenciasConfig: true } })
    const cfg = (e?.secuenciasConfig?.[entidad] ?? def)
    const next = Number(cfg.actual ?? def.actual) + 1
    res.json({ entidad, prefijo: cfg.prefijo, actual: cfg.actual, padding: cfg.padding, proximo: `${cfg.prefijo}-${String(next).padStart(cfg.padding, '0')}` })
  } catch (e) {
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Bulk migration de descripciones legacy -> formato estructurado v=1 ───────
// Endpoint de uso único (owner only). Recorre Producto + ItemCatalogo y, para
// cada fila cuya descripcion NO sea JSON v=1, aplica el parser primitivo:
//   linea 1  -> titulo (strip ** o # heading si aplica)
//   resto    -> bullets (strip prefijos -, *, •, ·, "1.")
// Idempotente: re-ejecutar no daña filas ya migradas (las salta).
function _parsearLegacyDescripcion(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Ya está en formato estructurado -> skip.
  if (trimmed.startsWith('{')) {
    try { const o = JSON.parse(trimmed); if (o?.v === 1) return null } catch {}
  }
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  let titulo = '', bullets = []
  const m = lines[0].match(/^\*\*(.+)\*\*\s*$/) || lines[0].match(/^#{1,6}\s+(.+)$/)
  if (m) { titulo = m[1].trim(); bullets = lines.slice(1) }
  else   { titulo = lines[0];    bullets = lines.slice(1) }
  bullets = bullets
    .map(l => l.replace(/^[-*•·]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map(b => b.slice(0, 200))
  return { v: 1, titulo: titulo.slice(0, 200), bullets }
}

router.post('/admin/migrar-descripciones', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  const t0 = Date.now()
  const stats = { producto: { total: 0, migrados: 0, skipped: 0, errores: 0 },
                  itemCatalogo: { total: 0, migrados: 0, skipped: 0, errores: 0 } }
  try {
    // PRODUCTOS
    const productos = await prisma.producto.findMany({
      where:  { descripcion: { not: null } },
      select: { id: true, descripcion: true },
    })
    stats.producto.total = productos.length
    for (const p of productos) {
      const parsed = _parsearLegacyDescripcion(p.descripcion)
      if (!parsed) { stats.producto.skipped++; continue }
      try {
        await prisma.producto.update({
          where: { id: p.id },
          data:  { descripcion: JSON.stringify(parsed) },
        })
        stats.producto.migrados++
      } catch (e) {
        console.error(`[MIGRACION] producto ${p.id}:`, e.message)
        stats.producto.errores++
      }
    }
    // ITEM CATALOGO
    const items = await prisma.itemCatalogo.findMany({
      where:  { descripcion: { not: null } },
      select: { id: true, descripcion: true },
    })
    stats.itemCatalogo.total = items.length
    for (const it of items) {
      const parsed = _parsearLegacyDescripcion(it.descripcion)
      if (!parsed) { stats.itemCatalogo.skipped++; continue }
      try {
        await prisma.itemCatalogo.update({
          where: { id: it.id },
          data:  { descripcion: JSON.stringify(parsed) },
        })
        stats.itemCatalogo.migrados++
      } catch (e) {
        console.error(`[MIGRACION] itemCatalogo ${it.id}:`, e.message)
        stats.itemCatalogo.errores++
      }
    }
    auditReq('admin:migrar_descripciones', req, { stats, elapsedMs: Date.now() - t0 })
    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      stats,
      resumen: `Productos: ${stats.producto.migrados}/${stats.producto.total} migrados, ${stats.producto.skipped} ya estructurados. ItemCatalogo: ${stats.itemCatalogo.migrados}/${stats.itemCatalogo.total} migrados, ${stats.itemCatalogo.skipped} ya estructurados.`,
    })
  } catch (e) {
    console.error('[MIGRACION]', e.message)
    res.status(500).json({ ok: false, error: e.message, stats })
  }
})

// PATCH — permiso granular empresa:editar (puede asignarse a Owner o Admin desde UI roles).
// Telefono permite formato múltiple "X / Y" (ACR usa 2 líneas).
const empresaPatchSchema = z.object({
  rnc:                   z.string().min(9).max(20).optional(),
  razonSocial:           z.string().min(2).max(200).optional(),
  nombreComercial:       z.string().max(200).optional().nullable(),
  registroMercantil:     z.string().max(50).optional().nullable(),
  representanteNombre:   z.string().max(100).optional().nullable(),
  representanteApellido: z.string().max(100).optional().nullable(),
  representanteCedula:   z.string().max(20).optional().nullable().refine(
    v => !v || validarCedulaRD(v),
    { message: 'Cédula RD inválida (dígito verificador no coincide).' }
  ),
  representanteCargo:    z.string().max(80).optional().nullable(),
  direccion:             z.string().max(300).optional().nullable(),
  sector:                z.string().max(100).optional().nullable(),
  provincia:             z.string().max(100).optional().nullable(),
  pais:                  z.string().max(80).optional(),
  tipoEmpresa:           z.string().max(40).optional().nullable(),
  fechaInicio:           z.coerce.date().optional().nullable(),
  telefono:              z.string().max(80).optional().nullable(),
  fax:                   z.string().max(40).optional().nullable(),
  email:                 z.string().email().max(150).optional().nullable().or(z.literal('').transform(() => null)),
  website:               z.string().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  // URLs deben pasar whitelist: Supabase Storage del proyecto o path local. Bloquea tracking-pixels externos.
  assets:                z.object({
    logoClaro:    z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    logoOscuro:   z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    selloFisico:  z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    firmaGerente: z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
  }).partial().optional(),
  eslogan:               z.string().max(200).optional().nullable(),
  // PIN supervisor para autorizar descuentos POS sobre el umbral dinámico.
  pinSupervisor:         z.string().min(4).max(8).regex(/^\d+$/, 'Solo dígitos.').optional(),
  // Umbral % de descuento global a partir del cual el POS exige PIN supervisor.
  maxDescuentoCajero:    z.coerce.number().int().min(0).max(100).optional(),
  // Condiciones comerciales por defecto — cada campo opcional, max 280 char.
  // _obligatorio: flag por término que prohíbe ocultarlo a nivel de documento
  // (ni con PIN supervisor). El cart muestra candado + pill "Forzado" y el
  // backend mergeCondiciones ignora cualquier override que apague la fila.
  // El bug previo: este objeto no incluía _obligatorio en su shape Zod, así
  // que el .parse() lo descartaba silenciosamente y nunca llegaba a Prisma.
  condicionesDefault:    z.object({
    validez:      z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    pago:         z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    entrega:      z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    garantia:     z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    _obligatorio: z.object({
      validez:  z.boolean().optional(),
      pago:     z.boolean().optional(),
      entrega:  z.boolean().optional(),
      garantia: z.boolean().optional(),
    }).partial().optional(),
  }).partial().optional(),
})

router.patch('/configuracion/empresa', verificarJWT, requerirPermiso('empresa:editar'), async (req, res) => {
  try {
    const data = empresaPatchSchema.parse(req.body)
    // H2: pinSupervisor + maxDescuentoCajero SOLO editables por sistema:owner.
    // Cambiar el PIN o bajar el umbral equivalen a bypass de descuentos.
    const _camposCriticos = ['pinSupervisor', 'maxDescuentoCajero'].filter(k => data[k] !== undefined)
    if (_camposCriticos.length > 0) {
      const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
      if (!permisos.includes('sistema:owner')) {
        auditReq('empresa:critical_edit_denied', req, { campos: _camposCriticos })
        return res.status(403).json({ error: 'Solo el propietario absoluto puede modificar PIN o umbral de descuento.', code: 'OWNER_REQUIRED' })
      }
      auditReq('empresa:critical_changed', req, { campos: _camposCriticos, maxDesc: data.maxDescuentoCajero })
    }
    // Snapshot previo: necesario para identificar URLs huérfanas a remover de Storage
    // cuando el cliente reemplaza o limpia un asset al guardar el form.
    const prevAssets = data.assets
      ? ((await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { assets: true } }))?.assets ?? {})
      : null
    // Merge assets en el JSON existente (no sobreescribir si el cliente omite alguna URL)
    if (data.assets) {
      data.assets = { ...(prevAssets ?? {}), ...data.assets }
    }
    const e = await prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: data,
      create: { id: 1, rnc: data.rnc ?? '', razonSocial: data.razonSocial ?? 'Empresa', ...data },
    })
    auditReq('empresa:perfil_update', req, { campos: Object.keys(data) })

    // Fire-and-forget: limpia Storage de assets que ya no se referencian.
    // Sólo borra paths que viven en el bucket SUPABASE_BUCKET de ACR (validados por pathFromSupabaseUrl).
    if (prevAssets && supabase) {
      setImmediate(async () => {
        try {
          const paths = []
          for (const [k, oldUrl] of Object.entries(prevAssets)) {
            if (!oldUrl) continue
            const newUrl = data.assets?.[k]
            if (newUrl === oldUrl) continue
            const p = pathFromSupabaseUrl(oldUrl)
            if (p) paths.push(p)
          }
          if (paths.length === 0) return
          const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(paths)
          if (error) console.error('[EMPRESA PATCH CLEANUP]', error.message)
          else       console.log('[EMPRESA PATCH CLEANUP OK]', paths.length, 'paths')
        } catch (err) {
          console.error('[EMPRESA PATCH CLEANUP EXCEPTION]', err.message)
        }
      })
    }
    res.json(e)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[EMPRESA PATCH]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Auth Routes ──────────────────────────────────────────────────────────────
// Migrados a backend/routes/auth.js (factory pattern). Aquí solo placeholder
// para preservar el marcador de sección.




  return router;
}

module.exports = createAdminRouter;
