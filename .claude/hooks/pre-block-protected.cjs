#!/usr/bin/env node
/**
 * Hook PreToolUse · Bloqueo de Modificación Crítica.
 *
 * Rechaza Edit sobre dos categorías de archivos:
 *   1. `.env*`           → credenciales en plain text. Editar desde Claude
 *                          puede exfiltrar via transcript o pisar secrets.
 *   2. `backend/prisma/migrations/<dir>/migration.sql` → migration ya
 *                          aplicada. Modificarla rompe el checksum de
 *                          `_prisma_migrations` y `prisma migrate deploy`
 *                          falla en Render con error fatal en producción.
 *
 * Exit code 2 → el harness aborta el tool call y muestra stderr a Claude.
 *
 * Para crear migration NUEVA: Claude usa Write con timestamp futuro
 * (no es Edit; este hook solo aplica a Edit por matcher en settings.json).
 */

'use strict';

const rawPath = process.env.CLAUDE_FILE_PATH || '';
if (!rawPath) process.exit(0);

const norm = rawPath.replace(/\\/g, '/');
const basename = norm.split('/').pop() || '';

const isEnv       = basename.startsWith('.env');
const isMigration = /\/backend\/prisma\/migrations\/[^/]+\/migration\.sql$/i.test(norm);

if (isEnv) {
  process.stderr.write(
    `BLOCKED: ${rawPath}\n` +
    '  Razón: archivo .env contiene credenciales. Editarlo via Claude\n' +
    '  puede filtrar secrets al transcript o pisar valores de prod.\n' +
    '  Editá manualmente fuera del agente.\n'
  );
  process.exit(2);
}

if (isMigration) {
  process.stderr.write(
    `BLOCKED: ${rawPath}\n` +
    '  Razón: migration Prisma ya aplicada. Modificarla rompe el\n' +
    '  checksum de _prisma_migrations → migrate deploy falla en prod.\n' +
    '  Crea NUEVA migration con timestamp futuro para cambiar schema.\n'
  );
  process.exit(2);
}

process.exit(0);
