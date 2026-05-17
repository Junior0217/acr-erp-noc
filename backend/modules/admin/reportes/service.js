/**
 * backend/modules/admin/reportes/service.js
 *
 * Dashboard cache + reportes semanal/comisiones. Cero mutaciones — solo lectura.
 */

const DASH_CACHE_TTL_MS = 60_000;
const TASA_COMISIONES = { Reparacion: 0.10, Instalacion: 0.08, CCTV: 0.10 };

class ReportesError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createReportesService(deps) {
  const { repo } = deps;
  if (!repo) throw new Error('createReportesService: repo required');

  // Singletons in-memory (preserved across calls via closure).
  let dashCache = null;
  let dashCacheExp = 0;

  async function getDashboard() {
    if (dashCache && Date.now() < dashCacheExp) {
      return { status: 200, body: dashCache };
    }
    const ahora = new Date();
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    const kpi = await repo.fetchDashboardKPI(inicioMes);
    const stockCritico = await repo.listStockCritico();
    let ncfAlerts = [];
    try {
      const ncfConfigs = await repo.listNcfConfigsActivos();
      ncfAlerts = ncfConfigs
        .filter(c => c.limite > 0 && c.secuenciaActual / c.limite >= 0.90)
        .map(c => ({
          tipoNcf:   c.tipoNcf,
          restantes: c.limite - c.secuenciaActual,
          pct:       Math.round((c.secuenciaActual / c.limite) * 100),
        }));
    } catch (ncfErr) {
      console.error('[DASHBOARD] ncfAlerts query failed:', ncfErr.message);
    }
    dashCache = {
      servicios: {
        activos:       Number(kpi.activos),
        pendientes:    Number(kpi.pendientes),
        enInstalacion: Number(kpi.enInstalacion),
        suspendidos:   Number(kpi.suspendidos),
        cancelados:    Number(kpi.cancelados),
      },
      ordenesPendientes:          Number(kpi.ordenesPendientes),
      stockCritico,
      ingresosMensualesEstimados: Number(kpi.ingresos),
      clientes: { total: Number(kpi.totalClientes), activos: Number(kpi.clientesActivos) },
      tecnicos:                   Number(kpi.tecnicos),
      billing: {
        facturadoMes:        Number(kpi.facturadoMes),
        facturasEmitidasMes: Number(kpi.facturasEmitidasMes),
        cobradoMes:          Number(kpi.cobradoMes),
        vencidasCount:       Number(kpi.vencidasCount),
        vencidasMonto:       Number(kpi.vencidasMonto),
        otsPendientes:       Number(kpi.otsPendientes),
        otsEnProceso:        Number(kpi.otsEnProceso),
      },
      ncfAlerts,
    };
    dashCacheExp = Date.now() + DASH_CACHE_TTL_MS;
    return { status: 200, body: dashCache };
  }

  async function getReporteSemanal() {
    try {
      const ahora     = new Date();
      const inicioDia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
      const inicioSemana = new Date(inicioDia);
      inicioSemana.setDate(inicioDia.getDate() - 6);
      const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

      const [facturas, ots, facturasMes] = await Promise.all([
        repo.listFacturasPagadas(inicioSemana),
        repo.listOtsCerradas(inicioSemana),
        repo.listFacturasMes(inicioMes),
      ]);

      const ingresosPorCategoria = {};
      let totalSemana = 0;
      for (const f of facturas) {
        const monto = Number(f.total);
        totalSemana += monto;
        const tipos = [...new Set(f.lineas.map(l => l.itemCatalogo?.tipoItem).filter(Boolean))];
        const cat = tipos.length > 0 ? tipos[0] : 'Otro';
        ingresosPorCategoria[cat] = (ingresosPorCategoria[cat] ?? 0) + monto;
      }

      const ingresoPorDia = {};
      for (let i = 0; i < 7; i++) {
        const d = new Date(inicioSemana);
        d.setDate(d.getDate() + i);
        ingresoPorDia[d.toISOString().slice(0, 10)] = 0;
      }
      for (const f of facturas) {
        const key = new Date(f.fechaEmision).toISOString().slice(0, 10);
        if (key in ingresoPorDia) ingresoPorDia[key] += Number(f.total);
      }

      return {
        status: 200,
        body: {
          semana:    { inicio: inicioSemana, fin: ahora },
          totalSemana,
          totalMes:  facturasMes.reduce((s, f) => s + Number(f.total), 0),
          ingresosPorCategoria,
          ingresoPorDia,
          otsCerradas: ots.length,
          otsDetalle:  ots.map(o => ({
            id: o.id, noOT: o.noOT, tipoOT: o.tipoOT,
            updatedAt: o.updatedAt, tecnicoNombre: o.tecnico?.nombre ?? null,
          })),
        },
      };
    } catch (e) {
      console.error('[REPORTE SEMANAL]', e.message);
      return {
        status: 200,
        body: {
          semana:               { inicio: null, fin: null },
          totalSemana:          0,
          totalMes:             0,
          ingresosPorCategoria: {},
          ingresoPorDia:        {},
          otsCerradas:          0,
          otsDetalle:           [],
          _error:               'Datos incompletos. Reintenta en unos segundos.',
        },
      };
    }
  }

  async function getReporteComisiones(query) {
    try {
      const year  = parseInt(query.anio, 10) || new Date().getFullYear();
      const month = parseInt(query.mes,  10) || new Date().getMonth() + 1;
      const inicio = new Date(year, month - 1, 1);
      const fin    = new Date(year, month,     1);

      const ots = await repo.listOtsParaComisiones(inicio, fin);
      const porTecnico = {};
      for (const ot of ots) {
        const fact = (ot.facturas || [])[0];
        const total = Number(fact?.total ?? 0);
        const tasa  = TASA_COMISIONES[ot.tipoOT] ?? 0.08;
        const comision = total * tasa;
        const nombre = ot.tecnico?.nombre ?? 'Desconocido';
        if (!porTecnico[nombre]) {
          porTecnico[nombre] = { nombre, ots: 0, totalFacturado: 0, comisionTotal: 0, detalle: [] };
        }
        porTecnico[nombre].ots++;
        porTecnico[nombre].totalFacturado += total;
        porTecnico[nombre].comisionTotal  += comision;
        porTecnico[nombre].detalle.push({
          noOT: ot.noOT, tipoOT: ot.tipoOT, total, tasa, comision, fecha: ot.updatedAt,
        });
      }
      return {
        status: 200,
        body: {
          periodo:         { mes: month, anio: year },
          tecnicos:        Object.values(porTecnico).sort((a, b) => b.comisionTotal - a.comisionTotal),
          totalComisiones: Object.values(porTecnico).reduce((s, t) => s + t.comisionTotal, 0),
        },
      };
    } catch (e) {
      console.error('[REPORTE COMISIONES]', e.message);
      return {
        status: 200,
        body: { periodo: { mes: null, anio: null }, tecnicos: [], totalComisiones: 0, _error: 'Datos incompletos.' },
      };
    }
  }

  return { ReportesError, getDashboard, getReporteSemanal, getReporteComisiones };
}

module.exports = createReportesService;
module.exports.ReportesError = ReportesError;
