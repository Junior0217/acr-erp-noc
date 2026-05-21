/**
 * backend/shared/limiters.js
 *
 * Factories para rate-limiters reusables. Centralizadas aquí para que
 * cualquier router del repo (auth, POS, webhook, vault) consuma la MISMA
 * política sin duplicar config (Cyber Neo + DRY).
 *
 * Distribución horizontal:
 *   - Cada factory acepta `makeStore`: factoría que devuelve un store de
 *     express-rate-limit (típicamente `RedisStore` de rate-limit-redis).
 *   - Si `makeStore()` retorna `undefined`, express-rate-limit cae a su
 *     `MemoryStore` por defecto — fallback resiliente para desarrollo o si
 *     Redis no está disponible al boot.
 *
 * Por qué Redis en producción:
 *   En Render con N pods, cada pod tiene su propio MemoryStore. Un atacante
 *   que rote IPs (o use proxies) puede dividir su tráfico entre pods y
 *   exceder el límite efectivo NxK. Con RedisStore compartido, el contador
 *   es global por (clave, ventana) — bloqueo real al 11vo request total.
 *
 * Convención de `prefix`:
 *   Cada limiter usa un prefix Redis único (`rl:auth:login`, `rl:auth:totp`,
 *   etc.) para evitar colisión de claves entre limiters distintos. Si no
 *   se provee, RedisStore usa `rl:`.
 *
 * Convención de `keyGenerator`:
 *   Por defecto: `req.ip` (express-rate-limit ya valida X-Forwarded-For con
 *   `trust proxy`). Para limiters por-usuario (TOTP post-login) el caller
 *   debe pasar un keyGenerator que use `req.user.sub` o un fingerprint.
 *
 * Importante: `store: undefined` provoca `TypeError` en express-rate-limit.
 * Por eso el spread condicional `...(store ? { store } : {})`.
 */

const rateLimit = require('express-rate-limit');

// ─── Prefixes Redis centralizados ────────────────────────────────────────────
// Llave por limiter para evitar colisión silenciosa de contadores en Redis.
// Centralizada para que un typo (`rl:auth:login:` vs `rl:auth:logins:`)
// salga al instante en revisión de código, y para que la validación
// `assertUniquePrefixes()` corra al require del módulo.
//
// Convención: `rl:<dominio>:<accion>:` — separadores `:` para que Redis
// pueda hacer `KEYS rl:auth:*` durante incidentes. Sin sufijo numérico
// (que rate-limit-redis añade automáticamente con el contador).
const LIMITER_PREFIXES = Object.freeze({
  login:          'rl:auth:login:',
  totp:           'rl:auth:totp:',
  backupCode:     'rl:auth:backup:',
  webhookApprove: 'rl:pos:webhook:',
  telemetry:      'rl:telemetry:',
  billing:        'rl:billing:',
  upload:         'rl:upload:',
  portalLogin:    'rl:portal:login:',
});

// Validación al boot: si dos prefixes son iguales por error de copy-paste,
// fallamos inmediatamente con mensaje claro. No esperamos a producción para
// descubrir que dos limiters comparten contador.
(function assertUniquePrefixes() {
  const seen = new Map();
  for (const [name, prefix] of Object.entries(LIMITER_PREFIXES)) {
    if (seen.has(prefix)) {
      throw new Error(
        `LIMITER_PREFIXES inválido: '${prefix}' duplicado entre '${seen.get(prefix)}' y '${name}'. ` +
        `Cada limiter debe tener prefix único para aislar contadores en Redis.`,
      );
    }
    seen.set(prefix, name);
  }
})();

/**
 * makeRedisStore — crea un RedisStore conectado al cliente ioredis dado.
 *
 * @param {object} opts
 * @param {import('ioredis').Redis} opts.redis — cliente ioredis ya conectado.
 * @param {string} opts.prefix — namespace de claves en Redis (ej. 'rl:auth:login:').
 * @returns {object | undefined} — store listo para express-rate-limit, o
 *   undefined si `redis` no está disponible.
 */
function makeRedisStore({ redis, prefix }) {
  if (!redis) return undefined;
  // Lazy require — el require principal del archivo no debe forzar la
  // dependencia de rate-limit-redis en entornos donde Redis no se usa.
  const { RedisStore } = require('rate-limit-redis');
  return new RedisStore({
    prefix,
    // rate-limit-redis v5 espera un callable `sendCommand` (ioredis lo expone).
    sendCommand: (...args) => redis.call(...args),
  });
}

// ─── Factory base ────────────────────────────────────────────────────────────
function buildLimiter({ windowMs, max, keyGen, message, makeStore, prefix, skipSuccessfulRequests }) {
  const store = typeof makeStore === 'function' ? makeStore({ prefix }) : undefined;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator:    keyGen ?? ((req) => req.ip),
    message,
    ...(skipSuccessfulRequests != null ? { skipSuccessfulRequests } : {}),
    ...(store ? { store } : {}),
  });
}

/**
 * createLoginLimiter — login admin (`POST /api/auth/login`).
 * Default 5 intentos por IP en 15 minutos; `skipSuccessfulRequests:true` —
 * los login OK no cuentan al contador, así un usuario legítimo no se bloquea.
 */
function createLoginLimiter(opts = {}) {
  return buildLimiter({
    windowMs:               opts.windowMs ?? 15 * 60 * 1000,
    max:                    opts.max ?? 5,
    keyGen:                 opts.keyGenerator,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? true,
    message:                { error: 'Demasiados intentos de inicio de sesión. Intenta en 15 minutos.' },
    makeStore:              opts.makeStore,
    prefix:                 opts.prefix ?? LIMITER_PREFIXES.login,
  });
}

