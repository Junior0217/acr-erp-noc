/**
 * backend/jobs/cron.js
 *
 * Factory de jobs CRON nocturnos del backend. Idempotente — solo registra
 * una vez por process. Cada job es un closure sobre `prisma` inyectado.
 *
 * Schedule timezone: America/Santo_Domingo.
 *
 * Jobs:
 *   - reconciliarStockNocturno     (03:00) drift Producto.stockActual vs MovimientoInventario
 *   - detectarAnomaliaDescuentos   (03:30) flag cajeros con avg > mean+2σ últimos 30d
 *   - alertaNCFVencimiento         (04:00) NCF con <100 restantes o vence en <30d
 *   - recordarRotacionBackupCodes  (04:30) empleados con ≤2 backup codes
 *   - expirarReservasOTPendientes  (cada 30 min) libera reservas TTL gt 7d sobre OTs Pendiente
 */

const cron = require('node-cron');

let _registered = false;

module.exports = function startCronJobs(deps) {
  if (_registered) return;
  _registered = true;
  const { prisma } = deps;
  if (!prisma) throw new Error('startCronJobs: prisma is required');

// MovimientoInventario (entradas - salidas). Registra en AuditCaja para que
// el panel del owner muestre los productos que necesitan re-conteo físico.
async function reconciliarStockNocturno() {
  const t0 = Date.now()
  try {
    const drifts = await prisma.$queryRaw`
      WITH movs AS (
        SELECT "productoId",
          SUM(CASE WHEN tipo = 'Entrada' THEN cantidad ELSE 0 END) AS entradas,
          SUM(CASE WHEN tipo = 'Salida'  THEN cantidad ELSE 0 END) AS salidas
        FROM "MovimientoInventario"
        GROUP BY "productoId"
      )
      SELECT p.id, p.sku, p.nombre, p."stockActual" AS stock_actual,
             COALESCE(m.entradas, 0) - COALESCE(m.salidas, 0) AS esperado,
             p."stockActual" - (COALESCE(m.entradas, 0) - COALESCE(m.salidas, 0)) AS drift
      FROM "Producto" p
      LEFT JOIN movs m ON m."productoId" = p.id
      WHERE p."tipoItem" = 'ARTICULO'
        AND p."stockActual" <> COALESCE(m.entradas, 0) - COALESCE(m.salidas, 0)
    `
    for (const d of drifts) {
      await prisma.auditCaja.create({ data: {
        tipo:    'stock_reconciliation_drift',
        detalle: `Producto ${d.sku} (${d.nombre}): stockActual=${d.stock_actual}, esperado=${d.esperado}, drift=${d.drift}`,
      }}).catch(() => {})
    }
    console.log(`[STOCK RECON] ${drifts.length} drifts detectados en ${Date.now() - t0}ms.`)
  } catch (e) {
    console.error('[STOCK RECON]', e.message)
  }
}
cron.schedule('0 3 * * *', reconciliarStockNocturno, { timezone: 'America/Santo_Domingo' })

// ─── Anomalía descuentos por cajero (sugerencia #3) ──────────────────────────
// 03:30 AM RD: calcula promedio + stddev global de descuentos en últimos 30
// días. Cualquier cajero con avg > mean + 2σ se flagea para revisión.
async function detectarAnomaliaDescuentos() {
  const t0 = Date.now()
  try {
    const desde = new Date(Date.now() - 30 * 86_400_000)
    const overall = await prisma.$queryRaw`
      SELECT AVG("descPct") AS m, COALESCE(STDDEV("descPct"), 0) AS s
      FROM "AuditCaja"
      WHERE tipo IN ('descuento_pin','descuento_rechazado') AND "createdAt" >= ${desde}
    `
    const gMean = Number(overall[0]?.m ?? 0)
    const gStd  = Number(overall[0]?.s ?? 0)
    const threshold = gMean + 2 * gStd
    if (threshold <= 0) {
      console.log('[ANOMALIA DESC] sin datos suficientes (umbral=0).')
      return
    }
    const rows = await prisma.$queryRaw`
      SELECT a."empleadoId", COALESCE(e.nombre, 'desconocido') AS nombre,
             COUNT(*)::int AS ventas, AVG(a."descPct") AS avg_desc,
             MAX(a."descPct") AS max_desc
      FROM "AuditCaja" a
      LEFT JOIN "Empleado" e ON e.id = a."empleadoId"
      WHERE a.tipo IN ('descuento_pin','descuento_rechazado')
        AND a."createdAt" >= ${desde}
        AND a."empleadoId" IS NOT NULL
      GROUP BY a."empleadoId", e.nombre
      HAVING COUNT(*) >= 5 AND AVG(a."descPct") > ${threshold}
    `
    for (const r of rows) {
      await prisma.auditCaja.create({ data: {
        tipo:       'anomalia_descuentos',
        empleadoId: Number(r.empleadoId),
        descPct:    Number(r.avg_desc),
        detalle:    `Cajero ${r.nombre} avg descuento ${Number(r.avg_desc).toFixed(2)}% (umbral ${threshold.toFixed(2)}%) en ${r.ventas} ventas últimos 30 días. Max=${Number(r.max_desc).toFixed(2)}%.`,
      }}).catch(() => {})
    }
    console.log(`[ANOMALIA DESC] ${rows.length} cajeros anómalos. Umbral 2σ=${threshold.toFixed(2)}%. Tiempo ${Date.now() - t0}ms.`)
  } catch (e) {
    console.error('[ANOMALIA DESC]', e.message)
  }
}
cron.schedule('30 3 * * *', detectarAnomaliaDescuentos, { timezone: 'America/Santo_Domingo' })

// ─── Alerta NCF vencimiento / agotamiento (sugerencia #5) ────────────────────
// 04:00 AM RD: revisa ConfiguracionNCF y alerta cuando una secuencia tiene
// < 100 NCF disponibles O vence en menos de 30 días. Owner ve en AuditCaja.
async function alertaNCFVencimiento() {
  const t0 = Date.now()
  try {
    const configs = await prisma.configuracionNCF.findMany({
      where:  { activo: true },
      select: { id: true, prefijo: true, tipoNcf: true, secuenciaActual: true, limite: true, vencimiento: true },
    })
    let alertas = 0
    for (const c of configs) {
      const restante = Number(c.limite) - Number(c.secuenciaActual)
      const venceEnDias = c.vencimiento
        ? Math.floor((new Date(c.vencimiento).getTime() - Date.now()) / 86_400_000)
        : null
      const lowStock  = restante < 100
      const expiring  = venceEnDias !== null && venceEnDias < 30
      if (lowStock || expiring) {
        await prisma.auditCaja.create({ data: {
          tipo:    'ncf_alerta',
          detalle: `NCF ${c.tipoNcf} (${c.prefijo}): ${restante} secuencias restantes${venceEnDias !== null ? `, vence en ${venceEnDias} día(s)` : ''}. ${lowStock ? '[AGOTAMIENTO]' : ''} ${expiring ? '[VENCIMIENTO]' : ''}`.trim(),
        }}).catch(() => {})
        alertas++
      }
    }
    console.log(`[NCF ALERTA] ${alertas}/${configs.length} secuencias en alerta. Tiempo ${Date.now() - t0}ms.`)
  } catch (e) {
    console.error('[NCF ALERTA]', e.message)
  }
}
cron.schedule('0 4 * * *', alertaNCFVencimiento, { timezone: 'America/Santo_Domingo' })

// ─── Auto-rotación recordatorio backup codes (sugerencia #4) ─────────────────
// 04:30 AM RD: empleados con 2FA + ≤2 backup codes -> registra en auditoría
// para que el owner les recuerde rotar. Frontend muestra banner via /api/auth/me.
async function recordarRotacionBackupCodes() {
  const t0 = Date.now()
  try {
    const empleados = await prisma.empleado.findMany({
      where:  { twoFactorEnabled: true, deletedAt: null },
      select: { id: true, nombre: true, email: true, backupCodes: true },
    })
    let recordatorios = 0
    for (const emp of empleados) {
      const count = Array.isArray(emp.backupCodes) ? emp.backupCodes.length : 0
      if (count <= 2) {
        await prisma.auditCaja.create({ data: {
          tipo:       'backup_codes_low',
          empleadoId: emp.id,
          detalle:    `Empleado ${emp.nombre} (${emp.email}) tiene ${count} backup code(s) restantes. Recomendar rotación.`,
        }}).catch(() => {})
        recordatorios++
      }
    }
    console.log(`[BACKUP CODES] ${recordatorios}/${empleados.length} empleados con códigos bajos. Tiempo ${Date.now() - t0}ms.`)
  } catch (e) {
    console.error('[BACKUP CODES]', e.message)
  }
}
cron.schedule('30 4 * * *', recordarRotacionBackupCodes, { timezone: 'America/Santo_Domingo' })

// ─── Expirar reservas de stock de OTs estancadas (TTL 7 días) ────────────────
// Cada 30 min recorre ReservaInventario.ordenId con expiraEn < NOW. Si la OT
// asociada sigue 'Pendiente', libera la reserva (marca liberada=true). Si la OT
// avanzó a EnProceso/Cerrada/Cancelada, el flujo de estado ya las manejó —
// solo liberamos las verdaderamente abandonadas.
async function expirarReservasOTPendientes() {
  const t0 = Date.now()
  try {
    const expiradas = await prisma.reservaInventario.findMany({
      where: {
        ordenId:  { not: null },
        liberada: false,
        expiraEn: { lt: new Date() },
      },
      include: { orden: { select: { id: true, noOT: true, estado: true } } },
    })
    let liberadas = 0
    for (const r of expiradas) {
      // Solo libera reservas de OTs aún Pendientes (sin movimiento).
      if (r.orden?.estado === 'Pendiente') {
        await prisma.reservaInventario.update({
          where: { id: r.id },
          data:  { liberada: true, motivo: `${r.motivo ?? ''} · TTL expirado ${new Date().toISOString().slice(0,10)}`.trim() },
        }).catch(() => {})
        liberadas++
      }
    }
    if (liberadas > 0) {
      console.log(`[OT TTL] ${liberadas}/${expiradas.length} reservas liberadas en ${Date.now() - t0}ms.`)
      await prisma.auditCaja.create({ data: {
        tipo: 'ot_reservas_ttl',
        detalle: `${liberadas} reservas liberadas por TTL 7d sobre OTs en Pendiente.`,
      }}).catch(() => {})
    }
  } catch (e) {
    console.error('[OT TTL]', e.message)
  }
}
cron.schedule('*/30 * * * *', expirarReservasOTPendientes, { timezone: 'America/Santo_Domingo' })

};
