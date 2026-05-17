/**
 * backend/modules/crm/suplidores/service.js
 */

class SuplidorError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createSuplidoresService(deps) {
  const { repo, formatSuplidor } = deps;
  if (!repo)                                  throw new Error('createSuplidoresService: repo required');
  if (typeof formatSuplidor !== 'function')   throw new Error('createSuplidoresService: formatSuplidor required');

  async function listarSuplidores(query) {
    const take = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (query.activo !== undefined) where.activo = query.activo === 'true';
    if (query.search) {
      where.OR = [
        { razonSocial:    { contains: query.search, mode: 'insensitive' } },
        { rnc:            { contains: query.search, mode: 'insensitive' } },
        { noSuplidor:     { contains: query.search, mode: 'insensitive' } },
        { nombreContacto: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [suplidores, total] = await repo.listSuplidores(where, take, skip);
    return {
      status: 200,
      body: {
        data: suplidores.map(formatSuplidor),
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function crearSuplidor(data) {
    try {
      const s = await repo.createSuplidor(data);
      return { status: 201, body: formatSuplidor(s) };
    } catch (e) {
      if (e.code === 'P2002') throw new SuplidorError(409, 'DUP', 'El RNC o número de suplidor ya existe.');
      throw e;
    }
  }

  async function actualizarSuplidor(id, data) {
    try {
      const s = await repo.updateSuplidor(id, data);
      return { status: 200, body: formatSuplidor(s) };
    } catch (e) {
      if (e.code === 'P2025') throw new SuplidorError(404, 'NOT_FOUND', 'Suplidor no encontrado.');
      if (e.code === 'P2002') throw new SuplidorError(409, 'DUP', 'El RNC ya existe en otro registro.');
      throw e;
    }
  }

  async function toggleSuplidor(id) {
    const current = await repo.findSuplidorById(id);
    if (!current) throw new SuplidorError(404, 'NOT_FOUND', 'Suplidor no encontrado.');
    const updated = await repo.toggleSuplidorActivo(
      id,
      !current.activo,
      !current.activo ? null : new Date(),
    );
    return { status: 200, body: formatSuplidor(updated) };
  }

  return { SuplidorError, listarSuplidores, crearSuplidor, actualizarSuplidor, toggleSuplidor };
}

module.exports = createSuplidoresService;
module.exports.SuplidorError = SuplidorError;
