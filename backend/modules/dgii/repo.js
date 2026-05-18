/**
 * backend/modules/dgii/repo.js
 *
 * Capa datos DGII. F1: Compras CRUD + secuencia noCompra atómica.
 * F2/F3 añadirán queries para 607 (Facturas) y 606 (Compras consolidadas).
 */

const COMPRA_LIST_INCLUDE = {
  suplidor: {
    select: {
      id: true, noSuplidor: true, razonSocial: true,
      rnc: true, cedula: true,
    },
  },
  empleado: { select: { id: true, nombre: true } },
};

function createDgiiRepo(prisma) {
  if (!prisma) throw new Error('createDgiiRepo: prisma required');

  // ── Compras ──────────────────────────────────────────────────────────────
  async function listCompras(where, take, skip) {
    return Promise.all([
      prisma.compra.findMany({
        where,
        include: COMPRA_LIST_INCLUDE,
        orderBy: { fechaComprobante: 'desc' },
        skip,
        take,
      }),
      prisma.compra.count({ where }),
    ]);
  }

  async function findCompraById(id) {
    return prisma.compra.findUnique({
      where: { id },
      include: COMPRA_LIST_INCLUDE,
    });
  }

  async function createCompraTx(tx, data) {
    return tx.compra.create({ data, include: COMPRA_LIST_INCLUDE });
  }

  async function updateCompra(id, data) {
    return prisma.compra.update({
      where: { id },
      data,
      include: COMPRA_LIST_INCLUDE,
    });
  }

  async function softDeleteCompra(id) {
    return prisma.compra.update({
      where: { id },
      data:  { deletedAt: new Date() },
    });
  }

  // ── Suplidor lookup (validación FK antes de insert) ─────────────────────
  async function findSuplidorById(id) {
    return prisma.suplidor.findUnique({
      where:  { id },
      select: { id: true, rnc: true, cedula: true, razonSocial: true, activo: true },
    });
  }

  // ── NCF dup-check dentro del mismo proveedor ────────────────────────────
  async function findCompraByNcf(suplidorId, ncfProveedor) {
    return prisma.compra.findFirst({
      where:  { suplidorId, ncfProveedor, deletedAt: null },
      select: { id: true, noCompra: true },
    });
  }

  // ── Empresa RNC (header del 606/607) ─────────────────────────────────────
  async function findEmpresaRnc() {
    const e = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { rnc: true, razonSocial: true },
    });
    return e;
  }

  // ── ReporteDGIIGenerado (audit trail — usado en F2/F3) ───────────────────
  async function createReporteRegistro(data) {
    return prisma.reporteDGIIGenerado.create({ data });
  }

  async function listReportesHistorial(where, take, skip) {
    return Promise.all([
      prisma.reporteDGIIGenerado.findMany({
        where,
        orderBy: { generadoEn: 'desc' },
        include: { empleado: { select: { id: true, nombre: true } } },
        skip, take,
      }),
      prisma.reporteDGIIGenerado.count({ where }),
    ]);
  }

  // ── Reporte 606: Compras del periodo ────────────────────────────────────
  //
  // Filtros DGII:
  //   - deletedAt=null (soft-deleted no van al 606 vigente; quedan archivadas
  //     10 años por art. 7 Norma 06-2018 pero no se reportan).
  //   - fechaComprobante en [start, end).
  //   - esGastoInformal=false — los gastos informales (caja chica, sin NCF)
  //     NUNCA se reportan a DGII. Norma 06-2018: solo gastos con NCF válido.
  //
  // SELECT explícito anti-leak: NO traemos passwordHash del empleado registrante.
  async function listComprasParaReporte606(periodoStart, periodoEnd) {
    return prisma.compra.findMany({
      where: {
        deletedAt:        null,
        esGastoInformal:  false,
        fechaComprobante: { gte: periodoStart, lt: periodoEnd },
      },
      orderBy: { fechaComprobante: 'asc' },
      select: {
        id:                       true,
        noCompra:                 true,
        ncfProveedor:             true,
        ncfModificado:            true,
        tipoBienServicio:         true,
        fechaComprobante:         true,
        fechaPago:                true,
        formaPago:                true,
        montoServicios:           true,
        montoBienes:              true,
        itbisFacturado:           true,
        itbisRetenido:            true,
        itbisProporcionalidad:    true,
        itbisLlevadoCosto:        true,
        itbisPorAdelantar:        true,
        itbisPercibido:           true,
        tipoRetencionIsr:         true,
        montoRetencionRenta:      true,
        isrPercibido:             true,
        impuestoSelectivoConsumo: true,
        otrosImpuestos:           true,
        propinaLegal:             true,
        suplidor: {
          select: { id: true, rnc: true, cedula: true, razonSocial: true },
        },
      },
    });
  }

  // ── Reporte 607: Facturas/ND/NC del periodo ─────────────────────────────
  //
  // Filtros DGII:
  //   - esCotizacion=false (cotizaciones NO van al 607)
  //   - deletedAt=null
  //   - ncf NOT NULL (sin NCF no es comprobante fiscal)
  //   - fechaEmision en [start, end)
  //   - estado != 'Borrador' (borradores no son fiscales)
  //
  // Notas Crédito (B04) e incluye facturas Anuladas dentro del periodo
  // — el service decide el signo (negativo) por documento.
  //
  // SELECT explícito anti-leak: NO traemos passwordHash de cliente/empleado.
  async function listFacturasParaReporte607(periodoStart, periodoEnd) {
    return prisma.factura.findMany({
      where: {
        esCotizacion: false,
        deletedAt:    null,
        ncf:          { not: null },
        fechaEmision: { gte: periodoStart, lt: periodoEnd },
        estado:       { not: 'Borrador' },
      },
      orderBy: { fechaEmision: 'asc' },
      select: {
        id:                       true,
        noFactura:                true,
        ncf:                      true,
        tipoNcf:                  true,
        esNotaCredito:            true,
        esNotaDebito:             true,
        facturaOrigenId:          true,
        estado:                   true,
        subtotal:                 true,
        itbis:                    true,
        total:                    true,
        fechaEmision:             true,
        fechaPago:                true,
        pagos:                    true,
        tipoIngreso:              true,
        fechaRetencion:           true,
        itbisRetenidoTercero:     true,
        itbisPercibido:           true,
        retencionRentaTercero:    true,
        isrPercibido:             true,
        impuestoSelectivoConsumo: true,
        otrosImpuestos:           true,
        propinaLegal:             true,
        cliente: {
          select: { id: true, rnc: true, cedula: true, tipoNcf: true, razonSocial: true },
        },
        facturaOrigen: { select: { ncf: true } },
      },
    });
  }

  // Audit lookup: ¿ya existe un reporte de este tipo+periodo+rnc?
  async function existeReporteEnCurso(tipo, periodo, rncEmpresa) {
    return prisma.reporteDGIIGenerado.findFirst({
      where:   { tipo, periodo, rncEmpresa },
      orderBy: { generadoEn: 'desc' },
      select:  { id: true, sha256: true, generadoEn: true, archivoUrl: true },
    });
  }

  return {
    listCompras,
    findCompraById,
    createCompraTx,
    updateCompra,
    softDeleteCompra,
    findSuplidorById,
    findCompraByNcf,
    findEmpresaRnc,
    createReporteRegistro,
    listReportesHistorial,
    listFacturasParaReporte607,
    listComprasParaReporte606,
    existeReporteEnCurso,
  };
}

module.exports = createDgiiRepo;
