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
  };
}

module.exports = createRolesRepo;
