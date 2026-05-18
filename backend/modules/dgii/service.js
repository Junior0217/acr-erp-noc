/**
 * backend/modules/dgii/service.js
 *
 * Lógica del módulo DGII. F1 scope: CRUD Compras.
 *
 * Cyber Neo Always-On aplicado:
 *   - A01: cada op respeta JWT + dgii:reportar (validado en router).
 *   - A03: queries 100% Prisma parametrizado.
 *   - A04: noCompra generado atómicamente vía generarSiguienteCodigo('compra', tx).
 *   - A08: soft-delete preserva auditoría 10 años (Norma DGII 06-2018 art. 7).
 *   - A09: cada CRUD dispara auditReq con enmascararRnc para no leak PII.
 */

class DgiiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createDgiiService(deps) {
  const { repo, prisma, auditReq, generarSiguienteCodigo, helpers } = deps;
  if (!repo)                                          throw new Error('createDgiiService: repo required');
  if (!prisma)                                        throw new Error('createDgiiService: prisma required');
  if (typeof auditReq !== 'function')                 throw new Error('createDgiiService: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createDgiiService: generarSiguienteCodigo required');
  if (!helpers)                                       throw new Error('createDgiiService: helpers required');
  const { validarRncRD, enmascararRnc } = helpers;
  if (typeof validarRncRD !== 'function')             throw new Error('createDgiiService: helpers.validarRncRD required');
  if (typeof enmascararRnc !== 'function')            throw new Error('createDgiiService: helpers.enmascararRnc required');

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

  // Identidad fiscal del suplidor: prefiere RNC; fallback cédula.
  // Devuelve `{ id, tipo }` o lanza DgiiError si suplidor no tiene ninguno o
  // si el RNC declarado no pasa dígito verificador (defensa anti datos basura
  // que rebotaría el archivo TXT al cargarlo en OFV).
  function _validarIdentidadFiscalSuplidor(suplidor) {
    if (!suplidor) throw new DgiiError(404, 'SUP_NOT_FOUND', 'Suplidor no encontrado.');
    if (suplidor.rnc && suplidor.rnc.trim()) {
      if (!validarRncRD(suplidor.rnc)) {
        throw new DgiiError(409, 'SUP_RNC_INVALID',
          `RNC del suplidor "${suplidor.razonSocial}" no pasa dígito verificador DGII. Corrige en CRM antes de registrar la compra.`);
      }
      return { id: suplidor.rnc.replace(/\D/g, ''), tipo: '1' };
    }
    if (suplidor.cedula && suplidor.cedula.trim()) {
      return { id: suplidor.cedula.replace(/\D/g, ''), tipo: '2' };
    }
    throw new DgiiError(409, 'SUP_SIN_ID',
      `Suplidor "${suplidor.razonSocial}" no tiene RNC ni cédula. DGII exige uno de los dos para 606.`);
  }

