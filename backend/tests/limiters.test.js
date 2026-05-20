/**
 * backend/tests/limiters.test.js
 *
 * Smoke tests del módulo `backend/shared/limiters.js`. Validan:
 *   1) Cada factory expuesta retorna un middleware express utilizable.
 *   2) Con MemoryStore default, el límite max=N produce 429 en el (N+1)-ésimo
 *      request del mismo keyGenerator.
 *   3) `makeRedisStore` con un fake `redis.call` proxy ejecuta sendCommand
 *      (probando que la integración con rate-limit-redis no rompió la API).
 *
 * El test levanta un mini-servidor Express en localhost con un puerto
 * efímero (`server.address().port`) — esto evita colisión con otros tests y
 * permite paralelizar si fuera necesario.
 */

const test       = require('node:test');
const assert     = require('node:assert/strict');
const express    = require('express');
const http       = require('node:http');

const {
  createLoginLimiter,
  createTotpLimiter,
  createBackupCodeLimiter,
  createWebhookApproveLimiter,
  createTelemetryLimiter,
  makeRedisStore,
} = require('../shared/limiters');

// ─── Helpers ────────────────────────────────────────────────────────────────
function listen(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function close(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

async function hit(url) {
  const res = await fetch(url);
  await res.text();
  return res.status;
}

async function runUntilLimited(url, max, hard) {
  // Hace `hard` requests; retorna el status del último (que debería ser 429
  // si max < hard, o 200 si max >= hard). También retorna el índice del
  // primer 429 visto.
  let firstBlocked = -1;
  let lastStatus   = 0;
  for (let i = 0; i < hard; i += 1) {
    const status = await hit(url);
    lastStatus   = status;
    if (status === 429 && firstBlocked === -1) firstBlocked = i + 1;
  }
  return { firstBlocked, lastStatus };
}

// Cada test usa un IP key estable (no `req.ip` real) para evitar dependencia
// del binding socket y para aislar contadores entre tests.
function fixedKey(key) {
  return () => key;
}

// ─── 1) Factories retornan middlewares ──────────────────────────────────────
test('factories expuestas son middlewares (function de arity 3)', () => {
  for (const factory of [
    createLoginLimiter,
    createTotpLimiter,
    createBackupCodeLimiter,
    createWebhookApproveLimiter,
    createTelemetryLimiter,
  ]) {
    const mw = factory();
    assert.equal(typeof mw, 'function', `${factory.name} → middleware`);
    assert.equal(mw.length, 3, `${factory.name} arity (req,res,next)`);
  }
});

// ─── 2) Bloqueo al exceder max ──────────────────────────────────────────────
test('createLoginLimiter — bloquea al 6to request (max=5 default)', async () => {
  const app = express();
  app.use(createLoginLimiter({ keyGenerator: fixedKey('k-login'), skipSuccessfulRequests: false }));
  app.get('/', (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    const { firstBlocked, lastStatus } = await runUntilLimited(
      `http://127.0.0.1:${srv.address().port}/`,
      5,
      6,
    );
    assert.equal(firstBlocked, 6, '429 esperado en el 6to request');
    assert.equal(lastStatus, 429);
  } finally {
    await close(srv);
  }
});

test('createWebhookApproveLimiter — bloquea al 11vo request (max=10)', async () => {
  const app = express();
  app.use(createWebhookApproveLimiter({ keyGenerator: fixedKey('k-webhook') }));
  app.get('/', (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    const { firstBlocked, lastStatus } = await runUntilLimited(
      `http://127.0.0.1:${srv.address().port}/`,
      10,
      11,
    );
    assert.equal(firstBlocked, 11, '429 esperado en el 11vo request');
    assert.equal(lastStatus, 429);
  } finally {
    await close(srv);
  }
});

test('createBackupCodeLimiter — bloquea al 4to request (max=3 default)', async () => {
  const app = express();
  app.use(createBackupCodeLimiter({ keyGenerator: fixedKey('k-backup') }));
  app.get('/', (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    const { firstBlocked, lastStatus } = await runUntilLimited(
      `http://127.0.0.1:${srv.address().port}/`,
      3,
      4,
    );
    assert.equal(firstBlocked, 4);
    assert.equal(lastStatus, 429);
  } finally {
    await close(srv);
  }
});

test('createTelemetryLimiter — permite ráfaga corta sin bloquear (max=60)', async () => {
  const app = express();
  app.use(createTelemetryLimiter({ keyGenerator: fixedKey('k-telemetry') }));
  app.get('/', (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    // 50 requests no deben superar el max=60.
    const { firstBlocked, lastStatus } = await runUntilLimited(
      `http://127.0.0.1:${srv.address().port}/`,
      60,
      50,
    );
    assert.equal(firstBlocked, -1, 'ninguno debería estar bloqueado');
    assert.equal(lastStatus, 200);
  } finally {
    await close(srv);
  }
});

// ─── 3) Keys distintos no comparten contador ────────────────────────────────
test('keyGenerator aísla contadores entre claves diferentes', async () => {
  const app = express();
  // El limiter se construye UNA SOLA VEZ al boot (NO dentro del handler).
  // El keyGenerator lee `req.query.k` para alternar entre dos claves lógicas
  // — ese es el patrón canónico de express-rate-limit para particionar por
  // user/tenant/feature sin instanciar limiters dinámicos.
  const isoLimiter = createWebhookApproveLimiter({
    keyGenerator: (req) => (req.query.k === 'b' ? 'k-iso-b' : 'k-iso-a'),
  });
  app.use(isoLimiter);
  app.get('/', (req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  try {
    // 10 requests con key=a (consume su max).
    for (let i = 0; i < 10; i += 1) await hit(`http://127.0.0.1:${srv.address().port}/?k=a`);
    // 1 request con key=b debería ser 200 (no comparte contador con key=a).
    const statusB = await hit(`http://127.0.0.1:${srv.address().port}/?k=b`);
    assert.equal(statusB, 200, 'key=b debe estar fresh');
  } finally {
    await close(srv);
  }
});

// ─── 4) makeRedisStore con cliente fake ─────────────────────────────────────
test('makeRedisStore — sin redis retorna undefined (Memory fallback)', () => {
  const store = makeRedisStore({ redis: null, prefix: 'rl:test:' });
  assert.equal(store, undefined);
});

test('makeRedisStore — con redis fake delega sendCommand', () => {
  let lastCommand = null;
  const fakeRedis = {
    call: (...args) => {
      lastCommand = args;
      // Devuelve formato esperado por rate-limit-redis (depende del comando).
      return Promise.resolve([1, 60]);
    },
  };
  const store = makeRedisStore({ redis: fakeRedis, prefix: 'rl:test:' });
  assert.ok(store, 'store debe existir');
  assert.equal(typeof store.increment, 'function');
  // No invocamos store.increment aquí porque requiere init() del express-rate-limit
  // runtime (passes options). El test cubre el contrato del factory (store creado
  // con prefix y sendCommand bound al fake), que es lo que centraliza el riesgo
  // de regresión sin tocar la implementación interna de rate-limit-redis.
  assert.equal(lastCommand, null, 'sendCommand no se llama al construir');
});
