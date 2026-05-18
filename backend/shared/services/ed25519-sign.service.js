/**
 * backend/shared/services/ed25519-sign.service.js
 *
 * Mejora #7 — Doble-firma asimétrica para verifyHash.
 *
 * Patrón actual: HMAC-SHA256 con `VERIFY_SECRET` (clave SIMÉTRICA). Validar
 * un PDF impreso exige acceso al server porque solo el server conoce el
 * secret. Limita auditorías offline (auditor con teléfono + foto del QR).
 *
 * Mejora: Ed25519 (curva asimétrica). El backend firma con la PRIVATE key;
 * cualquier cliente con la PUBLIC key valida sin contactar al server.
 *
 * Estrategia:
 *   - Las claves se cargan desde env: SIGN_ED25519_PRIVATE / SIGN_ED25519_PUBLIC
 *     (base64-encoded raw 32-byte keys).
 *   - Si NO existen → se genera un par EFÍMERO al boot (warn). Bueno para
 *     dev; producción exige claves persistentes para que las firmas viejas
 *     sigan verificables.
 *   - `signVerifyPayload(payload)` → base64 signature (88 chars con padding).
 *   - `verifyVerifySignature(payload, signature)` → bool.
 *   - `getPublicKeyPem()` → PEM con la public key para exponer en endpoint
 *     público `/api/verify/public-key`.
 *
 * Cyber Neo:
 *   - Private key NUNCA expuesta vía endpoint.
 *   - El secret simétrico (HMAC) se mantiene en paralelo — la firma Ed25519
 *     es ADITIVA, no reemplaza. Defense-in-depth: ambos hashes verifican.
 */

const crypto = require('crypto');

function _loadOrGenerate() {
  const privB64 = process.env.SIGN_ED25519_PRIVATE;
  const pubB64  = process.env.SIGN_ED25519_PUBLIC;
  if (privB64 && pubB64) {
    try {
      const privRaw = Buffer.from(privB64, 'base64');
      const pubRaw  = Buffer.from(pubB64,  'base64');
      // Reconstruct KeyObjects en formato Node crypto.
      // Ed25519 raw seed = 32 bytes. KeyObject.create from raw via JWK or DER.
      // Node 18+ supports createPrivateKey({ key, format: 'raw' }) NO — solo PEM/DER.
      // Convertimos raw → DER (ASN.1 prefix conocido de Ed25519).
      const ED25519_PRIV_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
      const ED25519_PUB_PREFIX  = Buffer.from('302a300506032b6570032100',       'hex');
      const privDer = Buffer.concat([ED25519_PRIV_PREFIX, privRaw.slice(0, 32)]);
      const pubDer  = Buffer.concat([ED25519_PUB_PREFIX,  pubRaw.slice(0, 32)]);
      const privKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
      const pubKey  = crypto.createPublicKey({  key: pubDer,  format: 'der', type: 'spki'  });
      return { privKey, pubKey, persistent: true };
    } catch (e) {
      console.warn('[ED25519] env keys invalid, generando efímero:', e.message);
    }
  }
  // Fallback efímero — útil en dev, pero las firmas no son re-verificables
  // tras restart. PRODUCCIÓN: setea SIGN_ED25519_PRIVATE / PUBLIC.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privKey: privateKey, pubKey: publicKey, persistent: false };
}

let _keys = null;
function _ensureKeys() {
  if (_keys) return _keys;
  _keys = _loadOrGenerate();
  if (!_keys.persistent) {
    console.warn('[ED25519] usando par EFÍMERO — firmas no persisten entre reinicios. Setea SIGN_ED25519_PRIVATE/PUBLIC en producción.');
  }
  return _keys;
}

/**
 * Genera par nuevo y devuelve los raw bytes base64. Útil para script de
 * onboarding que el owner corre una vez y guarda en su `.env`.
 *
 * Uso: `node -e "console.log(require('./shared/services/ed25519-sign.service').generateNewKeyPair())"`
 */
function generateNewKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Export raw 32-byte seed (privado) + raw 32-byte point (público).
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer  = publicKey.export({ format: 'der', type: 'spki' });
  // Los últimos 32 bytes del DER son la clave raw (después del prefix ASN.1).
  const privRaw = privDer.slice(privDer.length - 32);
  const pubRaw  = pubDer.slice(pubDer.length - 32);
  return {
    SIGN_ED25519_PRIVATE: privRaw.toString('base64'),
    SIGN_ED25519_PUBLIC:  pubRaw.toString('base64'),
    note: 'Guarda AMBAS en tu .env. La PUBLIC se expone a clientes; la PRIVATE NO.',
  };
}

function signVerifyPayload(payload) {
  const { privKey } = _ensureKeys();
  const data = Buffer.from(String(payload), 'utf8');
  const sig = crypto.sign(null, data, privKey); // null = Ed25519 no hash externo
  return sig.toString('base64');
}

function verifyVerifySignature(payload, signatureB64) {
  if (!payload || !signatureB64) return false;
  try {
    const { pubKey } = _ensureKeys();
    const data = Buffer.from(String(payload), 'utf8');
    const sig  = Buffer.from(String(signatureB64), 'base64');
    return crypto.verify(null, data, pubKey, sig);
  } catch {
    return false;
  }
}

function getPublicKeyPem() {
  const { pubKey } = _ensureKeys();
  return pubKey.export({ format: 'pem', type: 'spki' });
}

function getPublicKeyRawBase64() {
  const { pubKey } = _ensureKeys();
  const der = pubKey.export({ format: 'der', type: 'spki' });
  return der.slice(der.length - 32).toString('base64');
}

module.exports = {
  signVerifyPayload,
  verifyVerifySignature,
  getPublicKeyPem,
  getPublicKeyRawBase64,
  generateNewKeyPair,
};
