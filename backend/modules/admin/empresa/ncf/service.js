/**
 * backend/modules/admin/empresa/ncf/service.js
 *
 * Lógica del sub-módulo NCF admin. Audita cada cambio de configuración —
 * la modificación del prefijo / vencimiento / activo afecta compliance
 * fiscal DGII, así que cada upsert queda en AuditLog inmutable.
 *
 * Factory: createNcfAdminService({ repo, auditReq })
 */

class NcfAdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createNcfAdminService(deps) {
  const { repo, auditReq } = deps;
  if (!repo)                          throw new Error('createNcfAdminService: repo required');
  if (typeof auditReq !== 'function') throw new Error('createNcfAdminService: auditReq required');

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

  async function listarConfiguraciones() {
    const data = await repo.listConfiguraciones();
    return { status: 200, body: { data } };
  }

  async function upsertConfiguracion(data, user, reqMeta) {
    const config = await repo.upsertConfiguracion(data);
    auditReq('empresa:ncf_config_upsert', _fakeReqForAudit(reqMeta, user), {
      tipoNcf:     data.tipoNcf,
      prefijo:     data.prefijo,
      limite:      data.limite,
      vencimiento: data.vencimiento ?? null,
      activo:      data.activo,
    });
    return { status: 200, body: config };
  }

  return { NcfAdminError, listarConfiguraciones, upsertConfiguracion };
}

module.exports = createNcfAdminService;
module.exports.NcfAdminError = NcfAdminError;
