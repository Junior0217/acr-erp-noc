/**
 * backend/scripts/ops/purge-cotizaciones-perdidas-viejas.cjs
 *
 * Cron purga borradores del Cotizador Libre con estado='Perdida' y sin
 * actividad en los últimos 90 días. Mantiene la BD limpia y libera
 * espacio de fotos base64 que ya no aportan valor (la cotización no se
 * convirtió en venta y el cliente perdió interés hace meses).
 *
 * Reglas:
 *   - Solo elimina drafts con `meta.estado === 'Perdida'`.
 *   - `updatedAt < now() - 90 days` (configurable via DRY_DAYS env).
 *   - DRY_RUN=1 → solo lista candidatos, no borra.
 *   - Idempotente: correr 2 veces no causa errores.
 *
 * Uso:
 *   node backend/scripts/ops/purge-cotizaciones-perdidas-viejas.cjs
 *   DRY_RUN=1 node backend/scripts/ops/purge-cotizaciones-perdidas-viejas.cjs
 *   DRY_DAYS=60 node backend/scripts/ops/purge-cotizaciones-perdidas-viejas.cjs
 *
 * Programación (Render Cron Job sugerida):
 *   Schedule: 0 3 * * *      (diario a las 3:00 AM)
 *   Command:  node backend/scripts/ops/purge-cotizaciones-perdidas-viejas.cjs
 *
 * Para ambientes sin cron externo, también puede llamarse desde
 * `backend/jobs/cron.js` registrando el handler.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const DRY_RUN  = process.env.DRY_RUN === '1';
const DRY_DAYS = Math.max(7, parseInt(process.env.DRY_DAYS || '90', 10));

async function main() {
  const cutoff = new Date(Date.now() - DRY_DAYS * 24 * 60 * 60 * 1000);

  console.log(`[PURGE] estado='Perdida', updatedAt < ${cutoff.toISOString()} (${DRY_DAYS} días)`);
  console.log(`[PURGE] DRY_RUN=${DRY_RUN ? 'true (sin borrar)' : 'false (borrado real)'}`);

  // Prisma JSONB path filter — encuentra drafts donde meta.estado='Perdida'.
  // Usa el índice GIN sobre meta (migration 20260521000000_cotizador_libre_meta_gin_idx).
  const candidatos = await prisma.cotizacionLibreDraft.findMany({
    where: {
      meta:      { path: ['estado'], equals: 'Perdida' },
      updatedAt: { lt: cutoff },
    },
    select: {
      id:              true,
      numeroDocumento: true,
      empleadoId:      true,
      updatedAt:       true,
      cliente:         true,
    },
  });

  if (candidatos.length === 0) {
    console.log('[PURGE] Sin candidatos. Nada que purgar.');
    return;
  }

  console.log(`[PURGE] ${candidatos.length} candidato${candidatos.length === 1 ? '' : 's'} para purga:`);
  for (const c of candidatos) {
    const cli = (c.cliente && typeof c.cliente === 'object' && c.cliente.razonSocial) || '—';
    console.log(`  - #${c.id}  ${c.numeroDocumento}  ·  emp ${c.empleadoId}  ·  ${cli}  ·  ${c.updatedAt.toISOString()}`);
  }

  if (DRY_RUN) {
    console.log('[PURGE] DRY_RUN — sin cambios. Setear DRY_RUN=0 para purga real.');
    return;
  }

  const result = await prisma.cotizacionLibreDraft.deleteMany({
    where: {
      id: { in: candidatos.map(c => c.id) },
    },
  });
  console.log(`[PURGE] OK — ${result.count} borrador${result.count === 1 ? '' : 'es'} eliminados.`);
}

main()
  .catch((e) => {
    console.error('[PURGE] FAIL:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
