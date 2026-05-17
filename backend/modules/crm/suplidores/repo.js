/**
 * backend/modules/crm/suplidores/repo.js
 */

function createSuplidoresRepo(prisma) {
  if (!prisma) throw new Error('createSuplidoresRepo: prisma required');

  async function listSuplidores(where, take, skip) {
    return Promise.all([
      prisma.suplidor.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.suplidor.count({ where }),
    ]);
  }

  async function findSuplidorById(id) {
    return prisma.suplidor.findUnique({ where: { id } });
  }

  async function createSuplidor(data) {
    return prisma.suplidor.create({ data });
  }

  async function updateSuplidor(id, data) {
    return prisma.suplidor.update({ where: { id }, data });
  }

  async function toggleSuplidorActivo(id, activo, fechaInactivo) {
    return prisma.suplidor.update({ where: { id }, data: { activo, fechaInactivo } });
  }

  return { listSuplidores, findSuplidorById, createSuplidor, updateSuplidor, toggleSuplidorActivo };
}

module.exports = createSuplidoresRepo;
