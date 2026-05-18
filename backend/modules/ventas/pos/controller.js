/**
 * backend/modules/ventas/pos/controller.js
 *
 * Capa HTTP del módulo POS. 3 handlers thin: verifyPin / venta / facturaManual.
 * Cero lógica de negocio. Cero Prisma. Cero cálculos.
 *
 * Factory: createPosController({ service, schemas, prisma })
 *   - prisma se pasa para que el service abra transacciones — la separación
 *     pura "service no recibe prisma" se rompería aquí porque procesarVentaPOS
 *     orquesta lectura + tx + post-commit, y el repo no provee primitiva
 *     "ejecuta tx con callback". Pragmático: prisma es dep inyectada.
 */

const { z } = require('zod');
const { PosError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _applyDescriptor(res, d) {
  const status = d?.status ?? 200;
  // M2: descriptors pueden traer `headers` opcionales (ej. X-Idempotent en hit).
  if (d?.headers && typeof d.headers === 'object') {
    for (const [k, v] of Object.entries(d.headers)) {
      try { res.setHeader(k, String(v)); } catch {}
    }
  }
  if (d?.body == null && (status === 204 || status === 205)) return res.status(status).end();
  return res.status(status).json(d?.body ?? {});
}

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const d = await fn(req, res);
      if (!res.headersSent) _applyDescriptor(res, d);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Datos inválidos.', detail: err.errors });
      }
      if (err instanceof PosError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      console.error('[POS CTRL]', err.message, err.stack);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Error al procesar venta.' });
    }
  };
}

function createPosController({ service, schemas, prisma, stockHub }) {
  if (!service)  throw new Error('createPosController: service required');
  if (!schemas)  throw new Error('createPosController: schemas required');
  if (!prisma)   throw new Error('createPosController: prisma required');
  const { posVentaSchema, facturaManualSchema, verifyPinSchema } = schemas;

  // M2 — Idempotency-Key cache. Map en memoria: key=`${user.sub}:${idempKey}`,
  // valor = { ts, response }. TTL 5min. Si entra request duplicado dentro
  // del TTL → devolvemos la respuesta original (HTTP 200) sin re-emitir.
  // Mitiga doble-cargo cuando el cajero re-clickea "Cobrar" o la red duplica.
  //
  // Cyber Neo: scope por user.sub previene cross-user cache poisoning.
  // Cap 5000 entries con eviction FIFO defensivo.
  const _idempCache = new Map();
  const IDEMP_TTL_MS = 5 * 60 * 1000;
  const IDEMP_MAX = 5000;
  function _idempGet(key) {
    const row = _idempCache.get(key);
    if (!row) return null;
    if (Date.now() - row.ts > IDEMP_TTL_MS) {
      _idempCache.delete(key);
      return null;
    }
    return row.response;
  }
  function _idempSet(key, response) {
    if (_idempCache.size >= IDEMP_MAX) {
      // FIFO: drop oldest entry (Map preserva orden de inserción).
      const oldest = _idempCache.keys().next().value;
      if (oldest) _idempCache.delete(oldest);
    }
    _idempCache.set(key, { ts: Date.now(), response });
  }
  function _idempKey(req) {
    const raw = String(req.headers['idempotency-key'] ?? '').trim();
    if (!raw || raw.length < 8 || raw.length > 128) return null;
    // Sanitiza: solo permite caracteres seguros (UUID + hex). Anti-injection.
    if (!/^[a-zA-Z0-9_\-:.]+$/.test(raw)) return null;
    return `${req.user?.sub ?? 'anon'}:${raw}`;
  }

  const verifyPin = _wrap(async (req) => {
    const dto     = verifyPinSchema.parse(req.body ?? {});
    const reqMeta = _extractReqMeta(req);
    return service.verifyPin(dto, reqMeta, req.user);
  });

  const postVenta = _wrap(async (req) => {
    const ikey = _idempKey(req);
    if (ikey) {
      const cached = _idempGet(ikey);
      if (cached) {
        // Devolvemos exactamente la misma respuesta que la original. Header
        // X-Idempotent indica al frontend que NO es una factura nueva.
        return { status: 200, body: cached.body ?? cached, headers: { 'X-Idempotent': '1' } };
      }
    }
    const dto     = posVentaSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    const result  = await service.procesarVentaPOS(dto, req.user, reqMeta, { prisma, stockHub });
    if (ikey && result?.status === 201) _idempSet(ikey, result);
    return result;
  });

  const postFacturaManual = _wrap(async (req) => {
    const ikey = _idempKey(req);
    if (ikey) {
      const cached = _idempGet(ikey);
      if (cached) return { status: 200, body: cached.body ?? cached, headers: { 'X-Idempotent': '1' } };
    }
    const dto     = facturaManualSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    const result  = await service.procesarFacturaManual(dto, req.user, reqMeta, { prisma, stockHub });
    if (ikey && result?.status === 201) _idempSet(ikey, result);
    return result;
  });

  return { verifyPin, postVenta, postFacturaManual };
}

module.exports = createPosController;
