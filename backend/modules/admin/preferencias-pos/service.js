/**
 * backend/modules/admin/preferencias-pos/service.js
 *
 * Lógica de negocio (mínima): cada empleado autenticado puede leer y
 * actualizar SUS PROPIAS preferencias visuales del POS. Sin permisos
 * adicionales (es UX personal). Auditoría ligera.
 */

class PrefPosError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

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

function createPreferenciasPosService(deps) {
  const { repo, auditReq } = deps;
  if (!repo) throw new Error('createPreferenciasPosService: repo required');
  if (typeof auditReq !== 'function') throw new Error('createPreferenciasPosService: auditReq required');

  async function obtener(empleadoId) {
    if (!Number.isInteger(empleadoId) || empleadoId <= 0) {
      throw new PrefPosError(400, 'EMPLEADO_INVALIDO', 'empleadoId inválido.');
    }
    const row = await repo.obtener(empleadoId);
    return row;
  }

  async function actualizar(empleadoId, dto, user, reqMeta) {
    if (!Number.isInteger(empleadoId) || empleadoId <= 0) {
      throw new PrefPosError(400, 'EMPLEADO_INVALIDO', 'empleadoId inválido.');
    }
    const row = await repo.upsert(empleadoId, dto);
    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:     'UPDATE',
      tabla:      'UsuarioPreferenciasPOS',
      registroId: String(empleadoId),
      detalles:   { campos: Object.keys(dto) },
    });
    return row;
  }

  return { PrefPosError, obtener, actualizar };
}

module.exports = createPreferenciasPosService;
module.exports.PrefPosError = PrefPosError;
