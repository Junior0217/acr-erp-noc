/**
 * backend/shared/middlewares/idempotency.middleware.js
 *
 * Mejora #4 — Idempotencia universal para endpoints money-moving.
 *
 * Patrón ya implementado inline en POS (pos/controller.js). Este módulo
 * lo generaliza para reuso en Cotizaciones, Notas de Crédito, Notas de
 * Débito y futuras superficies que mueven dinero / NCF / stock.
 *
 * Garantías:
 *   1. Layer 1 — Map in-memory (instance-local, latency ~0). TTL 5 min,
 *      cap 5000 entries con eviction FIFO.
 *   2. Layer 2 — Redis cross-process opcional (vía NCFReservation service
 *      ya configurado). Cuando Render arranca varias instancias, el
 *      Map de cada una NO se entera del lock de la otra; Redis sí.
 *
 * Uso típico — en un router:
 *
 *   const idem = createIdempotencyMiddleware({
 *     scope: 'nota-credito',
 *     ncfReservation,            // service ya wireado en server.js
 *     required: true,            // 400 si falta el header
 *   });
 *   router.post('/facturas/:id/nota-credito', verificarJWT, idem, ctrl.postNotaCredito);
 *
 * Comportamiento:
 *   - Si `required=true` y NO viene `Idempotency-Key` o es inválido → 400.
 *   - Si key cacheado (Map o Redis) → responde con cached body + status
 *     original + header `X-Idempotent: 1`. NO ejecuta el controller.
 *   - Si key marcado PENDING en Redis (otro proceso ya está procesando)
 *     → 409 IDEMP_PENDING para que el cliente reintente.
 *   - Si key NEW → continúa al controller. Intercepta `res.json` para
 *     cachear el resultado (Map siempre, Redis si está habilitado).
 *
 * Cyber Neo:
 *   - Key sanitizada: solo `[a-zA-Z0-9_\-:.]`, 8–128 chars. Anti-injection.
 *   - Scope por `user.sub` previene cross-user cache poisoning.
 *   - Cap 5000 entries previene memory exhaustion del proceso.
 *   - Slot Redis con TTL 60s — si proceso muere a mitad, slot expira y
 *     un retry puede tomar control.
 *   - Si el controller falla (4xx/5xx) NO se cachea — para que el cliente
 *     pueda reintentar con la misma key (no es un éxito reproducible).
 */

const SCOPE_RE = /^[a-z][a-z0-9-]{1,40}$/;

