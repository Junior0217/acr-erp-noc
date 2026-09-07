#!/usr/bin/env node
'use strict';
/**
 * backend/scripts/ops/keepalive.js
 *
 * Ping periódico a Supabase para evitar la auto-pausa por inactividad del plan
 * free (el proyecto se duerme y el pooler responde "tenant/user not found",
 * tumbando el backend en Render). Se ejecuta desde .github/workflows/keepalive.yml
 * cada 3 días, o manualmente: `node backend/scripts/ops/keepalive.js`.
 *
 * Además chequea el backend de Render (si BACKEND_URL está seteada) para
 * mantenerlo despierto y detectar caídas antes que el usuario.
 *
 * Exit codes: 0 = todo OK · 1 = BD inalcanzable (falla el workflow → notificación).
 *
 * L1.3: la URL de conexión sale de env (DATABASE_URL), nunca hardcodeada.
 */

const { PrismaClient } = require('@prisma/client');

const BACKEND_URL   = (process.env.BACKEND_URL ?? '').trim().replace(/\/+$/, '');
const MAX_INTENTOS  = Number(process.env.KEEPALIVE_RETRIES ?? 3);
const ESPERA_MS     = Number(process.env.KEEPALIVE_RETRY_MS ?? 5000);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function pingDb() {
  if (!process.env.DATABASE_URL) {
    console.error('[KEEPALIVE] DATABASE_URL no está seteada.');
    return false;
  }
  for (let i = 1; i <= MAX_INTENTOS; i++) {
    const prisma = new PrismaClient();
    try {
      const t0 = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      // Toca una tabla real para que Supabase cuente actividad de verdad.
      const clientes = await prisma.cliente.count({ where: { deletedAt: null } });
      console.log(`[KEEPALIVE] BD OK (${Date.now() - t0}ms) · clientes=${clientes}`);
      await prisma.$disconnect();
      return true;
    } catch (err) {
      const msg = String(err.message).split('\n').find(l => /FATAL|tenant|reach|Error querying/.test(l)) ?? err.message.slice(0, 80);
      console.error(`[KEEPALIVE] Intento ${i}/${MAX_INTENTOS} falló: ${msg.trim()}`);
      await prisma.$disconnect().catch(() => {});
      if (i < MAX_INTENTOS) await wait(ESPERA_MS);
    }
  }
  return false;
}

async function pingBackend() {
  if (!BACKEND_URL) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 120_000); // Render free: cold start lento
    const r = await fetch(`${BACKEND_URL}/api/health`, { signal: ctrl.signal });
    clearTimeout(to);
    const body = await r.json().catch(() => ({}));
    console.log(`[KEEPALIVE] Backend HTTP ${r.status} · dbConnected=${body.dbConnected} · version=${body.version ?? '?'}`);
    return r.ok && body.dbConnected !== false;
  } catch (err) {
    console.error(`[KEEPALIVE] Backend no responde: ${err.message}`);
    return false;
  }
}

(async () => {
  const dbOk      = await pingDb();
  const backendOk = await pingBackend();

  if (!dbOk) {
    console.error('[KEEPALIVE] BD INALCANZABLE - revisa si el proyecto Supabase esta pausado.');
    return 1;
  }
  if (backendOk === false) {
    console.error('[KEEPALIVE] BD OK pero el backend no responde - puede requerir restart en Render.');
    return 1;
  }
  console.log('[KEEPALIVE] Todo operativo.');
  return 0;
})()
  .catch(err => {
    console.error('[KEEPALIVE] Error inesperado:', err.message);
    return 1;
  })
  // exitCode (en vez de process.exit) deja que el event loop cierre sus handles
  // solo: process.exit() inmediato dispara un assert de libuv en Windows
  // (UV_HANDLE_CLOSING) al matar sockets del pool de Prisma todavia abiertos.
  .then(code => { process.exitCode = code; });
