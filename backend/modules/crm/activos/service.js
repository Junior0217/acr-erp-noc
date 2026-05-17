/**
 * backend/modules/crm/activos/service.js
 */

class ActivoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createActivosService(deps) {
  const { repo, auditReq } = deps;
  if (!repo)                            throw new Error('createActivosService: repo required');
  if (typeof auditReq !== 'function')   throw new Error('createActivosService: auditReq required');

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

  async function listarActivos(query) {
    const where = query.clienteId ? { clienteId: query.clienteId } : {};
    const data = await repo.listActivos(where);
    return { status: 200, body: { data } };
  }

  async function crearActivo(data, user, reqMeta) {
    try {
      const activo = await repo.createActivo(data);
      auditReq('cmdb:crear', _fakeReqForAudit(reqMeta, user), {
        activoId: activo.id, clienteId: data.clienteId, productoId: data.productoId,
      });
      return { status: 201, body: activo };
    } catch (e) {
      if (e.code === 'P2003') throw new ActivoError(400, 'FK_INVALID', 'Cliente o producto inválido.');
      throw e;
    }
  }

  async function eliminarActivo(id) {
    try {
      await repo.deleteActivo(id);
      return { status: 204, body: null };
    } catch (e) {
      if (e.code === 'P2025') throw new ActivoError(404, 'NOT_FOUND', 'Activo no encontrado.');
      throw e;
    }
  }

  async function listarTimeline(activoId) {
    try {
      const eventos = await repo.listTimeline(activoId);
      return { status: 200, body: { data: eventos } };
    } catch {
      return { status: 200, body: { data: [], _error: 'Error obteniendo historial.' } };
    }
  }

  async function crearTimelineEvento(activoId, data, user, reqMeta) {
    const ev = await repo.createTimelineEvento({
      activoId,
      evento:         data.evento,
      tecnicoId:      user?.sub ?? null,
      ordenTrabajoId: data.ordenTrabajoId ?? null,
      notas:          data.notas ?? null,
    });
    auditReq('cmdb:timeline', _fakeReqForAudit(reqMeta, user), {
      activoId, evento: data.evento,
    });
    return { status: 201, body: ev };
  }

  return {
    ActivoError,
    listarActivos, crearActivo, eliminarActivo,
    listarTimeline, crearTimelineEvento,
  };
}

module.exports = createActivosService;
module.exports.ActivoError = ActivoError;