/**
 * createTotpLimiter — verificación 2FA TOTP post-login.
 * Default 5 intentos por IP en 15 minutos; `skipSuccessfulRequests:true`.
 */
function createTotpLimiter(opts = {}) {
  return buildLimiter({
    windowMs:               opts.windowMs ?? 15 * 60 * 1000,
    max:                    opts.max ?? 5,
    keyGen:                 opts.keyGenerator,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? true,
    message:                { error: 'Demasiados intentos de PIN. Intente en 15 minutos.' },
    makeStore:              opts.makeStore,
    prefix:                 opts.prefix ?? LIMITER_PREFIXES.totp,
  });
}

/**
 * createBackupCodeLimiter — backup codes 2FA (consumibles una sola vez).
 * Default 3 intentos por IP en 1 hora. Brute-force prevention agresiva: NO
 * skip successful (un código consumido OK también cuenta — anti-enum).
 */
function createBackupCodeLimiter(opts = {}) {
  return buildLimiter({
    windowMs:               opts.windowMs ?? 60 * 60 * 1000,
    max:                    opts.max ?? 3,
    keyGen:                 opts.keyGenerator,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    message:                { error: 'Demasiados intentos con código de respaldo. Intente en 1 hora.' },
    makeStore:              opts.makeStore,
    prefix:                 opts.prefix ?? LIMITER_PREFIXES.backupCode,
  });
}

/**
 * createWebhookApproveLimiter — endpoint público HMAC (`POST /api/pos/authorize-webhook/:id/approve`).
 * 10 intentos por IP en 15 minutos.
 */
function createWebhookApproveLimiter(opts = {}) {
  return buildLimiter({
    windowMs:  15 * 60 * 1000,
    max:       10,
    keyGen:    opts.keyGenerator,
    message:   { error: 'Demasiados intentos de aprobación. Intenta en 15 minutos.' },
    makeStore: opts.makeStore,
    prefix:    opts.prefix ?? LIMITER_PREFIXES.webhookApprove,
  });
}

/**
 * createTelemetryLimiter — endpoint de telemetría frontend (`POST /api/telemetry`).
 * 60 reportes por IP en 1 minuto. Permisivo (no es brute-force-prone) pero
 * evita que un cajero con loop runaway sature backend con miles de logs.
 */
function createTelemetryLimiter(opts = {}) {
  return buildLimiter({
    windowMs:  opts.windowMs ?? 60 * 1000,
    max:       opts.max ?? 60,
    keyGen:    opts.keyGenerator,
    message:   { error: 'Telemetry rate exceeded.' },
    makeStore: opts.makeStore,
    prefix:    opts.prefix ?? LIMITER_PREFIXES.telemetry,
  });
}

/**
 * createBillingLimiter — operaciones de facturación autenticadas.
 * Default 5 ops por usuario en 1 minuto. Protege contra creación accidental
 * en bucle (cajero que doble-clickea "Generar factura"). El keyGenerator por
 * defecto requiere `req.user.sub` (post-auth); el caller normalmente provee
 * un fallback a fingerprint para llamadas anónimas raras.
 */
function createBillingLimiter(opts = {}) {
  return buildLimiter({
    windowMs:  opts.windowMs ?? 60 * 1000,
    max:       opts.max ?? 5,
    keyGen:    opts.keyGenerator,
    message:   { error: 'Límite de operaciones de facturación alcanzado. Intente en 1 minuto.' },
    makeStore: opts.makeStore,
    prefix:    opts.prefix ?? LIMITER_PREFIXES.billing,
  });
}

/**
 * createUploadLimiter — uploads de archivos (`POST /api/uploads/...`).
 * Default 10 uploads por IP en 1 minuto. Suficientemente laxo para flujos
 * legítimos (foto de instalación con 5 ángulos) pero corta script kiddies
 * que intenten spam de uploads para llenar almacenamiento.
 */
function createUploadLimiter(opts = {}) {
  return buildLimiter({
    windowMs:  opts.windowMs ?? 60 * 1000,
    max:       opts.max ?? 10,
    keyGen:    opts.keyGenerator,
    message:   { error: 'Demasiados uploads. Espere 1 minuto.' },
    makeStore: opts.makeStore,
    prefix:    opts.prefix ?? LIMITER_PREFIXES.upload,
  });
}

/**
 * createPortalLoginLimiter — login del portal de clientes (`POST /api/portal/login`).
 * Default 5 intentos por (sub-portal o fingerprint) en 15 minutos. Distinto
 * del loginLimiter admin porque el universo de usuarios es mucho más amplio
 * (cada cliente final), pero el riesgo de credential stuffing es similar.
 */
function createPortalLoginLimiter(opts = {}) {
  return buildLimiter({
    windowMs:               opts.windowMs ?? 15 * 60 * 1000,
    max:                    opts.max ?? 5,
    keyGen:                 opts.keyGenerator,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? true,
    message:                { error: 'Demasiados intentos de inicio de sesión del portal. Intente en 15 minutos.' },
    makeStore:              opts.makeStore,
    prefix:                 opts.prefix ?? LIMITER_PREFIXES.portalLogin,
  });
}

module.exports = {
  LIMITER_PREFIXES,
  makeRedisStore,
  createLoginLimiter,
  createTotpLimiter,
  createBackupCodeLimiter,
  createWebhookApproveLimiter,
  createTelemetryLimiter,
  createBillingLimiter,
  createUploadLimiter,
  createPortalLoginLimiter,
};
