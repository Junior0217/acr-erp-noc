/**
 * backend/prisma/seeds/_audit.js
 *
 * Auditor cross-tabla de filas huérfanas. Las FK con `onDelete: Cascade`
 * cubren el caso HARD-delete del empleado, pero el modelo usa SOFT-delete
 * (`Empleado.deletedAt != null`): la fila padre persiste, y las filas
 * dependientes en otras tablas (SessionToken, WebAuthnCredential,
 * UsuarioPreferenciasPOS) quedan vinculadas a un empleado "muerto pero vivo".
 *
 * Eso es DATA DRIFT — no rompe consultas (FK sigue válida) pero:
 *   - SessionToken huérfano permite resucitar la cuenta vía cookie aún
 *     válida si por error se restaura el empleado.
 *   - WebAuthnCredential huérfana queda como puerta trasera latente.
 *   - UsuarioPreferenciasPOS huérfana sesga métricas de adopción.
 *
 * Política: el auditor SOLO REPORTA. La decisión de purga la toma el
 * propietario (script manual o cron con cool-off para no perder data en
 * restauraciones legítimas).
 *
 * Dos modos:
 *   1) Standalone CLI: `node backend/prisma/seeds/_audit.js`
 *   2) Embedded en boot: `require('./_audit').runAudit({ prisma })`
 */

/**
 * runAudit — cuenta filas huérfanas por tabla. Una fila es huérfana cuando su
 * `empleadoId` apunta a un Empleado con `deletedAt != null`. NO cuenta el caso
 * empleadoId apuntando a fila inexistente porque la FK Cascade lo hace
 * imposible (Postgres rechazaría la transacción).
 *
 * @param {{ prisma: import('@prisma/client').PrismaClient }} deps
 * @returns {Promise<{
 *   ok: boolean,
 *   empleadosSoftDeleted: number,
 *   tablas: {
 *     usuarioPreferenciasPOS: { huerfanos: number, total: number, sampleIds: number[] },
 *     sessionToken:           { huerfanos: number, total: number, sampleIds: number[] },
 *     webauthnCredential:     { huerfanos: number, total: number, sampleIds: number[] },
 *   },
 *   totalHuerfanos: number,
 * }>}
 */
async function runAudit({ prisma }) {
  if (!prisma) throw new Error('runAudit: prisma required');

  const empleadosSoftDeleted = await prisma.empleado.findMany({
    where:  { deletedAt: { not: null } },
    select: { id: true },
  });
  const idsMuertos = empleadosSoftDeleted.map((e) => e.id);

  // Si no hay empleados soft-deleted, no hay huérfanos por definición.
  if (idsMuertos.length === 0) {
    const [prefsTotal, stTotal, waTotal] = await Promise.all([
      prisma.usuarioPreferenciasPOS.count(),
      prisma.sessionToken.count(),
      prisma.webAuthnCredential.count(),
    ]);
    return {
      ok: true,
      empleadosSoftDeleted: 0,
      tablas: {
        usuarioPreferenciasPOS: { huerfanos: 0, total: prefsTotal, sampleIds: [] },
        sessionToken:           { huerfanos: 0, total: stTotal,    sampleIds: [] },
        webauthnCredential:     { huerfanos: 0, total: waTotal,    sampleIds: [] },
      },
      totalHuerfanos: 0,
    };
  }

  // Conteos en paralelo + sample de 5 ids para diagnóstico.
  const [prefsHuerfanos, prefsTotal, prefsSample,
         stHuerfanos,    stTotal,    stSample,
         waHuerfanos,    waTotal,    waSample] = await Promise.all([
    prisma.usuarioPreferenciasPOS.count({ where: { empleadoId: { in: idsMuertos } } }),
    prisma.usuarioPreferenciasPOS.count(),
    prisma.usuarioPreferenciasPOS.findMany({
      where:  { empleadoId: { in: idsMuertos } },
      select: { empleadoId: true },
      take:   5,
    }),
    prisma.sessionToken.count({ where: { empleadoId: { in: idsMuertos } } }),
    prisma.sessionToken.count(),
    prisma.sessionToken.findMany({
      where:  { empleadoId: { in: idsMuertos } },
      select: { empleadoId: true },
      take:   5,
    }),
    prisma.webAuthnCredential.count({ where: { empleadoId: { in: idsMuertos } } }),
    prisma.webAuthnCredential.count(),
    prisma.webAuthnCredential.findMany({
      where:  { empleadoId: { in: idsMuertos } },
      select: { empleadoId: true },
      take:   5,
    }),
  ]);

  const totalHuerfanos = prefsHuerfanos + stHuerfanos + waHuerfanos;

  return {
    ok: true,
    empleadosSoftDeleted: idsMuertos.length,
    tablas: {
      usuarioPreferenciasPOS: {
        huerfanos: prefsHuerfanos,
        total:     prefsTotal,
        sampleIds: prefsSample.map((r) => r.empleadoId),
      },
      sessionToken: {
        huerfanos: stHuerfanos,
        total:     stTotal,
        sampleIds: stSample.map((r) => r.empleadoId),
      },
      webauthnCredential: {
        huerfanos: waHuerfanos,
        total:     waTotal,
        sampleIds: waSample.map((r) => r.empleadoId),
      },
    },
    totalHuerfanos,
  };
}

/**
 * formatReport — convierte el resultado del audit en una línea grep-friendly
 * para el log estructurado del backend. Diseño compatible con el prefix
 * `[AUDIT:orphans]` que server.js loguea al boot (post-seed).
 */
function formatReport(report) {
  const t = report.tablas;
  return (
    `[AUDIT:orphans] empleados_soft_deleted=${report.empleadosSoftDeleted} ` +
    `total_huerfanos=${report.totalHuerfanos} ` +
    `prefs=${t.usuarioPreferenciasPOS.huerfanos}/${t.usuarioPreferenciasPOS.total} ` +
    `session=${t.sessionToken.huerfanos}/${t.sessionToken.total} ` +
    `webauthn=${t.webauthnCredential.huerfanos}/${t.webauthnCredential.total}`
  );
}

module.exports = { runAudit, formatReport };

// ─── Standalone CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  runAudit({ prisma })
    .then((r) => {
      console.log(formatReport(r));
      if (r.totalHuerfanos > 0) {
        console.log('Sample ids (primeros 5 por tabla):');
        console.log('  prefs:    ', r.tablas.usuarioPreferenciasPOS.sampleIds.join(', '));
        console.log('  session:  ', r.tablas.sessionToken.sampleIds.join(', '));
        console.log('  webauthn: ', r.tablas.webauthnCredential.sampleIds.join(', '));
      }
    })
    .catch((err) => {
      console.error('[AUDIT:orphans] ERROR:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
