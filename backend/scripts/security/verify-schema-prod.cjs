#!/usr/bin/env node
/**
 * backend/scripts/security/verify-schema-prod.cjs
 *
 * Audita el schema real en la DB de producción contra lo que las migrations
 * security esperan. Usa el DATABASE_URL del .env local (cargado via dotenv).
 * El password NUNCA aparece en el command line.
 *
 * Uso:
 *   node backend/scripts/security/verify-schema-prod.cjs
 *
 * Reporta:
 *   - Migrations registradas en _prisma_migrations
 *   - Existencia de tabla OwnerAlert, CotizacionEvento
 *   - Columnas hash/prevHash en MovimientoInventario
 *   - CHECK constraint Producto_stockActual_nonneg_chk
 *   - Trigger auditlog_block_update_delete
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { PrismaClient } = require('@prisma/client');

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[ERR] DATABASE_URL no encontrada en backend/.env');
    console.error('      El script lee dotenv desde backend/.env automáticamente.');
    process.exit(1);
  }
  console.log('[INFO] Conectando a:', dbUrl.replace(/:[^@:]+@/, ':***@'));

  const prisma = new PrismaClient();
  try {
    const migs = await prisma.$queryRaw`
      SELECT migration_name, finished_at IS NOT NULL AS ok
        FROM _prisma_migrations
       ORDER BY started_at ASC
    `;
    console.log(`\n--- _prisma_migrations · ${migs.length} rows ---`);
    migs.forEach(m => console.log(' ' + (m.ok ? '✓' : '✗') + ' ' + m.migration_name));

    const [ownerA] = await prisma.$queryRaw`SELECT to_regclass('public."OwnerAlert"')::text AS r`;
    const [cotEvt] = await prisma.$queryRaw`SELECT to_regclass('public."CotizacionEvento"')::text AS r`;
    const movHash  = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'MovimientoInventario' AND column_name IN ('hash','prevHash')
    `;
    const checkS   = await prisma.$queryRaw`
      SELECT conname FROM pg_constraint WHERE conname = 'Producto_stockActual_nonneg_chk'
    `;
    const trigAL   = await prisma.$queryRaw`
      SELECT tgname FROM pg_trigger WHERE tgname IN ('auditlog_block_update_delete','auditcaja_block_update_delete')
    `;
    const trigOA   = await prisma.$queryRaw`
      SELECT tgname FROM pg_trigger WHERE tgname = 'owner_alert_block_mutation'
    `;

    console.log('\n--- objetos esperados por migrations security ---');
    console.log(' tabla OwnerAlert:                      ' + (ownerA.r       || 'MISSING'));
    console.log(' tabla CotizacionEvento:                ' + (cotEvt.r       || 'MISSING'));
    console.log(' columna MovInv.hash + prevHash:        ' + (movHash.length === 2 ? 'EXISTS' : `PARTIAL (${movHash.length}/2)`));
    console.log(' CHECK Producto.stockActual >= 0:       ' + (checkS.length  ? 'EXISTS' : 'MISSING'));
    console.log(' trigger AuditLog/AuditCaja inmutable:  ' + (trigAL.length === 2 ? 'EXISTS' : `PARTIAL (${trigAL.length}/2)`));
    console.log(' trigger OwnerAlert inmutable:          ' + (trigOA.length  ? 'EXISTS' : 'MISSING'));
  } catch (e) {
    console.error('[ERR]', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
