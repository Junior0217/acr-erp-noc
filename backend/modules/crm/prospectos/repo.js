/**
 * backend/modules/crm/prospectos/repo.js
 */

function createProspectosRepo(prisma) {
  if (!prisma) throw new Error('createProspectosRepo: prisma required');

  async function listProspectos(where, take, skip) {
    return Promise.all([
      prisma.prospecto.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.prospecto.count({ where }),
    ]);
  }

  async function findProspectoById(id) {
    return prisma.prospecto.findUnique({ where: { id } });
  }

  async function createProspecto(data) {
    return prisma.prospecto.create({ data });
  }

  async function updateProspecto(id, data) {
    return prisma.prospecto.update({ where: { id }, data });
  }

  async function deleteProspecto(id) {
    return prisma.prospecto.delete({ where: { id } });
  }

  async function createClienteTx(tx, data) {
    return tx.cliente.create({ data });
  }

  async function updateProspectoTx(tx, id, data) {
    return tx.prospecto.update({ where: { id }, data });
  }

  return {
    listProspectos, findProspectoById, createProspecto, updateProspecto,
    deleteProspecto, createClienteTx, updateProspectoTx,
  };
}

module.exports = createProspectosRepo;
