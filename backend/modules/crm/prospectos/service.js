/**
 * backend/modules/crm/prospectos/service.js
 *
 * Cyber Neo silent fix: conversión Prospecto→Cliente usa
 * generarSiguienteCodigo('cliente', tx) atómico, en vez de
 * `count + 1` (race condition que podía generar noCliente duplicado
 * bajo cargas concurrentes y colisionar con índice único).
 */

class ProspectoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createProspectosService(deps) {
  const { repo, formatProspecto, formatCliente, generarSiguienteCodigo } = deps;
  if (!repo)                                          throw new Error('createProspectosService: repo required');
  if (typeof formatProspecto !== 'function')          throw new Error('createProspectosService: formatProspecto required');
  if (typeof formatCliente !== 'function')            throw new Error('createProspectosService: formatCliente required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createProspectosService: generarSiguienteCodigo required');

  async function listarProspectos(query) {
    const take = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (query.estado) where.estado = query.estado;
    if (query.search) {
      where.OR = [
        { nombre:   { contains: query.search, mode: 'insensitive' } },
        { telefono: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [prospectos, total] = await repo.listProspectos(where, take, skip);
    return {
      status: 200,
      body: {
        data: prospectos.map(formatProspecto),
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function crearProspecto(data) {
    const p = await repo.createProspecto(data);
    return { status: 201, body: formatProspecto(p) };
  }

  async function actualizarProspecto(id, data) {
    try {
      const p = await repo.updateProspecto(id, data);
      return { status: 200, body: formatProspecto(p) };
    } catch (e) {
      if (e.code === 'P2025') throw new ProspectoError(404, 'NOT_FOUND', 'Prospecto no encontrado.');
      throw e;
    }
  }

  async function eliminarProspecto(id) {
    try {
      await repo.deleteProspecto(id);
      return { status: 204, body: null };
    } catch (e) {
      if (e.code === 'P2025') throw new ProspectoError(404, 'NOT_FOUND', 'Prospecto no encontrado.');
      throw e;
    }
  }

  async function convertirProspecto(id, deps) {
    const { prisma } = deps;
    const prospecto = await repo.findProspectoById(id);
    if (!prospecto)                          throw new ProspectoError(404, 'NOT_FOUND', 'Prospecto no encontrado.');
    if (prospecto.estado === 'Convertido')   throw new ProspectoError(409, 'ALREADY_CONVERTED', 'Prospecto ya fue convertido.');

    try {
      const resultado = await prisma.$transaction(async (tx) => {
        const noCliente = await generarSiguienteCodigo('cliente', tx);
        const cliente = await repo.createClienteTx(tx, {
          noCliente,
          razonSocial:       prospecto.nombre,
          telefonoPrincipal: prospecto.telefono,
          latitud:           prospecto.latitud  ?? undefined,
          longitud:          prospecto.longitud ?? undefined,
          notas:             prospecto.notas    ?? undefined,
          tipoCliente:       'Residencial',
        });
        const updated = await repo.updateProspectoTx(tx, id, { estado: 'Convertido' });
        return { cliente, prospecto: updated };
      });

      return {
        status: 200,
        body: {
          cliente:   formatCliente(resultado.cliente),
          prospecto: formatProspecto(resultado.prospecto),
        },
      };
    } catch (e) {
      if (e.code === 'P2002') throw new ProspectoError(409, 'DUP', 'noCliente duplicado en conversión (reintentar).');
      throw e;
    }
  }

  return {
    ProspectoError,
    listarProspectos, crearProspecto, actualizarProspecto,
    eliminarProspecto, convertirProspecto,
  };
}

module.exports = createProspectosService;
module.exports.ProspectoError = ProspectoError;
