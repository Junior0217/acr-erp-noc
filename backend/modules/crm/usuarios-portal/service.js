/**
 * backend/modules/crm/usuarios-portal/service.js
 */

class UsuarioPortalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createUsuariosPortalService(deps) {
  const { repo, auditReq } = deps;
  if (!repo)                            throw new Error('createUsuariosPortalService: repo required');
  if (typeof auditReq !== 'function')   throw new Error('createUsuariosPortalService: auditReq required');

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

  async function listarUsuarios(query) {
    const take = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (query.search) {
      where.OR = [
        { nombre:    { contains: query.search, mode: 'insensitive' } },
        { email:     { contains: query.search, mode: 'insensitive' } },
        { noUsuario: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [usuarios, total] = await repo.listUsuarios(where, take, skip);
    return {
      status: 200,
      body: {
        data: usuarios,
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function vincularUsuario(id, clienteId, user, reqMeta) {
    if (clienteId) {
      const cliente = await repo.findClienteById(clienteId);
      if (!cliente) throw new UsuarioPortalError(404, 'CLIENTE_NOT_FOUND', 'Cliente no encontrado.');
    }
    try {
      const usuario = await repo.vincularUsuario(id, clienteId);
      auditReq('portal:vincular', _fakeReqForAudit(reqMeta, user), { usuarioId: id, clienteId });
      return { status: 200, body: { usuario } };
    } catch (e) {
      if (e.code === 'P2025') throw new UsuarioPortalError(404, 'NOT_FOUND', 'Usuario portal no encontrado.');
      throw e;
    }
  }

  return { UsuarioPortalError, listarUsuarios, vincularUsuario };
}

module.exports = createUsuariosPortalService;
module.exports.UsuarioPortalError = UsuarioPortalError;
