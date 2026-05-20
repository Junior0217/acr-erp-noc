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
  const {
    repo, auditReq, generarSiguienteCodigo, formatCliente, validUUID,
    // L1.1 RLS opt-in (ver facturas/service.js para racional).
    withCurrentUserRls,
  } = deps;
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

  // Auto-derivación de tipoNcf basado en figura jurídica del cliente.
  // Sincronizado con el select del frontend `FormularioCliente.jsx`. Cambiar
  // la spelling aquí o allá rompe el mapping — modificar ambos.
  //
  // Mapping DGII (Norma 06-2018 + 05-2019):
  //   SRL, EIRL, SA, SAS                       → Crédito Fiscal (B01)
  //   Persona Física, Informal                 → Consumidor Final (B02)
  //   ONG, Zona Franca                         → Régimen Especial (B14)
  //   Gobierno Central, Ayuntamiento/Municipal → Gubernamental (B15)
  //   Extranjero                               → Exportaciones (B16)
  //
  // El `tipoNcf` enviado explícitamente desde el frontend siempre prevalece.
  // Fallback heurístico (RNC válido → B01, sino B02) cubre clientes legacy
  // que no tengan `tipoEmpresa` seteado.
  const _MAP_TIPO_EMPRESA_NCF = {
    'srl':                          'Crédito Fiscal',
    'sa':                           'Crédito Fiscal',
    'eirl':                         'Crédito Fiscal',
    'sas':                          'Crédito Fiscal',
    'persona física':               'Consumidor Final',
    'persona fisica':               'Consumidor Final',
    'informal / sin comprobante':   'Consumidor Final',
    'informal':                     'Consumidor Final',
    'ong / sin fines de lucro':     'Régimen Especial',
    'ong':                          'Régimen Especial',
    'zona franca':                  'Régimen Especial',
    'gobierno central':             'Gubernamental',
    'ayuntamiento / municipal':     'Gubernamental',
    'ayuntamiento':                 'Gubernamental',
    'extranjero':                   'Exportaciones',
  };
  function _derivarTipoNcf(data) {
    if (data.tipoNcf && data.tipoNcf.trim()) return data.tipoNcf;
    const empresa = String(data.tipoEmpresa ?? '').toLowerCase().trim();
    // 1) Lookup exacto en mapping (cubre el select del frontend).
    if (_MAP_TIPO_EMPRESA_NCF[empresa]) return _MAP_TIPO_EMPRESA_NCF[empresa];
    // 2) Heurística por substring (clientes legacy con texto libre).
    if (/(gobierno|estatal|municipal|gubern|ayuntamiento)/.test(empresa)) return 'Gubernamental';
    if (/(extranjer|exportac)/.test(empresa))                             return 'Exportaciones';
    if (/(zona\s*franca|ong|exonerad|regimen\s*especial|régimen\s*especial)/.test(empresa)) return 'Régimen Especial';
    // 3) Fallback por RNC: persona jurídica → B01, persona física → B02.
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

  // ─── L1.1 RLS — listado enforced bajo política rls_owner_match ─────────────
  // Cliente NO tiene owner column (ver schema.prisma). La política para esa
  // tabla cae al fallback "presencia de employee_id". Aún así, ejecutamos
  // dentro de withCurrentUserRls para validar que la pipeline está sana:
  // - El SET LOCAL se aplica (RLS confirma sesión legítima),
  // - El test smoke valida que la tx funciona end-to-end.
  // Cuando el schema agregue una columna owner explícita a Cliente, esta
  // función queda lista para filtrar por ella sin más wiring.
  async function listarMisClientesRls(query, user) {
    if (typeof withCurrentUserRls !== 'function') {
      throw new ClienteError(500, 'RLS_WRAPPER_MISSING',
        'withCurrentUserRls no disponible — RLS enforce inoperante.');
    }
    if (!user?.sub) {
      throw new ClienteError(401, 'NO_USER', 'user.sub requerido para RLS owner-match.');
    }
    const take    = Math.min(Math.max(parseInt(query?.limit, 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query?.page, 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    return withCurrentUserRls(async (tx) => {
      const where = { deletedAt: null };
      const [clientes, total] = await Promise.all([
        tx.cliente.findMany({ where, take, skip, orderBy: { razonSocial: 'asc' } }),
        tx.cliente.count({ where }),
      ]);
      return {
        status: 200,
        body: {
          data: clientes.map(formatCliente),
          meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1), rlsEnforced: true },
        },
      };
    });
  }

  return {
    ClienteError,
    listarClientes,
    crearCliente,
    actualizarCliente,
    eliminarCliente,
    toggleCliente,
    listarMisClientesRls,
  };
}

module.exports = createClientesService;
module.exports.ClienteError = ClienteError;