  // ── Listar Compras ──────────────────────────────────────────────────────
  async function listarCompras(query) {
    const take    = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const where   = { deletedAt: null };
    if (query.suplidorId) where.suplidorId = query.suplidorId;
    if (query.desde || query.hasta) {
      where.fechaComprobante = {};
      if (query.desde) where.fechaComprobante.gte = new Date(query.desde);
      if (query.hasta) where.fechaComprobante.lte = new Date(query.hasta);
    }
    if (query.search) {
      where.OR = [
        { noCompra:     { contains: query.search, mode: 'insensitive' } },
        { ncfProveedor: { contains: query.search, mode: 'insensitive' } },
        { suplidor:     { razonSocial: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    const [compras, total] = await repo.listCompras(where, take, skip);
    return {
      status: 200,
      body: {
        data: compras,
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function obtenerCompra(id) {
    const compra = await repo.findCompraById(id);
    if (!compra || compra.deletedAt) {
      throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');
    }
    return { status: 200, body: compra };
  }

  // ── Crear Compra ────────────────────────────────────────────────────────
  async function crearCompra(data, user, reqMeta) {
    const suplidor = await repo.findSuplidorById(data.suplidorId);
    _validarIdentidadFiscalSuplidor(suplidor);

    const dup = await repo.findCompraByNcf(data.suplidorId, data.ncfProveedor);
    if (dup) {
      throw new DgiiError(409, 'NCF_DUP',
        `Ya existe compra ${dup.noCompra} con NCF ${data.ncfProveedor} de este suplidor.`);
    }

    try {
      const compra = await prisma.$transaction(async (tx) => {
        const noCompra = await generarSiguienteCodigo('compra', tx);
        return repo.createCompraTx(tx, {
          ...data,
          noCompra,
          empleadoId: user?.sub ?? null,
        });
      });
      auditReq('dgii:compra_creada', _fakeReqForAudit(reqMeta, user), {
        compraId:    compra.id,
        noCompra:    compra.noCompra,
        suplidorRnc: enmascararRnc(suplidor.rnc ?? suplidor.cedula),
        ncf:         data.ncfProveedor,
        monto:       Number(data.montoServicios) + Number(data.montoBienes) + Number(data.itbisFacturado),
      });
      return { status: 201, body: compra };
    } catch (e) {
      if (e.code === 'P2002') throw new DgiiError(409, 'DUP', 'noCompra duplicado (reintentar).');
      if (e.code === 'P2003') throw new DgiiError(400, 'FK_INVALID', 'Suplidor inválido.');
      throw e;
    }
  }

  // ── Actualizar Compra ───────────────────────────────────────────────────
  async function actualizarCompra(id, data, user, reqMeta) {
    const existing = await repo.findCompraById(id);
    if (!existing || existing.deletedAt) throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');

    // Si cambian suplidor o NCF, re-validar fiscal + dup-check.
    if (data.suplidorId && data.suplidorId !== existing.suplidorId) {
      const sup = await repo.findSuplidorById(data.suplidorId);
      _validarIdentidadFiscalSuplidor(sup);
    }
    if (data.ncfProveedor && data.ncfProveedor !== existing.ncfProveedor) {
      const dup = await repo.findCompraByNcf(
        data.suplidorId ?? existing.suplidorId,
        data.ncfProveedor,
      );
      if (dup && dup.id !== id) {
        throw new DgiiError(409, 'NCF_DUP',
          `NCF ${data.ncfProveedor} ya registrado en compra ${dup.noCompra}.`);
      }
    }

    try {
      const compra = await repo.updateCompra(id, data);
      auditReq('dgii:compra_actualizada', _fakeReqForAudit(reqMeta, user), {
        compraId: id, campos: Object.keys(data),
      });
      return { status: 200, body: compra };
    } catch (e) {
      if (e.code === 'P2025') throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');
      throw e;
    }
  }

  // ── Eliminar Compra (soft delete) ───────────────────────────────────────
  //
  // Norma DGII 06-2018 art. 7: comprobantes deben preservarse 10 años. Por eso
  // soft delete — el row queda en BD, ignorado por listados y reportes, pero
  // existe para auditorías futuras.
  async function eliminarCompra(id, user, reqMeta) {
    const existing = await repo.findCompraById(id);
    if (!existing || existing.deletedAt) {
      throw new DgiiError(404, 'NOT_FOUND', 'Compra no encontrada.');
    }
    await repo.softDeleteCompra(id);
    auditReq('dgii:compra_eliminada', _fakeReqForAudit(reqMeta, user), {
      compraId: id, noCompra: existing.noCompra,
      ncf: existing.ncfProveedor,
    });
    return { status: 204, body: null };
  }

  // ── Historial Reportes (placeholder F2/F3) ──────────────────────────────
  async function listarHistorialReportes(query) {
    const take    = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const where = {};
    if (query.tipo)    where.tipo    = query.tipo;
    if (query.periodo) where.periodo = query.periodo;
    const [data, total] = await repo.listReportesHistorial(where, take, skip);
    return {
      status: 200,
      body: {
        data,
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  return {
    DgiiError,
    listarCompras,
    obtenerCompra,
    crearCompra,
    actualizarCompra,
    eliminarCompra,
    listarHistorialReportes,
  };
}

module.exports = createDgiiService;
module.exports.DgiiError = DgiiError;
