/**
 * backend/modules/crm/clientes/repo.js
 *
 * Capa de datos del módulo Clientes.
 */

function createClientesRepo(prisma) {
  if (!prisma) throw new Error('createClientesRepo: prisma required');

  async function listClientes(where, take, skip) {
    return Promise.all([
      prisma.cliente.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.cliente.count({ where }),
    ]);
  }

  async function findClienteById(id) {
    return prisma.cliente.findUnique({ where: { id } });
  }

  async function createClienteTx(tx, data) {
    return tx.cliente.create({ data });
  }

  async function updateProspectoEstadoTx(tx, id, estado) {
    return tx.prospecto.update({ where: { id }, data: { estado } });
  }

  async function updateCliente(id, data) {
    return prisma.cliente.update({ where: { id }, data });
  }

  async function softDeleteCliente(id) {
    return prisma.cliente.update({
      where: { id },
      data:  { activo: false, deletedAt: new Date() },
    });
  }

  async function toggleClienteActivo(id, activo, fechaInactivo) {
    return prisma.cliente.update({
      where: { id },
      data:  { activo, fechaInactivo },
    });
  }

  return {
    listClientes,
    findClienteById,
    createClienteTx,
    updateProspectoEstadoTx,
    updateCliente,
    softDeleteCliente,
    toggleClienteActivo,
  };
}

module.exports = createClientesRepo;
