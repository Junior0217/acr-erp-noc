/**
 * backend/modules/admin/reportes/repo.js
 */

function createReportesRepo(prisma) {
  if (!prisma) throw new Error('createReportesRepo: prisma required');

  // KPI single-CTE: 1 round-trip, 1 connection slot (PgBouncer-safe).
  async function fetchDashboardKPI(inicioMes) {
    const rows = await prisma.$queryRaw`
      WITH
        svc AS (
          SELECT
            COUNT(*) FILTER (WHERE estado = 'Activo')::int        AS activos,
            COUNT(*) FILTER (WHERE estado = 'Pendiente')::int     AS pendientes,
            COUNT(*) FILTER (WHERE estado = 'EnInstalacion')::int AS "enInstalacion",
            COUNT(*) FILTER (WHERE estado = 'Suspendido')::int    AS suspendidos,
            COUNT(*) FILTER (WHERE estado = 'Cancelado')::int     AS cancelados,
            COALESCE(SUM("precioMensual") FILTER (WHERE estado = 'Activo'), 0)::float8 AS ingresos
          FROM "Servicio"
        ),
        cli AS (
          SELECT
            COUNT(*)::int                              AS total,
            COUNT(*) FILTER (WHERE activo = true)::int AS activos
          FROM "Cliente"
          WHERE "deletedAt" IS NULL
        ),
        tec AS (SELECT COUNT(*)::int AS total FROM "Empleado"),
        oi  AS (
          SELECT COUNT(*) FILTER (WHERE estado = 'Pendiente')::int AS pendientes
          FROM "OrdenInstalacion"
        ),
        fac AS (
          SELECT
            COALESCE(SUM(total) FILTER (WHERE "fechaEmision" >= ${inicioMes} AND estado != 'Anulada'), 0)::float8  AS "facturadoMes",
            COUNT(*)            FILTER (WHERE "fechaEmision" >= ${inicioMes} AND estado != 'Anulada')::int        AS "facturasEmitidasMes",
            COALESCE(SUM(total) FILTER (WHERE estado = 'Pagada' AND "fechaPago" >= ${inicioMes}), 0)::float8     AS "cobradoMes",
            COUNT(*)            FILTER (WHERE estado = 'Vencida')::int                                            AS "vencidasCount",
            COALESCE(SUM(total) FILTER (WHERE estado = 'Vencida'), 0)::float8                                     AS "vencidasMonto"
          FROM "Factura"
        ),
        ots AS (
          SELECT
            COUNT(*) FILTER (WHERE estado = 'Pendiente')::int AS "otsPendientes",
            COUNT(*) FILTER (WHERE estado = 'EnProceso')::int AS "otsEnProceso"
          FROM "OrdenTrabajo"
        )
      SELECT
        svc.activos, svc.pendientes, svc."enInstalacion", svc.suspendidos, svc.cancelados, svc.ingresos,
        cli.total AS "totalClientes", cli.activos AS "clientesActivos",
        tec.total AS tecnicos,
        oi.pendientes AS "ordenesPendientes",
        fac."facturadoMes", fac."facturasEmitidasMes", fac."cobradoMes", fac."vencidasCount", fac."vencidasMonto",
        ots."otsPendientes", ots."otsEnProceso"
      FROM svc, cli, tec, oi, fac, ots
    `;
    return rows[0];
  }

  async function listStockCritico() {
    return prisma.producto.findMany({
      where:   { stockActual: { lte: 5 } },
      select:  { id: true, nombre: true, sku: true, stockActual: true },
      orderBy: { stockActual: 'asc' },
      take:    10,
    });
  }

  async function listNcfConfigsActivos() {
    return prisma.configuracionNCF.findMany({ where: { activo: true } });
  }

  async function listFacturasPagadas(desde) {
    return prisma.factura.findMany({
      where:  { esCotizacion: false, deletedAt: null, estado: 'Pagada', fechaEmision: { gte: desde } },
      select: { total: true, fechaEmision: true, lineas: { select: { itemCatalogo: { select: { tipoItem: true, nombre: true } } } } },
    });
  }

  async function listOtsCerradas(desde) {
    return prisma.ordenTrabajo.findMany({
      where:  { deletedAt: null, estado: 'Cerrada', updatedAt: { gte: desde } },
      select: { id: true, noOT: true, tipoOT: true, updatedAt: true, tecnico: { select: { id: true, nombre: true } } },
    });
  }

  async function listFacturasMes(desde) {
    return prisma.factura.findMany({
      where:  { esCotizacion: false, deletedAt: null, estado: 'Pagada', fechaEmision: { gte: desde } },
      select: { total: true },
    });
  }

  async function listOtsParaComisiones(inicio, fin) {
    return prisma.ordenTrabajo.findMany({
      where: {
        deletedAt: null,
        estado:    'Cerrada',
        tecnicoId: { not: null },
        tipoOT:    { in: ['Reparacion', 'Instalacion', 'CCTV'] },
        updatedAt: { gte: inicio, lt: fin },
      },
      select: {
        id: true, noOT: true, tipoOT: true, updatedAt: true,
        tecnico:  { select: { id: true, nombre: true } },
        facturas: { select: { total: true, estado: true }, take: 1 },
      },
    });
  }

  return {
    fetchDashboardKPI,
    listStockCritico,
    listNcfConfigsActivos,
    listFacturasPagadas,
    listOtsCerradas,
    listFacturasMes,
    listOtsParaComisiones,
  };
}

module.exports = createReportesRepo;
