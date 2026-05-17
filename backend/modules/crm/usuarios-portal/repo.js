/**
 * backend/modules/crm/usuarios-portal/repo.js
 */

const _USUARIO_PORTAL_SAFE_SELECT = {
  id: true, noUsuario: true, nombre: true, email: true,
  telefono: true, activo: true, clienteId: true, createdAt: true,
  cliente: { select: { id: true, noCliente: true, razonSocial: true } },
};

const _USUARIO_PORTAL_UPDATE_SELECT = {
  id: true, noUsuario: true, nombre: true, email: true, activo: true, clienteId: true,
  cliente: { select: { id: true, noCliente: true, razonSocial: true } },
};

function createUsuariosPortalRepo(prisma) {
  if (!prisma) throw new Error('createUsuariosPortalRepo: prisma required');

  async function listUsuarios(where, take, skip) {
    return Promise.all([
      prisma.usuarioPortal.findMany({
        where, select: _USUARIO_PORTAL_SAFE_SELECT,
        orderBy: { createdAt: 'desc' }, skip, take,
      }),
      prisma.usuarioPortal.count({ where }),
    ]);
  }

  async function findClienteById(id) {
    return prisma.cliente.findUnique({ where: { id } });
  }

  async function vincularUsuario(id, clienteId) {
    return prisma.usuarioPortal.update({
      where:  { id },
      data:   { clienteId: clienteId ?? null },
      select: _USUARIO_PORTAL_UPDATE_SELECT,
    });
  }

  return { listUsuarios, findClienteById, vincularUsuario };
}

module.exports = createUsuariosPortalRepo;
