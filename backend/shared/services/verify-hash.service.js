/**
 * backend/shared/services/verify-hash.service.js
 *
 * Anti-tamper HMAC sobre campos vitales de Factura. Validación pública via
 * /api/publico/verify/:hash — quien recibe el PDF puede confirmar que el monto/
 * cliente/NCF coincide con lo emitido (defensa anti-Photoshop).
 *
 * CRÍTICO: la normalización rígida (_normStr/_normMoney/_normDateYMD) es
 * load-bearing. Prisma devuelve Decimal como objeto que stringifica distinto
 * ("150" vs "150.00") según versión y path (raw query vs ORM). DateTime puede
 * llegar como Date o ISO string. Si los inputs no se castean rígidamente, el
 * hash difiere entre persist y verify → "Documento no válido" falsos.
 *
 * Factory: createVerifyHashService({ prisma }) -> { facturaVerifyHash,
 *   persistirVerifyHash, _normStr, _normMoney, _normDateYMD }
 *
 * facturaVerifyHash + helpers son funciones puras (sin prisma). Se exportan
 * también como named exports para que código legacy fuera del factory las use.
 */

const crypto = require('crypto');

function _normStr(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s === 'NaN' || s === 'undefined' || s === 'null' ? '' : s;
}

function _normMoney(v) {
  if (v == null || v === '') return '0.00';
  const s = typeof v === 'object' && typeof v.toString === 'function' ? v.toString() : String(v);
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function _normDateYMD(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const y   = d.getUTCFullYear();
  const m   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _resolveVerifySecret() {
  return process.env.VERIFY_SECRET
      ?? process.env.JWT_SECRET
      ?? process.env.SESSION_SECRET
      ?? 'acr-noc-verify-secret-fallback-v1';
}

const VERIFY_HASH_DEBUG = process.env.VERIFY_HASH_DEBUG === '1';
function _hashDbg(tag, f, payload, hash) {
  if (!VERIFY_HASH_DEBUG) return;
  console.log(`[HASH ${tag}]`, {
    id:        f?.id,
    noFactura: f?.noFactura,
    ncfRaw:    f?.ncf,
    ncfNorm:   _normStr(f?.ncf),
    totalRaw:  f?.total?.toString?.() ?? f?.total,
    totalNorm: _normMoney(f?.total),
    fechaRaw:  f?.fechaEmision,
    fechaNorm: _normDateYMD(f?.fechaEmision),
    payload,
    hash,
  });
}

function facturaVerifyPayload(f) {
  if (!f) return '';
  return [
    _normStr(f.id),
    _normStr(f.noFactura),
    _normStr(f.ncf),
    _normMoney(f.total),
    _normDateYMD(f.fechaEmision),
  ].join('|');
}

function facturaVerifyHash(f, dbgTag) {
  if (!f) return '';
  const payload = facturaVerifyPayload(f);
  const hash = crypto.createHmac('sha256', _resolveVerifySecret()).update(payload).digest('hex').slice(0, 24);
  if (dbgTag) _hashDbg(dbgTag, f, payload, hash);
  return hash;
}

// Mejora #7 — Ed25519 doble-firma. Aditiva al HMAC. La firma se calcula
// sobre payload + hmac concatenado: alterar uno invalida la firma.
// Lazy-require para no romper boot si la lib no está disponible.
let _ed25519Svc = null;
function _getEd25519() {
  if (_ed25519Svc !== null) return _ed25519Svc;
  try {
    _ed25519Svc = require('./ed25519-sign.service');
  } catch (e) {
    console.warn('[VERIFY HASH] Ed25519 service no disponible:', e.message);
    _ed25519Svc = { signVerifyPayload: () => null, verifyVerifySignature: () => false };
  }
  return _ed25519Svc;
}

function facturaVerifySignature(f) {
  if (!f) return null;
  const payload = facturaVerifyPayload(f);
  const hmac    = facturaVerifyHash(f);
  return _getEd25519().signVerifyPayload(`${payload}|${hmac}`);
}

function verifyFacturaSignature(f, signatureB64) {
  if (!f || !signatureB64) return false;
  const payload = facturaVerifyPayload(f);
  const hmac    = facturaVerifyHash(f);
  return _getEd25519().verifyVerifySignature(`${payload}|${hmac}`, signatureB64);
}

function createVerifyHashService({ prisma }) {
  if (!prisma) throw new Error('createVerifyHashService: prisma is required');

  /**
   * Lifecycle-safe persistence del verifyHash.
   * Re-lee la factura via findUnique para obtener los tipos canónicos persistidos
   * por Prisma (Decimal con escala fija, Date desde Postgres RETURNING). El objeto
   * in-memory devuelto por `create` puede diferir sutilmente en serialización →
   * hash divergente entre persist y PDF gen. Invalida pdfUrl para forzar regen
   * del QR sincronizado al hash recién persistido.
   */
  async function persistirVerifyHash(factura) {
    if (!factura?.id) return factura;
    try {
      const fresh = await prisma.factura.findUnique({
        where:  { id: factura.id },
        select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true },
      });
      if (!fresh) return factura;
      const vh = facturaVerifyHash(fresh, 'persist');
      await prisma.factura.update({
        where: { id: factura.id },
        data:  { verifyHash: vh, pdfUrl: null, pdfInvalidatedAt: new Date(), pdfRenderAttempts: 0 },
      });
      factura.verifyHash = vh;
      factura.pdfUrl = null;
    } catch (e) {
      console.warn('[verifyHash] persist failed:', e.code, e.message);
    }
    return factura;
  }

  return {
    _normStr, _normMoney, _normDateYMD,
    facturaVerifyHash, facturaVerifyPayload,
    facturaVerifySignature, verifyFacturaSignature,
    persistirVerifyHash,
  };
}

module.exports = createVerifyHashService;
module.exports.facturaVerifyHash      = facturaVerifyHash;
module.exports.facturaVerifyPayload   = facturaVerifyPayload;
module.exports.facturaVerifySignature = facturaVerifySignature;
module.exports.verifyFacturaSignature = verifyFacturaSignature;
module.exports._normStr               = _normStr;
module.exports._normMoney             = _normMoney;
module.exports._normDateYMD           = _normDateYMD;
