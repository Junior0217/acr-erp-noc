/**
 * backend/shared/jwt-crypto.js
 *
 * JWE-equivalente: AES-256-GCM wrappers para el cookie de sesión + cifrado
 * separado para el secret TOTP. Ambos derivan keys de JWT_SECRET (más sufijo
 * para TOTP) para que rotar el secret invalide TOTP y sesiones en bloque.
 */

const crypto = require('crypto');

const jweKey  = crypto.createHash('sha256').update(process.env.JWT_SECRET || '').digest();
const totpKey = crypto.createHash('sha256').update((process.env.JWT_SECRET || '') + ':totp').digest();

function wrapJWT(jwtStr) {
  const iv  = crypto.randomBytes(12);
  const cip = crypto.createCipheriv('aes-256-gcm', jweKey, iv);
  const enc = Buffer.concat([cip.update(jwtStr, 'utf8'), cip.final()]);
  const tag = cip.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function unwrapJWT(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const dec = crypto.createDecipheriv('aes-256-gcm', jweKey, Buffer.from(parts[0], 'base64url'));
  dec.setAuthTag(Buffer.from(parts[1], 'base64url'));
  return Buffer.concat([dec.update(Buffer.from(parts[2], 'base64url')), dec.final()]).toString('utf8');
}

function encryptTOTP(secret) {
  const iv  = crypto.randomBytes(12);
  const cip = crypto.createCipheriv('aes-256-gcm', totpKey, iv);
  const enc = Buffer.concat([cip.update(secret, 'utf8'), cip.final()]);
  const tag = cip.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function decryptTOTP(stored) {
  const p = stored.split('.');
  if (p.length !== 3) throw new Error('invalid totp');
  const dec = crypto.createDecipheriv('aes-256-gcm', totpKey, Buffer.from(p[0], 'base64url'));
  dec.setAuthTag(Buffer.from(p[1], 'base64url'));
  return Buffer.concat([dec.update(Buffer.from(p[2], 'base64url')), dec.final()]).toString('utf8');
}

const PORTAL_JWT_SECRET = (process.env.JWT_SECRET || '') + ':portal';

module.exports = {
  wrapJWT,
  unwrapJWT,
  encryptTOTP,
  decryptTOTP,
  PORTAL_JWT_SECRET,
};
