/**
 * backend/modules/ventas/taller/repo.js
 */

const TICKET_LIST_INCLUDE = {
  cliente: { select: { id: true, noCliente: true, razonSocial: true, telefonoPrincipal: true } },
  tecnico: { select: { id: true, nombre: true } },
};

function createTallerRepo(prisma) {
  if (!prisma) throw new Error('createTallerRepo: prisma required');

  async function listTickets(where) {
    return prisma.ticketTaller.findMany({
      where,
      include: TICKET_LIST_INCLUDE,
      orderBy: { recibidoEn: 'desc' },
      take:    200,
    });
  }

  async function findByCodigoPin(codigoPin) {
    return prisma.ticketTaller.findUnique({ where: { codigoPin } });
  }

  async function findEstadoById(id) {
    return prisma.ticketTaller.findUnique({ where: { id }, select: { estado: true } });
  }

  async function createTicketTx(tx, data) {
    return tx.ticketTaller.create({
      data,
      include: { cliente: { select: { razonSocial: true } } },
    });
  }

  async function updateTicket(id, data) {
    return prisma.ticketTaller.update({ where: { id }, data });
  }

  return {
    listTickets,
    findByCodigoPin,
    findEstadoById,
    createTicketTx,
    updateTicket,
  };
}

module.exports = createTallerRepo;
