/**
 * backend/modules/crm/activos/repo.js
 */

function createActivosRepo(prisma) {
  if (!prisma) throw new Error('createActivosRepo: prisma required');

  async function listActivos(where) {
    return prisma.activoCliente.findMany({
      where,
      include: {
        producto: { select: { id: true, sku: true, nombre: true } },
        orden:    { select: { id: true, noOT: true } },
      },
      orderBy: { fechaInstalacion: 'desc' },
    });
  }

  async function createActivo(data) {
    return prisma.activoCliente.create({ data });
  }

  async function deleteActivo(id) {
    return prisma.activoCliente.delete({ where: { id } });
  }

  async function listTimeline(activoId) {
    return prisma.activoTimeline.findMany({
      where:   { activoId },
      include: {
        tecnico: { select: { id: true, nombre: true } },
        orden:   { select: { id: true, noOT: true } },
      },
      orderBy: { fecha: 'desc' },
      take:    100,
    });
  }

  async function createTimelineEvento(data) {
    return prisma.activoTimeline.create({
      data,
      include: { tecnico: { select: { id: true, nombre: true } } },
    });
  }

  return { listActivos, createActivo, deleteActivo, listTimeline, createTimelineEvento };
}

module.exports = createActivosRepo;
