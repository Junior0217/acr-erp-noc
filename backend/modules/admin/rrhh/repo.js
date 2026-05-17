/**
 * backend/modules/admin/rrhh/repo.js
 *
 * Cyber Neo: TODOS los SELECT son explícitos y NUNCA incluyen
 * passwordHash, totpSecretEnc, totpBackupCodesHash, sessionTokens.
 */

const EMPLEADO_SAFE_SELECT = {
  id: true, nombre: true, cargo: true, email: true,
  bloqueado: true, creadoEn: true,
  roles: { select: { id: true, nombre: true } },
};

const EMPLEADO_ADMIN_SELECT = {
  id: true, nombre: true, cargo: true, email: true,
  bloqueado: true, creadoEn: true,
  permisosExtra: true, twoFactorEnabled: true,
  roles: { select: { id: true, nombre: true, activo: true, permisos: true } },
};

function createRrhhRepo(prisma) {
  if (!prisma) throw new Error('createRrhhRepo: prisma required');

  // ── Empleados ─────────────────────────────────────────────────────
  async function listEmpleados(where) {
    return prisma.empleado.findMany({
      where, orderBy: { nombre: 'asc' },
      select: EMPLEADO_SAFE_SELECT,
    });
  }

  async function listEmpleadosAdmin() {
    return prisma.empleado.findMany({
      orderBy: { nombre: 'asc' },
      select:  EMPLEADO_ADMIN_SELECT,
    });
  }

  async function createEmpleado(data) {
    return prisma.empleado.create({ data, select: EMPLEADO_SAFE_SELECT });
  }

  async function updateEmpleado(id, data) {
    return prisma.empleado.update({ where: { id }, data, select: EMPLEADO_SAFE_SELECT });
  }

  async function softDeleteEmpleado(id) {
    return prisma.empleado.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async function findEmpleadoBasic(id) {
    return prisma.empleado.findUnique({
      where:  { id },
      select: { id: true, nombre: true, bloqueado: true, permisosExtra: true },
    });
  }

  async function findEmpleadoConRoles(id) {
    return prisma.empleado.findUnique({
      where:   { id },
      include: { roles: { select: { permisos: true } } },
    });
  }

  async function findEmpleadoConRolesActivos(id) {
    return prisma.empleado.findUnique({
      where:   { id },
      include: { roles: { where: { activo: true }, select: { permisos: true } } },
    });
  }

  // ── Roles ─────────────────────────────────────────────────────────
  async function listRolesByIds(ids) {
    return prisma.rol.findMany({
      where:   { id: { in: ids } },
      select:  { id: true, nombre: true, permisos: true, nivel: true },
      orderBy: { nivel: 'desc' },
    });
  }

  async function listRolesByEmpleado(empleadoId) {
    return prisma.rol.findMany({
      where:  { empleados: { some: { id: empleadoId } }, activo: true },
      select: { nivel: true },
    });
  }

  // ── Asistencia ────────────────────────────────────────────────────
  async function listAsistencia(where) {
    return prisma.asistencia.findMany({
      where, orderBy: { fechaHora: 'desc' }, take: 300,
      include: { empleado: { select: { id: true, nombre: true, cargo: true } } },
    });
  }

  async function findUltimaAsistencia(empleadoId) {
    return prisma.asistencia.findFirst({
      where:   { empleadoId },
      orderBy: { fechaHora: 'desc' },
    });
  }

  async function findEntradaHoy(empleadoId, inicioDia, finDia) {
    return prisma.asistencia.findFirst({
      where: { empleadoId, tipo: 'Entrada', fechaHora: { gte: inicioDia, lt: finDia } },
    });
  }

  async function createAsistencia(data) {
    return prisma.asistencia.create({
      data,
      include: { empleado: { select: { id: true, nombre: true } } },
    });
  }

  // ── Admin updates con tx ─────────────────────────────────────────
  async function findEmpleadoExtrasTx(tx, id) {
    return tx.empleado.findUnique({ where: { id }, select: { permisosExtra: true } });
  }

  async function updateEmpleadoRolesTx(tx, id, data) {
    return tx.empleado.update({
      where: { id }, data,
      include: { roles: { select: { id: true, nombre: true } } },
    });
  }

  async function updateEmpleadoPermisosExtra(id, permisosExtra) {
    return prisma.empleado.update({ where: { id }, data: { permisosExtra } });
  }

  // ── Offboard tx pieces ───────────────────────────────────────────
  async function findEmpleadoOffboardTx(tx, id) {
    return tx.empleado.findUnique({
      where:  { id },
      select: { id: true, nombre: true, bloqueado: true },
    });
  }

  async function bloquearEmpleadoTx(tx, id) {
    return tx.empleado.update({ where: { id }, data: { bloqueado: true, deletedAt: new Date() } });
  }

  async function deleteSessionsTx(tx, empleadoId) {
    return tx.sessionToken.deleteMany({ where: { empleadoId } });
  }

  async function deleteCarritoTx(tx, empleadoId) {
    return tx.carritoTemp.deleteMany({ where: { empleadoId } });
  }

  async function findOtsActivasTx(tx, empleadoId) {
    return tx.ordenTrabajo.findMany({
      where:  { tecnicoId: empleadoId, estado: { in: ['Pendiente', 'EnProceso'] }, deletedAt: null },
      select: { id: true, noOT: true, metadatos: true },
    });
  }

  async function huerfanarOtTx(tx, id, metadatos) {
    return tx.ordenTrabajo.update({
      where: { id },
      data:  { tecnicoId: null, metadatos },
    });
  }

  async function liberarTicketsTallerTx(tx, empleadoId) {
    return tx.ticketTaller.updateMany({
      where: { tecnicoId: empleadoId, estado: { in: ['Recibido', 'Diagnostico', 'EsperandoPieza'] } },
      data:  { tecnicoId: null },
    });
  }

  return {
    EMPLEADO_SAFE_SELECT,
    EMPLEADO_ADMIN_SELECT,
    listEmpleados,
    listEmpleadosAdmin,
    createEmpleado,
    updateEmpleado,
    softDeleteEmpleado,
    findEmpleadoBasic,
    findEmpleadoConRoles,
    findEmpleadoConRolesActivos,
    listRolesByIds,
    listRolesByEmpleado,
    listAsistencia,
    findUltimaAsistencia,
    findEntradaHoy,
    createAsistencia,
    findEmpleadoExtrasTx,
    updateEmpleadoRolesTx,
    updateEmpleadoPermisosExtra,
    findEmpleadoOffboardTx,
    bloquearEmpleadoTx,
    deleteSessionsTx,
    deleteCarritoTx,
    findOtsActivasTx,
    huerfanarOtTx,
    liberarTicketsTallerTx,
  };
}

module.exports = createRrhhRepo;
