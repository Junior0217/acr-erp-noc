/**
 * backend/modules/ventas/taller/service.js
 *
 * Cyber Neo: PIN se genera con crypto.randomInt (CSPRNG, no Math.random)
 * y alfabeto sin ambigüedad (sin I/O/0/1) — anti brute-force de tracking público.
 */

const crypto = require('crypto');

const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PIN_LENGTH = 6;

const ESTADOS_FINALES_TALLER = new Set(['Entregado', 'Cancelado']);

function generarPin() {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i++) {
    pin += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)];
  }
  return pin;
}

class TallerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createTallerService(deps) {
  const { repo, auditReq, generarSiguienteCodigo, prisma } = deps;
  if (!repo)                                          throw new Error('createTallerService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createTallerService: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createTallerService: generarSiguienteCodigo required');
  if (!prisma)                                        throw new Error('createTallerService: prisma required');

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

  async function _bloquearSiFinal(id) {
    const prev = await repo.findEstadoById(id);
    if (!prev) throw new TallerError(404, 'NOT_FOUND', 'Ticket no encontrado.');
    if (ESTADOS_FINALES_TALLER.has(prev.estado)) {
      throw new TallerError(423, 'TICKET_FINAL', `Ticket ${prev.estado}. Datos inmutables.`);
    }
    return prev;
  }

  async function listarTickets(query) {
    const where = {};
    if (query.estado) where.estado = query.estado;
    if (query.search) where.OR = [
      { noTicket:    { contains: query.search, mode: 'insensitive' } },
      { codigoPin:   { contains: query.search, mode: 'insensitive' } },
      { equipo:      { contains: query.search, mode: 'insensitive' } },
      { numeroSerie: { contains: query.search, mode: 'insensitive' } },
    ];
    const tickets = await repo.listTickets(where);
    return { status: 200, body: { data: tickets } };
  }

  async function crearTicket(data, user, reqMeta) {
    let pin = null;
    for (let intento = 0; intento < 5; intento++) {
      const candidato = generarPin();
      const colide = await repo.findByCodigoPin(candidato);
      if (!colide) { pin = candidato; break; }
    }
    if (!pin) throw new TallerError(503, 'PIN_GEN', 'No se pudo generar PIN único. Reintenta.');

    try {
      const ticket = await prisma.$transaction(async (tx) => {
        const noTicket = await generarSiguienteCodigo('rma', tx);
        return repo.createTicketTx(tx, { ...data, noTicket, codigoPin: pin });
      });
      auditReq('taller:crear', _fakeReqForAudit(reqMeta, user), {
        ticketId: ticket.id, clienteId: data.clienteId,
      });
      return { status: 201, body: ticket };
    } catch (e) {
      if (e.code === 'P2003') throw new TallerError(400, 'CLIENTE_NOT_FOUND', 'Cliente no encontrado.');
      throw e;
    }
  }

  async function cambiarEstado(id, data, user, reqMeta) {
    await _bloquearSiFinal(id);
    const update = { estado: data.estado };
    if (data.diagnostico   != null) update.diagnostico   = data.diagnostico;
    if (data.costoEstimado != null) update.costoEstimado = data.costoEstimado;
    if (data.notas         != null) update.notas         = data.notas;
    const now = new Date();
    if (data.estado === 'Diagnostico' && !update.diagnosticadoEn) update.diagnosticadoEn = now;
    if (data.estado === 'Listo')     update.listoEn     = now;
    if (data.estado === 'Entregado') update.entregadoEn = now;
    try {
      const ticket = await repo.updateTicket(id, update);
      auditReq('taller:estado', _fakeReqForAudit(reqMeta, user), {
        ticketId: ticket.id, estado: ticket.estado,
      });
      return { status: 200, body: ticket };
    } catch (e) {
      if (e.code === 'P2025') throw new TallerError(404, 'NOT_FOUND', 'Ticket no encontrado.');
      throw e;
    }
  }

  async function editarTicket(id, data) {
    await _bloquearSiFinal(id);
    try {
      const ticket = await repo.updateTicket(id, data);
      return { status: 200, body: ticket };
    } catch (e) {
      if (e.code === 'P2025') throw new TallerError(404, 'NOT_FOUND', 'Ticket no encontrado.');
      throw e;
    }
  }

  async function reabrirTicket(id, user, reqMeta) {
    const prev = await repo.findEstadoById(id);
    if (!prev) throw new TallerError(404, 'NOT_FOUND', 'Ticket no encontrado.');
    if (!ESTADOS_FINALES_TALLER.has(prev.estado)) {
      throw new TallerError(409, 'NOT_FINAL', 'Ticket no está en estado final.');
    }
    const ticket = await repo.updateTicket(id, { estado: 'Diagnostico', entregadoEn: null });
    auditReq('taller:reabrir', _fakeReqForAudit(reqMeta, user), {
      ticketId: ticket.id, estadoPrevio: prev.estado,
    });
    return { status: 200, body: ticket };
  }

  return {
    TallerError,
    listarTickets,
    crearTicket,
    cambiarEstado,
    editarTicket,
    reabrirTicket,
  };
}

module.exports = createTallerService;
module.exports.TallerError = TallerError;
module.exports.ESTADOS_FINALES_TALLER = ESTADOS_FINALES_TALLER;
