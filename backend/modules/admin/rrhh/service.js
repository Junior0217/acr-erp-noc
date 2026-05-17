/**
 * backend/modules/admin/rrhh/service.js
 *
 * RRHH: lógica sensible (bcrypt 12, escalation checks, audit).
 * Cyber Neo:
 *   - SELECT explícito en repo → passwordHash JAMÁS sale al frontend.
 *   - Anti-self-escalation en POST + PATCH roles.
 *   - Subset-perms guard: callers no-owner solo asignan roles cuyos
 *     permisos son subset de los suyos.
 *   - Nivel guard: callers no-owner solo asignan roles de nivel < propio.
 *   - Cooldown 2min + transición Entrada/Salida en asistencia.
 */

const bcrypt = require('bcryptjs');

class RrhhError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

const ASISTENCIA_COOLDOWN_MS = 2 * 60 * 1000;

function createRrhhService(deps) {
  const { repo, auditReq, prisma } = deps;
  if (!repo)                            throw new Error('createRrhhService: repo required');
  if (typeof auditReq !== 'function')   throw new Error('createRrhhService: auditReq required');
  if (!prisma)                          throw new Error('createRrhhService: prisma required');

  function _fakeReqForAudit(reqMeta, user) {
    return {
      headers: {
        'x-forwarded-for': reqMeta?.ip ?? null,
        'user-agent':      reqMeta?.ua ?? null,
      },
      socket: { remoteAddress: reqMeta?.ip ?? null },
      user:   user ?? null,
    };
  }

  function _puedeGestionarAsistencia(user) {
    const perms = Array.isArray(user?.permisos) ? user.permisos : [];
    return perms.includes('sistema:owner') || perms.includes('rrhh:asistencia');
  }

  async function _resolverCargoDeRoles(roleIds) {
    if (!roleIds?.length) return null;
    const roles = await repo.listRolesByIds(roleIds);
    return roles.length ? roles[0].nombre : null;
  }

  async function _validarSubsetPerms(callerUser, roleIds) {
    if (!roleIds.length) return;
    const callerPerms = new Set(Array.isArray(callerUser?.permisos) ? callerUser.permisos : []);
    if (callerPerms.has('sistema:owner')) return; // owner libre
    const rolesToAssign = await repo.listRolesByIds(roleIds);
    for (const rol of rolesToAssign) {
      const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : [];
      const escalated = rolPerms.find(p => !callerPerms.has(p));
      if (escalated) {
        throw new RrhhError(403, 'PRIVILEGE_ESCALATION',
          `No puedes asignar el rol "${rol.nombre}": contiene permiso "${escalated}" que tú no posees.`);
      }
    }
    const callerRoles = await repo.listRolesByEmpleado(callerUser.sub);
    const callerNivel = callerRoles.length ? Math.max(...callerRoles.map(r => r.nivel ?? 0)) : 0;
    for (const rol of rolesToAssign) {
      if ((rol.nivel ?? 0) >= callerNivel) {
        throw new RrhhError(403, 'NIVEL_ESCALATION',
          `No puedes asignar el rol "${rol.nombre}" (nivel ${rol.nivel}): tu nivel máximo es ${callerNivel}.`);
      }
    }
  }

  // ── Empleados CRUD ───────────────────────────────────────────────
  async function crearEmpleado(body, callerUser, reqMeta) {
    const { roleIds = [], password, ...data } = body;
    await _validarSubsetPerms(callerUser, roleIds);
    const passwordHash = await bcrypt.hash(password, 12);
    const cargo = await _resolverCargoDeRoles(roleIds) ?? 'Técnico';
    try {
      const e = await repo.createEmpleado({
        ...data,
        cargo,
        passwordHash,
        roles: { connect: roleIds.map(id => ({ id })) },
      });
      auditReq('rrhh:empleado_creado', _fakeReqForAudit(reqMeta, callerUser), { nombre: e.nombre });
      return { status: 201, body: e };
    } catch (err) {
      if (err.code === 'P2002') throw new RrhhError(409, 'DUP_EMAIL', 'El email ya está registrado.');
      throw err;
    }
  }

  async function listarEmpleados(query) {
    const where = { deletedAt: null };
    if (query.search) {
      where.OR = [
        { nombre: { contains: query.search, mode: 'insensitive' } },
        { cargo:  { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const data = await repo.listEmpleados(where);
    return { status: 200, body: { data } };
  }

  async function actualizarEmpleado(id, body, callerUser) {
    const { roleIds, password, ...data } = body;
    const updateData = { ...data };
    if (password)            updateData.passwordHash = await bcrypt.hash(password, 12);
    if (roleIds !== undefined) {
      await _validarSubsetPerms(callerUser, roleIds);
      updateData.roles = { set: roleIds.map(rid => ({ id: rid })) };
      const cargo = await _resolverCargoDeRoles(roleIds);
      if (cargo) updateData.cargo = cargo;
    }
    try {
      const e = await repo.updateEmpleado(id, updateData);
      return { status: 200, body: e };
    } catch (err) {
      if (err.code === 'P2025') throw new RrhhError(404, 'NOT_FOUND', 'Empleado no encontrado.');
      if (err.code === 'P2002') throw new RrhhError(409, 'DUP_EMAIL', 'El email ya está registrado.');
      throw err;
    }
  }

  async function eliminarEmpleado(id) {
    try {
      await repo.softDeleteEmpleado(id);
      return { status: 204, body: null };
    } catch (err) {
      if (err.code === 'P2025') throw new RrhhError(404, 'NOT_FOUND', 'Empleado no encontrado.');
      throw err;
    }
  }

  // ── Asistencia ──────────────────────────────────────────────────
  async function listarAsistencia(user, query) {
    const where = {};
    if (!_puedeGestionarAsistencia(user)) {
      where.empleadoId = user.sub;
    } else if (query.empleadoId) {
      const eid = parseInt(query.empleadoId, 10);
      if (eid > 0) where.empleadoId = eid;
    }
    if (query.mes && query.anio) {
      const m = parseInt(query.mes, 10);
      const y = parseInt(query.anio, 10);
      where.fechaHora = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    }
    const data = await repo.listAsistencia(where);
    return { status: 200, body: { data } };
  }

  async function registrarAsistencia(user, data) {
    if (!_puedeGestionarAsistencia(user) && data.empleadoId !== user.sub) {
      throw new RrhhError(403, 'FORBIDDEN', 'Solo puedes registrar tu propia asistencia.');
    }
    const ultima = await repo.findUltimaAsistencia(data.empleadoId);
    if (ultima) {
      const elapsedMs = Date.now() - new Date(ultima.fechaHora).getTime();
      if (elapsedMs < ASISTENCIA_COOLDOWN_MS) {
        const restante = Math.ceil((ASISTENCIA_COOLDOWN_MS - elapsedMs) / 1000);
        const err = new RrhhError(429, 'ASISTENCIA_COOLDOWN',
          `Espera ${restante}s antes de registrar otra asistencia.`);
        throw err;
      }
      if (ultima.tipo === data.tipo) {
        throw new RrhhError(409, 'ASISTENCIA_TRANSICION_INVALIDA',
          `No puedes registrar ${data.tipo} consecutiva. Falta registrar ${data.tipo === 'Entrada' ? 'Salida' : 'Entrada'} anterior.`);
      }
    } else if (data.tipo === 'Salida') {
      throw new RrhhError(409, 'ASISTENCIA_SIN_ENTRADA', 'No existe Entrada previa para registrar Salida.');
    }
    if (data.tipo === 'Entrada') {
      const hoy = new Date();
      const inicioDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
      const finDia    = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
      const yaEntrada = await repo.findEntradaHoy(data.empleadoId, inicioDia, finDia);
      if (yaEntrada) throw new RrhhError(409, 'ENTRADA_DUP', 'Ya existe una Entrada registrada hoy para este empleado.');
    }
    try {
      const registro = await repo.createAsistencia({
        empleadoId: data.empleadoId,
        tipo:       data.tipo,
        ...(data.latitud  != null && { latitud:  data.latitud }),
        ...(data.longitud != null && { longitud: data.longitud }),
      });
      return { status: 201, body: registro };
    } catch (err) {
      if (err.code === 'P2003') throw new RrhhError(400, 'EMP_NOT_FOUND', 'Empleado no encontrado.');
      throw err;
    }
  }

  // ── Admin: roles + permisos extra ───────────────────────────────
  async function listarEmpleadosAdmin() {
    const data = await repo.listEmpleadosAdmin();
    return { status: 200, body: { data } };
  }

  async function actualizarRoles(targetId, roleIds, callerUser, reqMeta) {
    if (targetId === callerUser.sub) {
      throw new RrhhError(403, 'SELF_EDIT', 'No puedes modificar tus propios roles.');
    }
    const current = await repo.findEmpleadoConRoles(targetId);
    if (!current) throw new RrhhError(404, 'NOT_FOUND', 'Empleado no encontrado.');
    const currentPerms = current.roles.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []);
    if (currentPerms.includes('sistema:owner')) {
      const rolesToAssign = await repo.listRolesByIds(roleIds);
      const merged = [...new Set(rolesToAssign.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []))];
      if (!merged.includes('sistema:owner')) {
        throw new RrhhError(403, 'OWNER_LOCK', 'El propietario debe conservar un rol con sistema:owner.');
      }
    }
    await _validarSubsetPerms(callerUser, roleIds);
    const newRoles = await repo.listRolesByIds(roleIds);
    const newRolePerms = new Set(newRoles.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []));
    const e = await prisma.$transaction(async (tx) => {
      const emp = await repo.findEmpleadoExtrasTx(tx, targetId);
      const extras = Array.isArray(emp?.permisosExtra) ? emp.permisosExtra : [];
      const cleanedExtras = extras.filter(p => !newRolePerms.has(p));
      return repo.updateEmpleadoRolesTx(tx, targetId, {
        roles: { set: roleIds.map(rid => ({ id: rid })) },
        ...(cleanedExtras.length !== extras.length ? { permisosExtra: cleanedExtras } : {}),
      });
    });
    auditReq('admin:roles_update', _fakeReqForAudit(reqMeta, callerUser), { targetId, roleIds });
    return { status: 200, body: { id: e.id, roles: e.roles } };
  }

  async function actualizarPermisosExtra(targetId, permisosExtra, callerUser, reqMeta) {
    const emp = await repo.findEmpleadoConRolesActivos(targetId);
    if (!emp) throw new RrhhError(404, 'NOT_FOUND', 'Empleado no encontrado.');
    const rolePerms = new Set(emp.roles.flatMap(r => Array.isArray(r.permisos) ? r.permisos : []));
    const cleanedExtras = permisosExtra.filter(p => !rolePerms.has(p));
    await repo.updateEmpleadoPermisosExtra(targetId, cleanedExtras);
    auditReq('admin:permisos_extra_update', _fakeReqForAudit(reqMeta, callerUser), { targetId, count: cleanedExtras.length });
    return { status: 204, body: null };
  }

  // ── Offboarding ─────────────────────────────────────────────────
  async function offboard(empleadoId, callerUser, reqMeta) {
    if (empleadoId === callerUser.sub) {
      throw new RrhhError(409, 'SELF_OFFBOARD', 'No puedes desactivarte a ti mismo.');
    }
    try {
      const result = await prisma.$transaction(async (tx) => {
        const emp = await repo.findEmpleadoOffboardTx(tx, empleadoId);
        if (!emp) throw new RrhhError(404, 'NOT_FOUND', 'Empleado no encontrado.');
        await repo.bloquearEmpleadoTx(tx, empleadoId);
        const sessionsDeleted = await repo.deleteSessionsTx(tx, empleadoId);
        await repo.deleteCarritoTx(tx, empleadoId);
        const otsActivas = await repo.findOtsActivasTx(tx, empleadoId);
        for (const ot of otsActivas) {
          await repo.huerfanarOtTx(tx, ot.id, {
            ...(ot.metadatos ?? {}),
            huerfana: true, motivo: 'offboarding',
            ofrecidaPor: empleadoId, marcadaEn: new Date().toISOString(),
          });
        }
        const ticketsLiberados = await repo.liberarTicketsTallerTx(tx, empleadoId);
        return {
          empleado: emp,
          sessionsRevocadas: sessionsDeleted.count,
          otsLiberadas:      otsActivas.length,
          otsHuerfanas:      otsActivas.map(o => o.noOT),
          ticketsLiberados:  ticketsLiberados.count,
        };
      });
      auditReq('rrhh:offboard', _fakeReqForAudit(reqMeta, callerUser), result);
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof RrhhError) throw err;
      throw err;
    }
  }

  return {
    RrhhError,
    crearEmpleado,
    listarEmpleados,
    actualizarEmpleado,
    eliminarEmpleado,
    listarAsistencia,
    registrarAsistencia,
    listarEmpleadosAdmin,
    actualizarRoles,
    actualizarPermisosExtra,
    offboard,
  };
}

module.exports = createRrhhService;
module.exports.RrhhError = RrhhError;
module.exports.ASISTENCIA_COOLDOWN_MS = ASISTENCIA_COOLDOWN_MS;
