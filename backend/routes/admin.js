/**
 * backend/routes/admin.js
 *
 * Admin router: empleados, asistencia, mapa NOC, tracking público por PIN,
 * incidencias de reconciliación, admin sessions. Más rutas (roles, dashboard,
 * config, reportes, etc.) seguirán migrándose por fases.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const { z }   = require('zod');

function createAdminRouter(deps) {
  const router = express.Router();
  const {
    prisma, middlewares, schemas, auditReq, helpers, limiters,
    requerirTOTP, protegerPropietario,
  } = deps;
  const { verificarJWT, requerirPermiso } = middlewares;
  const { empleadoSchema, empleadoUpdateSchema, asistenciaSchema } = schemas;
  const { fmtPhone } = helpers;
  const { trackingLimiter } = limiters;

  // ─── Admin global sessions ────────────────────────────────────────────────
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

  return router;
}

module.exports = createAdminRouter;
