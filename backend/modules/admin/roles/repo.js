/**
 * backend/modules/admin/roles/repo.js
 */

const ROL_LIST_SELECT = {
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
};

function createRolesRepo(prisma) {
  if (!prisma) throw new Error('createRolesRepo: prisma required');

  async function listRoles() {
    return prisma.rol.findMany({ select: ROL_LIST_SELECT, orderBy: { nombre: 'asc' } });
  }

  async function findRolById(id) {
    return prisma.rol.findUnique({ where: { id } });
  }

  async function findRolConCount(id) {
    return prisma.rol.findUnique({
      where:   { id },
      include: { _count: { select: { empleados: true } } },
    });
  }

  async function createRol(data) {
    return prisma.rol.create({
      data,
      include: { _count: { select: { empleados: true } } },
    });
  }

  async function updateRol(id, data) {
    return prisma.rol.update({
      where: { id }, data,
      include: { _count: { select: { empleados: true } } },
    });
  }

  async function deleteRol(id) {
    return prisma.rol.delete({ where: { id } });
  }

  async function listRolesByEmpleado(empleadoId) {
    return prisma.rol.findMany({
      where:  { empleados: { some: { id: empleadoId } }, activo: true },
      select: { nivel: true },
    });
  }

  // ── Empleados admin ops ────────────────────────────────────────
  async function updateEmpleadoPasswordHash(id, passwordHash) {
    return prisma.empleado.update({ where: { id }, data: { passwordHash } });
  }

  async function deleteSessions(empleadoId) {
    return prisma.sessionToken.deleteMany({ where: { empleadoId } });
  }

  // M1.1: listado de sesiones activas (no expiradas). SELECT sin tokens
  // secretos — solo metadata para auditar/cerrar. Empleado join compacto.
  async function listSessions() {
    return prisma.sessionToken.findMany({
      where:   { expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take:    500,
      select: {
        id: true, jti: true, userAgent: true, ip: true, deviceHash: true,
        createdAt: true, expiresAt: true,
        empleado: { select: { id: true, nombre: true, email: true } },
      },
    });
  }

  async function deleteSessionByJti(jti) {
    return prisma.sessionToken.deleteMany({ where: { jti } });
  }

  async function setEmpleadoBloqueado(id, bloqueado) {
    return prisma.empleado.update({ where: { id }, data: { bloqueado } });
  }

  return {
    listRoles,
    findRolById,
    findRolConCount,
    createRol,
    updateRol,
    deleteRol,
    listRolesByEmpleado,
    updateEmpleadoPasswordHash,
    deleteSessions,
    setEmpleadoBloqueado,
    listSessions,
    deleteSessionByJti,
  };
}

module.exports = createRolesRepo;
