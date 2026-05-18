/**
 * backend/modules/admin/roles/service.js
 *
 * Cyber Neo:
 *   - Anti-self-escalation: non-owner no puede crear roles con nivel ≥ propio.
 *   - Anti-owner-strip: rol con sistema:owner solo editable por owner; no se
 *     puede remover sistema:owner del rol Owner.
 *   - Password reset: bcrypt cost 12 + revoca todas las sesiones.
 *   - Block: bloquea + revoca sesiones; no permite auto-bloqueo.
 */

const bcrypt = require('bcryptjs');

class RolesError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createRolesService(deps) {
  const { repo, auditReq } = deps;
  if (!repo)                            throw new Error('createRolesService: repo required');
  if (typeof auditReq !== 'function')   throw new Error('createRolesService: auditReq required');

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

  async function _callerNivelMax(userId) {
    const roles = await repo.listRolesByEmpleado(userId);
    return roles.length ? Math.max(...roles.map(r => r.nivel ?? 0)) : 0;
  }

  function _esOwner(user) {
    return Array.isArray(user?.permisos) && user.permisos.includes('sistema:owner');
  }

  async function listarRoles() {
    const data = await repo.listRoles();
    return { status: 200, body: { data } };
  }

  async function crearRol(data, user, reqMeta) {
    if (!_esOwner(user)) {
      const myNivel = await _callerNivelMax(user.sub);
      if ((data.nivel ?? 0) >= myNivel) {
        throw new RolesError(403, 'NIVEL_ESCALATION',
          `No puedes crear un rol con nivel ${data.nivel}: tu nivel máximo es ${myNivel}.`);
      }
    }
    try {
      const rol = await repo.createRol(data);
      auditReq('admin:rol_creado', _fakeReqForAudit(reqMeta, user), { rolId: rol.id, nombre: rol.nombre });
      return { status: 201, body: rol };
    } catch (e) {
      if (e.code === 'P2002') throw new RolesError(409, 'DUP', 'Ya existe un rol con ese nombre.');
      throw e;
    }
  }

  async function actualizarRol(id, data, user, reqMeta) {
    const existing = await repo.findRolById(id);
    if (!existing) throw new RolesError(404, 'NOT_FOUND', 'Rol no encontrado.');
    const existingPerms = Array.isArray(existing.permisos) ? existing.permisos : [];
    if (existingPerms.includes('sistema:owner') && !_esOwner(user)) {
      throw new RolesError(403, 'OWNER_PROTECTED', 'El rol Owner solo puede ser modificado por el propietario del sistema.');
    }
    if (!_esOwner(user) && data.nivel !== undefined) {
      const myNivel = await _callerNivelMax(user.sub);
      if (data.nivel >= myNivel) {
        throw new RolesError(403, 'NIVEL_ESCALATION',
          `No puedes asignar nivel ${data.nivel}: tu nivel máximo es ${myNivel}.`);
      }
    }
    const newPerms = Array.isArray(data.permisos) ? data.permisos : [];
    if (existingPerms.includes('sistema:owner') && data.permisos !== undefined && !newPerms.includes('sistema:owner')) {
      throw new RolesError(403, 'OWNER_STRIP', 'No se puede remover sistema:owner del rol Owner.');
    }
    try {
      const rol = await repo.updateRol(id, data);
      auditReq('admin:rol_actualizado', _fakeReqForAudit(reqMeta, user), { rolId: id });
      return { status: 200, body: rol };
    } catch (e) {
      if (e.code === 'P2025') throw new RolesError(404, 'NOT_FOUND', 'Rol no encontrado.');
      if (e.code === 'P2002') throw new RolesError(409, 'DUP',       'Ya existe un rol con ese nombre.');
      throw e;
    }
  }

  async function eliminarRol(id, user, reqMeta) {
    const rol = await repo.findRolConCount(id);
    if (!rol) throw new RolesError(404, 'NOT_FOUND', 'Rol no encontrado.');
    const rolPerms = Array.isArray(rol.permisos) ? rol.permisos : [];
    if (rolPerms.includes('sistema:owner')) {
      throw new RolesError(403, 'OWNER_IMMUTABLE', 'El rol Owner es inmutable y no puede eliminarse.');
    }
    if (rol._count.empleados > 0) {
      throw new RolesError(409, 'EN_USO', `No se puede eliminar: ${rol._count.empleados} usuario(s) tienen este rol asignado.`);
    }
    try {
      await repo.deleteRol(id);
      auditReq('admin:rol_eliminado', _fakeReqForAudit(reqMeta, user), { rolId: id, nombre: rol.nombre });
      return { status: 204, body: null };
    } catch (e) {
      if (e.code === 'P2025') throw new RolesError(404, 'NOT_FOUND', 'Rol no encontrado.');
      throw e;
    }
  }

  async function cambiarPassword(id, password, user, reqMeta) {
    const passwordHash = await bcrypt.hash(password, 12);
    await repo.updateEmpleadoPasswordHash(id, passwordHash);
    await repo.deleteSessions(id);
    auditReq('admin:password_change', _fakeReqForAudit(reqMeta, user), { targetId: id });
    return { status: 204, body: null };
  }

  async function bloquearEmpleado(id, bloqueado, user, reqMeta) {
    if (id === user.sub) {
      throw new RolesError(403, 'SELF_BLOCK', 'No puedes bloquear tu propia cuenta.');
    }
    await repo.setEmpleadoBloqueado(id, bloqueado);
    if (bloqueado) await repo.deleteSessions(id);
    auditReq(bloqueado ? 'admin:usuario_bloqueado' : 'admin:usuario_desbloqueado',
      _fakeReqForAudit(reqMeta, user), { targetId: id });
    return { status: 204, body: null };
  }

  async function matarSesiones(empleadoId, user, reqMeta) {
    await repo.deleteSessions(empleadoId);
    auditReq('admin:sessions_killed', _fakeReqForAudit(reqMeta, user), { targetId: empleadoId });
    return { status: 204, body: null };
  }

  // M1.1: listado de sesiones activas. Read-only — no audita (sería ruido).
  async function listarSesiones() {
    const data = await repo.listSessions();
    return { status: 200, body: { data } };
  }

  async function matarSesionPorJti(jti, user, reqMeta) {
    if (!jti || typeof jti !== 'string' || jti.length < 4) {
      throw new RolesError(400, 'BAD_JTI', 'JTI inválido.');
    }
    const result = await repo.deleteSessionByJti(jti);
    auditReq('admin:session_killed_by_jti', _fakeReqForAudit(reqMeta, user), {
      jti: jti.slice(0, 8) + '…', count: result.count,
    });
    return { status: 204, body: null };
  }

  return {
    RolesError,
    listarRoles,
    crearRol,
    actualizarRol,
    eliminarRol,
    cambiarPassword,
    bloquearEmpleado,
    matarSesiones,
    listarSesiones,
    matarSesionPorJti,
  };
}

module.exports = createRolesService;
module.exports.RolesError = RolesError;
