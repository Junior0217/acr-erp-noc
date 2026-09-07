#!/usr/bin/env node
/**
 * test-db-conn.cjs · Test atómico de conexión.
 *
 * Construye URL desde DB_USER + DB_PASS + DB_HOST + DB_DB en env vars.
 * Permite separar password (segura via Read-Host) del template URL.
 *
 * Uso (PowerShell):
 *   $env:DB_USER = "postgres.eqmovbodoqdwrvbusaqk"
 *   $env:DB_HOST = "aws-1-us-east-1.pooler.supabase.com:6543"
 *   $env:DB_DB   = "postgres"
 *   $pass = Read-Host -AsSecureString "Pega password"
 *   $env:DB_PASS = [System.Net.NetworkCredential]::new('', $pass).Password
 *   node backend/scripts/security/test-db-conn.cjs
 *
 * O via URL completa (legacy):
 *   $env:DB_URL = "<url-completa-con-pass>"
 *   node backend/scripts/security/test-db-conn.cjs
 */
'use strict';

const { PrismaClient } = require('@prisma/client');

(async () => {
  let url = process.env.DB_URL;
  // Construcción desde partes (preferido — separa password de URL)
  if (!url && process.env.DB_USER && process.env.DB_PASS && process.env.DB_HOST && process.env.DB_DB) {
    const user = process.env.DB_USER.trim();
    const pass = process.env.DB_PASS.trim();
    const host = process.env.DB_HOST.trim();
    const db   = process.env.DB_DB.trim();
    const passEnc = encodeURIComponent(pass);
    url = `postgresql://${user}:${passEnc}@${host}/${db}`;
    console.log('[INFO] URL construido desde partes. Password length:', pass.length, '· bytes:', Buffer.byteLength(pass, 'utf8'));
    if (pass.length !== Buffer.byteLength(pass, 'utf8')) {
      console.warn('[WARN] Password tiene chars unicode (length != bytes). Probable typo invisible.');
    }
  }
  if (!url) {
    console.error('[ERR] Faltan env vars. Opciones:');
    console.error('  A) $env:DB_URL = "<url-completo>"');
    console.error('  B) $env:DB_USER + DB_PASS + DB_HOST + DB_DB seteados');
    process.exit(1);
  }
  url = url.trim();

  // Validación básica
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    console.error('[ERR] URL no empieza con postgresql:// o postgres://');
    console.error('URL recibida (primeros 30 chars):', url.slice(0, 30));
    process.exit(1);
  }

  // Auto-anexar flags si faltan (Prisma + pgbouncer transaction-mode)
  if (!url.includes('pgbouncer=')) {
    url += url.includes('?') ? '&pgbouncer=true' : '?pgbouncer=true';
    console.log('[INFO] Añadido pgbouncer=true (faltaba).');
  }
  if (!url.includes('connection_limit=')) {
    url += '&connection_limit=1';
  }

  // Mask password para log
  const masked = url.replace(/:[^@:]+@/, ':***@');
  console.log('[INFO] Conectando a:', masked);

  // Validación de username (debe tener el suffix del project ref en pooler)
  const userMatch = url.match(/\/\/([^:]+):/);
  if (userMatch) {
    const user = userMatch[1];
    console.log('[INFO] Username detectado:', user);
    if (user === 'postgres' && url.includes('pooler.supabase.com')) {
      console.warn('[WARN] Username es solo "postgres" sin suffix de proyecto.');
      console.warn('       El pooler de Supabase espera "postgres.<project_ref>".');
      console.warn('       Continuando igual para ver el error exacto del DB...');
    }
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const t0 = Date.now();
    const r = await prisma.$queryRaw`SELECT current_user AS u, current_database() AS d, version() AS v`;
    const ms = Date.now() - t0;
    console.log('');
    console.log('✓ CONEXIÓN OK (latencia ' + ms + ' ms)');
    console.log('  current_user:     ' + r[0].u);
    console.log('  current_database: ' + r[0].d);
    console.log('  postgres_version: ' + r[0].v.split(' ').slice(0, 2).join(' '));
  } catch (e) {
    console.log('');
    console.error('✗ AUTH FAIL');
    console.error('  Mensaje:', e.message.split('\n').filter(l => l.trim()).slice(0, 4).join(' | '));
  } finally {
    await prisma.$disconnect();
  }
})();
