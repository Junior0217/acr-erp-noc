/**
 * backend/modules/crm/clientes/service.js
 *
 * Lógica del módulo Clientes. Format helper viene de shared/helpers
 * (formatCliente normaliza phone/RNC/cedula a output unificado).
 */

class ClienteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createClientesService(deps) {
  const { repo, auditReq, generarSiguienteCodigo, formatCliente, validUUID } = deps;
  if (!repo)                                          throw new Error('createClientesService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createClientesService: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createClientesService: generarSiguienteCodigo required');
  if (typeof formatCliente !== 'function')            throw new Error('createClientesService: formatCliente required');

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

  async function listarClientes(query) {
    const take = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = { deletedAt: null };
    if (query.activo !== undefined) where.activo = query.activo === 'true';
    if (query.search) {
      where.OR = [
        { razonSocial:    { contains: query.search, mode: 'insensitive' } },
        { rnc:            { contains: query.search, mode: 'insensitive' } },
        { noCliente:      { contains: query.search, mode: 'insensitive' } },
        { nombreContacto: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [clientes, total] = await repo.listClientes(where, take, skip);
    return {
      status: 200,
      body: {
        data: clientes.map(formatCliente),
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  // Auto-derivación de tipoNcf si el cajero no lo especifica explícitamente.
  // Reduce ~80% de los errores en el reporte 607 por NCF mal asignado.
  //
  // Reglas (Norma DGII 06-2018):
  //   - tipoEmpresa contiene "gobierno"/"estatal"/"municipal" → Gubernamental (B15)
  //   - tipoEmpresa contiene "zona franca" o "exonerado"      → Régimen Especial (B14)
  //   - tiene RNC válido (9 dígitos)                          → Crédito Fiscal (B01)
  //   - cualquier otro caso (persona física, sin RNC)         → Consumidor Final (B02)
  function _derivarTipoNcf(data) {
    if (data.tipoNcf && data.tipoNcf.trim()) return data.tipoNcf;
    const empresa = String(data.tipoEmpresa ?? '').toLowerCase();
    if (/(gobierno|estatal|municipal|gubern)/.test(empresa)) return 'Gubernamental';
    if (/(zona\s*franca|exonerad|regimen\s*especial|régimen\s*especial)/.test(empresa)) return 'Régimen Especial';
    const rnc = String(data.rnc ?? '').replace(/\D/g, '');
    if (rnc.length === 9) return 'Crédito Fiscal';
    return 'Consumidor Final';
  }

  async function crearCliente(data, prospectoOrigenId, deps) {
    const { prisma } = deps;
    // Auto-derivar tipoNcf ANTES de la transacción. Si el cliente ya envió uno,
    // se respeta. Si no, se infiere del tipoEmpresa + presencia de RNC.
    data.tipoNcf = _derivarTipoNcf(data);
    try {
      const cliente = await prisma.$transaction(async (tx) => {
        if (!data.noCliente) data.noCliente = await generarSiguienteCodigo('cliente', tx);
        const c = await repo.createClienteTx(tx, data);
        if (prospectoOrigenId) {
          if (!validUUID(prospectoOrigenId)) {
            throw new ClienteError(400, 'PROSPECTO_INVALID', 'prospectoOrigenId inválido.');
          }
          await repo.updateProspectoEstadoTx(tx, prospectoOrigenId, 'Convertido');
        }
        return c;
      });
      return { status: 201, body: formatCliente(cliente) };
    } catch (e) {
      if (e instanceof ClienteError) throw e;
      if (e.code === 'P2002')        throw new ClienteError(409, 'DUP_RNC', 'El RNC o número de cliente ya existe.');
      throw e;
    }
  }

  async function actualizarCliente(id, data) {
    try {
      const cliente = await repo.updateCliente(id, data);
      return { status: 200, body: formatCliente(cliente) };
    } catch (e) {
      if (e.code === 'P2025') throw new ClienteError(404, 'NOT_FOUND', 'Cliente no encontrado.');
      if (e.code === 'P2002') throw new ClienteError(409, 'DUP_RNC', 'El RNC ya existe en otro registro.');
      throw e;
    }
  }

  async function eliminarCliente(id, user, reqMeta) {
    const existing = await repo.findClienteById(id);
    if (!existing || existing.deletedAt) throw new ClienteError(404, 'NOT_FOUND', 'Cliente no encontrado.');
    await repo.softDeleteCliente(id);
    auditReq('crm:cliente_eliminado', _fakeReqForAudit(reqMeta, user), { clienteId: id });
    return { status: 204, body: null };
  }

  async function toggleCliente(id) {
    const current = await repo.findClienteById(id);
    if (!current) throw new ClienteError(404, 'NOT_FOUND', 'Cliente no encontrado.');
    const updated = await repo.toggleClienteActivo(
      id,
      !current.activo,
      !current.activo ? null : new Date(),
    );
    return { status: 200, body: formatCliente(updated) };
  }

  return {
    ClienteError,
    listarClientes,
    crearCliente,
    actualizarCliente,
    eliminarCliente,
    toggleCliente,
  };
}

module.exports = createClientesService;
module.exports.ClienteError = ClienteError;
