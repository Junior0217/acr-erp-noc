/**
 * backend/shared/services/ncf-reservation.service.js
 *
 * Mejora #18 — Capa de idempotencia NCF cross-process (Redis-backed).
 *
 * Problema: si dos requests llegan con el MISMO Idempotency-Key y caen en
 * DISTINTOS procesos (multi-instance Render), el Map in-memory de
 * pos/controller.js no se entera → se emite 2x. Redis lo soluciona porque
 * todos los procesos comparten estado.
 *
 * Estrategia:
 *   - Antes de allocar NCF, SETNX `ncf:in-flight:<key>` con TTL 60s.
 *   - Si SETNX devuelve 1 (no existía) → procede a allocate del DB.
 *   - Si devuelve 0 → otro request ya está procesando. Poll hasta que el
 *     valor cambie de "PENDING" al NCF real (o expire).
 *   - Al completar emisión exitosa → SET key=<noFactura>:<ncf> (TTL 1h).
 *   - Al fallar → DEL key (o deja que expire).
 *
 * Fallback: si Redis no disponible → no-op (regresa null en check, true en
 * release). El NCF allocator atómico del DB sigue siendo la fuente de verdad.
 *
 * Cyber Neo:
 *   - Key sanitizada: solo hex/UUID. Anti-injection.
 *   - Scope por user.sub previene cross-user poisoning.
 *   - TTL bound — incluso si crash, expiran en 60s.
 *   - NO almacena datos sensibles. Solo `noFactura:ncf` (públicos en PDF).
 */

const TTL_INFLIGHT_S = 60;   // 60s para completar la emisión
const TTL_COMPLETED_S = 3600; // 1h para idempotency response cache
const POLL_INTERVAL_MS = 200;
const POLL_MAX_ATTEMPTS = 25; // ~5s máximo de espera

function _sanitizeKey(key) {
  if (typeof key !== 'string') return null;
  const t = key.trim();
  if (t.length < 8 || t.length > 128) return null;
  if (!/^[a-zA-Z0-9_\-:.]+$/.test(t)) return null;
  return t;
}

function createNcfReservationService({ redis }) {
  // redis puede ser null (no instalado / no configurado) → modo fallback.
  const enabled = redis && typeof redis.set === 'function';
  if (!enabled) {
    console.log('[NCF-RESV] Redis no disponible — modo passthrough (sin idempotency cross-process).');
  }

  function _k(scope, idemKey) {
    return `ncf-resv:${scope}:${idemKey}`;
  }

  /**
   * Intenta reservar el slot. Retorna:
   *   - { state: 'NEW' }   → eres el primero, procede a allocate.
   *   - { state: 'CACHED', value } → otro proceso ya completó; usa value.
   *   - { state: 'PENDING' } → otro proceso está procesando, poll falló por timeout.
   *   - { state: 'DISABLED' } → Redis off, comportamiento legacy.
   */
  async function acquireSlot({ userId, idemKey }) {
    if (!enabled) return { state: 'DISABLED' };
    const safe = _sanitizeKey(idemKey);
    if (!safe) return { state: 'DISABLED' };
    const scope = String(userId ?? 'anon');
    const key   = _k(scope, safe);
    try {
      // SETNX con TTL: solo si NO existe.
      const ok = await redis.set(key, 'PENDING', 'EX', TTL_INFLIGHT_S, 'NX');
      if (ok === 'OK') return { state: 'NEW' };
      // Existe — poll hasta que cambie a valor completed o expire.
      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const val = await redis.get(key);
        if (val == null)        return { state: 'NEW' };           // expiró → tomar slot
        if (val !== 'PENDING')  return { state: 'CACHED', value: val };
      }
      return { state: 'PENDING' }; // timeout — caller decide qué hacer
    } catch (e) {
      console.warn('[NCF-RESV] redis acquire error:', e.message);
      return { state: 'DISABLED' };
    }
  }

  /**
   * Marca el slot como completado con `value` (típicamente `noFactura:ncf`).
   * TTL extendido a 1h — replays dentro de esa ventana devuelven el valor.
   */
  async function completeSlot({ userId, idemKey, value }) {
    if (!enabled) return;
    const safe = _sanitizeKey(idemKey);
    if (!safe) return;
    const scope = String(userId ?? 'anon');
    try {
      await redis.set(_k(scope, safe), String(value), 'EX', TTL_COMPLETED_S);
    } catch (e) {
      console.warn('[NCF-RESV] redis complete error:', e.message);
    }
  }

  /**
   * Libera el slot inmediatamente (ej. tras fallo en la emisión). El cron
   * de TTL haría lo mismo en 60s; este DEL acelera la liberación.
   */
  async function releaseSlot({ userId, idemKey }) {
    if (!enabled) return;
    const safe = _sanitizeKey(idemKey);
    if (!safe) return;
    const scope = String(userId ?? 'anon');
    try {
      const val = await redis.get(_k(scope, safe));
      if (val === 'PENDING') await redis.del(_k(scope, safe));
    } catch (e) {
      console.warn('[NCF-RESV] redis release error:', e.message);
    }
  }

  function stats() {
    return { enabled, ttlInflight: TTL_INFLIGHT_S, ttlCompleted: TTL_COMPLETED_S };
  }

  return { acquireSlot, completeSlot, releaseSlot, stats, enabled };
}

module.exports = createNcfReservationService;
