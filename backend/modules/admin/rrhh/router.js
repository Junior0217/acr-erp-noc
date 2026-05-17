/**
 * backend/modules/admin/rrhh/router.js
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


function createRrhhRouter(deps) {
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




  return router;
}

module.exports = createRrhhRouter;
