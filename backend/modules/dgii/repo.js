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
  };
}

module.exports = createDgiiRepo;
