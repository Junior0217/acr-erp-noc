#!/usr/bin/env node
/**
 * backend/scripts/security/apply-security-migrations.cjs
 *
 * Aplica las 4 migrations security pendientes vía pooler (Supabase
 * pgbouncer NO soporta prepared statements pero `prisma db execute`
 * envía SQL plano por lo que SI funciona).
 *
 * Para cada migration:
 *   1. Verifica si ya está en _prisma_migrations (skip si sí).
 *   2. Ejecuta el SQL completo vía `prisma db execute --file`.
 *   3. INSERT en _prisma_migrations con checksum SHA-256 real.
 *
 * Idempotente: re-correr el script no duplica nada.
 *
 * Uso:  node backend/scripts/security/apply-security-migrations.cjs
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { PrismaClient } = require('@prisma/client');

// Splitea SQL en statements individuales respetando bloques $$...$$ (usados
// en CREATE FUNCTION) y comentarios de línea (--). No maneja comentarios de
// bloque multi-línea; no aparecen en nuestras migrations.
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inDollar = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next2 = sql.substr(i, 2);
    // comentario de linea -- ... \n
    if (!inDollar && next2 === '--') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    // bloque $$
    if (next2 === '$$') {
      inDollar = !inDollar;
      cur += '$$';
      i += 2;
      continue;
    }
    if (ch === ';' && !inDollar) {
      const trimmed = cur.trim();
      if (trimmed) out.push(trimmed);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');

// Las 4 security (orden cronológico).
const TARGETS = [
  '20260518130000_stock_nonneg_check_and_atomic_decrement',
  '20260518140000_movimiento_inventario_hash_chain',
  '20260518150000_audit_inmutable_triggers',
  '20260518160000_owner_alerts',
];

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function isApplied(prisma, name) {
  const rows = await prisma.$queryRaw`
    SELECT 1 FROM _prisma_migrations WHERE migration_name = ${name} LIMIT 1
  `;
  return rows.length > 0;
}

async function applySqlViaPrisma(prisma, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const statements = splitStatements(sql);
  console.log(`  ${statements.length} statement(s) a ejecutar`);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.split('\n')[0].slice(0, 80);
    console.log(`    [${i + 1}/${statements.length}] ${preview}${stmt.length > 80 ? '…' : ''}`);
    try {
      await prisma.$executeRawUnsafe(stmt);
    } catch (e) {
      console.error(`    ✗ FAIL en statement ${i + 1}: ${e.message}`);
      throw e;
    }
  }
}

async function recordMigration(prisma, name, checksum) {
  await prisma.$executeRawUnsafe(`
    INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
    VALUES (gen_random_uuid()::text, '${checksum}', NOW(), '${name}', NULL, NULL, NOW(), 1)
  `);
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[ERR] DATABASE_URL ausente. Verifica backend/.env.');
    process.exit(1);
  }
  console.log('Target DB:', process.env.DATABASE_URL.replace(/:[^@:]+@/, ':***@'));
  const prisma = new PrismaClient();
  try {
    for (const name of TARGETS) {
      console.log('\n=== ' + name + ' ===');
      if (await isApplied(prisma, name)) {
        console.log('  ✓ ya registrada en _prisma_migrations · skip');
        continue;
      }
      const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
      if (!fs.existsSync(sqlPath)) {
        console.log('  ✗ archivo no encontrado: ' + sqlPath);
        continue;
      }
      const sql      = fs.readFileSync(sqlPath, 'utf8');
      const checksum = sha256Hex(sql);
      console.log('  checksum: ' + checksum);
      await applySqlViaPrisma(prisma, sqlPath);
      await recordMigration(prisma, name, checksum);
      console.log('  ✓ aplicada y registrada');
    }
    console.log('\nDone.');
  } catch (e) {
    console.error('[ABORT]', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