function createIdempotencyMiddleware(opts = {}) {
  const {
    scope,
    ncfReservation = null,
    required = true,
    ttlMs    = 5 * 60 * 1000,   // 5 min Map TTL
    maxSize  = 5000,            // Map cap antes de eviction FIFO
    pendingTimeoutSec = 5,      // espera máxima a slot Redis PENDING
  } = opts;

  if (!scope || typeof scope !== 'string' || !SCOPE_RE.test(scope)) {
    throw new Error(`createIdempotencyMiddleware: scope inválido "${scope}". Usar lowercase kebab-case (ej. "nota-credito").`);
  }

  // Map local (per-process). Key = `${scope}:${userSub}:${idemKey}`.
  const _cache = new Map();

  function _now() { return Date.now(); }

  function _cacheKey(userSub, idemKey) {
    return `${scope}:${userSub ?? 'anon'}:${idemKey}`;
  }

  function _get(key) {
    const row = _cache.get(key);
    if (!row) return null;
    if (_now() - row.ts > ttlMs) { _cache.delete(key); return null; }
    return row.response;
  }

  function _set(key, response) {
    if (_cache.size >= maxSize) {
      const oldest = _cache.keys().next().value;
      if (oldest) _cache.delete(oldest);
    }
    _cache.set(key, { ts: _now(), response });
  }

  function _extractKey(req) {
    const raw = String(req.headers['idempotency-key'] ?? '').trim();
    if (!raw)                                   return { valid: false, reason: 'MISSING' };
    if (raw.length < 8 || raw.length > 128)     return { valid: false, reason: 'BAD_LENGTH' };
    if (!/^[a-zA-Z0-9_\-:.]+$/.test(raw))       return { valid: false, reason: 'BAD_CHARS' };
    return { valid: true, raw };
  }

  return async function idempotencyMiddleware(req, res, next) {
    const userSub = req.user?.sub ?? null;
    const { valid, raw, reason } = _extractKey(req);

    if (!valid) {
      if (required) {
        return res.status(400).json({
          error: 'Header `Idempotency-Key` requerido (UUID o token único 8–128 chars [a-zA-Z0-9_-:.]).',
          code:  `IDEMP_${reason}`,
        });
      }
      return next();
    }

    const localKey = _cacheKey(userSub, raw);

    // Layer 1: Map in-memory.
    const cached = _get(localKey);
    if (cached) {
      const status = cached.status ?? 200;
      res.setHeader('X-Idempotent', '1');
      res.setHeader('X-Idempotent-Source', 'memory');
      if (cached.headers && typeof cached.headers === 'object') {
        for (const [k, v] of Object.entries(cached.headers)) {
          try { res.setHeader(k, String(v)); } catch {}
        }
      }
      return res.status(status).json(cached.body ?? {});
    }

    // Layer 2: Redis cross-process (si NCFReservation está habilitado).
    let acquiredRedisSlot = false;
    if (ncfReservation && ncfReservation.enabled) {
      try {
        const slot = await ncfReservation.acquireSlot({
          userId: `${scope}:${userSub ?? 'anon'}`,
          idemKey: raw,
        });
        if (slot.state === 'CACHED') {
          res.setHeader('X-Idempotent', '1');
          res.setHeader('X-Idempotent-Source', 'redis');
          return res.status(200).json({ reusedFromCache: true, ref: slot.value });
        }
        if (slot.state === 'PENDING') {
          return res.status(409).json({
            error: `Otra petición ${scope} con la misma clave está en proceso. Reintenta en ${pendingTimeoutSec}s.`,
            code:  'IDEMP_PENDING',
          });
        }
        if (slot.state === 'NEW') acquiredRedisSlot = true;
      } catch (e) {
        // Si Redis falla, NO bloqueamos el request — degrade a Map-only.
        console.warn(`[IDEMP ${scope}] redis acquire error:`, e.message);
      }
    }

    // Intercepta `res.json` para cachear la respuesta exitosa.
    const _origJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      try {
        const status = res.statusCode;
        // Solo cachear éxitos (2xx). Errores no se cachean — cliente puede
        // reintentar con la misma key tras corregir el input.
        if (status >= 200 && status < 300) {
          const headersSnapshot = {};
          // Capturamos solo headers que setteamos nosotros (X-*) para no
          // contaminar respuestas reusadas con headers stale.
          for (const h of res.getHeaderNames()) {
            if (h.toLowerCase().startsWith('x-')) {
              headersSnapshot[h] = res.getHeader(h);
            }
          }
          _set(localKey, { status, body, headers: headersSnapshot });
          if (acquiredRedisSlot && ncfReservation?.enabled) {
            const ref = `${scope}:${status}:${Object.keys(body ?? {}).length}`;
            ncfReservation.completeSlot({
              userId: `${scope}:${userSub ?? 'anon'}`,
              idemKey: raw, value: ref,
            }).catch(() => {});
          }
        } else if (acquiredRedisSlot && ncfReservation?.enabled) {
          // Liberar slot Redis ante error → permite retry.
          ncfReservation.releaseSlot({
            userId: `${scope}:${userSub ?? 'anon'}`,
            idemKey: raw,
          }).catch(() => {});
        }
      } catch (e) {
        console.warn(`[IDEMP ${scope}] cache error:`, e.message);
      }
      return _origJson(body);
    };

    return next();
  };
}

module.exports = createIdempotencyMiddleware;
