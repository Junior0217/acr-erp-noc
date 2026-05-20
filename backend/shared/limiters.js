/**
 * backend/shared/limiters.js
 *
 * Factories para rate-limiters locales reusables transversalmente entre
 * routers. Vive aquí (no en server.js) para que cualquier módulo nuevo pueda
 * importar la misma política sin duplicar config (Cyber Neo + DRY).
 *
 * Cada factory acepta opcionalmente un `makeStore` que devuelve la
 * configuración de almacén distribuido (Redis vía rate-limit-redis). Cuando
 * `makeStore()` retorna `undefined`, express-rate-limit cae a su MemoryStore
 * por defecto — útil en desarrollo y como fallback resiliente si Redis no
 * está disponible al boot.
 *
 * Importante: la decisión de pasar `store` solo cuando es truthy es crítica;
 * `store: undefined` provoca `TypeError` en express-rate-limit. Por eso el
 * spread condicional `...(store ? { store } : {})`.
 */

const rateLimit = require('express-rate-limit');

/**
 * webhookApproveLimiter — endpoint público de aprobación firmada HMAC.
 *
 * 10 intentos por IP (o fingerprint hash) en 15 minutos. Bloquea brute-force
 * contra `POST /api/pos/authorize-webhook/:id/approve`, donde la única
 * autenticación es el HMAC del body (sin JWT). Distribuido vía Redis → todos
 * los pods comparten el contador, anulando escala horizontal como bypass.
 *
 * @param {{ makeStore?: () => object | undefined, keyGenerator?: (req: object) => string }} opts
 */
function createWebhookApproveLimiter(opts = {}) {
  const store    = typeof opts.makeStore === 'function' ? opts.makeStore() : undefined;
  const keyGen   = typeof opts.keyGenerator === 'function'
    ? opts.keyGenerator
    : (req) => req.ip;
  return rateLimit({
    windowMs:        15 * 60 * 1000,
    max:             10,
    keyGenerator:    keyGen,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Demasiados intentos de aprobación. Intente en 15 minutos.' },
    ...(store ? { store } : {}),
  });
}

module.exports = {
  createWebhookApproveLimiter,
};
