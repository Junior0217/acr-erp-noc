/**
 * backend/modules/auth/service.js
 *
 * Lógica de negocio del módulo Auth. NO conoce Express (req/res). Recibe
 * inputs como objetos planos (DTOs validados por controller) + `reqMeta`
 * con IP/UA/Accept-Language para auditoría y device fingerprint.
 *
 * Cada función pública retorna un descriptor `{ status, body, cookies }`
 * que el controller aplica sobre res. Esto desacopla la capa de negocio del
 * transporte HTTP y permite testear sin levantar Express.
 *
 * Factory: createAuthService({ repo, auditReq, twoFAStore, challengeStore,
 *   warmChallengeStore, IDLE_TTL_MS, PERMISSIONS_MAP })
 *
 * Owns:
 * - RSA challenge pool (rotación + warm-up)
 * - Login flow: bcrypt compare, 2FA gating, audit trail
 * - Session creation/refresh/revocation
 * - TOTP setup/enable/verify/disable + backup codes
 * - WebAuthn passkeys (registro + login + listado + revocación)
 * - Self-service password change
 */

const util    = require('util');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
const { authenticator } = require('otplib');
const { wrapJWT, unwrapJWT, encryptTOTP, decryptTOTP } = require('../../shared/jwt-crypto');
const { computeDeviceHash, labelFromUA } = require('../../shared/helpers');

const generateKeyPairAsync = util.promisify(crypto.generateKeyPair);

const BACKUP_CODES_COUNT      = 8;
const TWO_FA_TTL_MS           = 5 * 60_000;
const CHALLENGE_TTL_MS        = 120_000;
const WEBAUTHN_CHALLENGE_TTL  = 60_000;
const REFRESH_GRACE_MS        = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS          = 8 * 60 * 60 * 1000;

/** Error tipado para que el controller mapee a HTTP status estable. */
class AuthError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code   = code;
    if (extra) this.extra = extra;
  }
}

function createAuthService(deps) {
  const {
    repo, auditReq, twoFAStore, challengeStore, warmChallengeStore,
    IDLE_TTL_MS, PERMISSIONS_MAP,
  } = deps;
  if (!repo)                throw new Error('createAuthService: repo is required');
  if (!auditReq)            throw new Error('createAuthService: auditReq is required');
  if (!twoFAStore)          throw new Error('createAuthService: twoFAStore is required');
  if (!challengeStore)      throw new Error('createAuthService: challengeStore is required');
  if (typeof warmChallengeStore !== 'function') throw new Error('createAuthService: warmChallengeStore fn required');
  if (!IDLE_TTL_MS)         throw new Error('createAuthService: IDLE_TTL_MS is required');
  if (!PERMISSIONS_MAP)     throw new Error('createAuthService: PERMISSIONS_MAP is required');

  // ─── WebAuthn (optional dep) ──────────────────────────────────────────────
  let _webauthn = null;
  try { _webauthn = require('@simplewebauthn/server'); }
  catch { console.warn('[WEBAUTHN] @simplewebauthn/server no instalado.'); }

  const RP_NAME   = process.env.WEBAUTHN_RP_NAME ?? 'ACR Networks ERP';
  const RP_ID     = process.env.WEBAUTHN_RP_ID ?? (process.env.PUBLIC_FRONTEND_URL ? new URL(process.env.PUBLIC_FRONTEND_URL).hostname : 'localhost');
  const RP_ORIGIN = process.env.WEBAUTHN_ORIGIN ?? process.env.PUBLIC_FRONTEND_URL ?? 'http://localhost:5173';

  const _webauthnChallengeStore = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _webauthnChallengeStore.entries()) if (v.exp < now) _webauthnChallengeStore.delete(k);
  }, 60_000).unref();

  function _requireWebauthn() {
    if (!_webauthn) throw new AuthError(503, 'WEBAUTHN_DISABLED', 'WebAuthn no instalado. Ejecuta `npm install` en backend.');
  }

  // ─── Helpers internos ─────────────────────────────────────────────────────
  function _isProd() { return process.env.NODE_ENV === 'production'; }

  function _baseCookieOpts(maxAge) {
    const prod = _isProd();
    return {
      secure:   prod,
      sameSite: prod ? 'none' : 'lax',
      maxAge,
      ...(prod ? { partitioned: true } : {}),
    };
  }

  /**
   * Construye un objeto "req-like" a partir de reqMeta para que auditReq —
   * que espera la forma de Express req — pueda extraer IP/UA sin acoplarse
   * a este módulo. Mantiene la API de auditReq estable.
   */
  function _fakeReqForAudit(reqMeta, user) {
    return {
      headers: {
        'x-forwarded-for': reqMeta?.ip ?? null,
        'user-agent':      reqMeta?.ua ?? null,
      },
      socket: { remoteAddress: reqMeta?.ip ?? null },
      user:   user ?? null,
    };
  }

  /**
   * Crea sesión + JWT + cookies tras un login exitoso. Devuelve descriptor
   * para que el controller aplique cookies y body. Extraído de server.js
   * (función `completarLogin` legacy) y adaptado al contrato del Blueprint.
   */
  async function completarLogin(empleado, reqMeta, rememberMe = false, needs2FASetup = false) {
    const jti        = crypto.randomUUID();
    const ua         = reqMeta?.ua ?? '';
    const ip         = reqMeta?.ip ?? null;
    const acceptLang = reqMeta?.acceptLang ?? '';
    const secChUa    = reqMeta?.secChUa ?? '';
    const deviceHash = computeDeviceHash(ua, ip, acceptLang, secChUa);
    const ttl        = rememberMe ? 30 * 24 * 60 * 60 * 1000 : IDLE_TTL_MS;
    const jwtTTL     = rememberMe ? '30d' : '30m';
    const expiresAt  = new Date(Date.now() + ttl);

    // Device fingerprint — detecta first-login desde un dispositivo nuevo y
    // dispara alerta visible al owner via AuditCaja.
    let nuevoDispositivo = false;
    try {
      const existing = await repo.findDeviceFingerprint(empleado.id, deviceHash);
      if (existing) {
        await repo.touchDeviceFingerprint(existing.id, ip, ua);
      } else {
        await repo.createDeviceFingerprint({ empleadoId: empleado.id, hash: deviceHash, label: labelFromUA(ua), ip, userAgent: ua });
        await repo.createAuditCajaDeviceAlert(empleado.id, labelFromUA(ua), ip, ua).catch(() => {});
        auditReq('auth:device_nuevo', _fakeReqForAudit(reqMeta), { empleadoId: empleado.id, deviceHash, label: labelFromUA(ua) });
        nuevoDispositivo = true;
      }
    } catch (e) { console.error('[FINGERPRINT]', e.message); }

    await repo.createSessionToken({ jti, empleadoId: empleado.id, userAgent: ua, expiresAt, ip, deviceHash });

    const permisos = [...new Set([
      ...(empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : []),
      ...(Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra : []),
    ])];
    const jwtPayload = { sub: empleado.id, nombre: empleado.nombre, permisos, jti, ua, ...(needs2FASetup ? { needs2FASetup: true } : {}) };
    const jwtStr     = jwt.sign(jwtPayload, process.env.JWT_SECRET, { expiresIn: jwtTTL });
    const token      = wrapJWT(jwtStr);
    const csrf       = crypto.randomBytes(32).toString('hex');
    const baseCookie = _baseCookieOpts(ttl);

    const body = { id: empleado.id, nombre: empleado.nombre, cargo: empleado.cargo, permisos };
    if (needs2FASetup)    body.needs2FASetup = true;
    if (nuevoDispositivo) body.nuevoDispositivo = true;
    return {
      status: 200,
      body,
      cookies: {
        set: [
          { name: 'csrf',  value: csrf,  opts: { ...baseCookie, httpOnly: false } },
          { name: 'token', value: token, opts: { ...baseCookie, httpOnly: true, signed: true } },
        ],
      },
    };
  }

  // ─── /auth/challenge (RSA) ────────────────────────────────────────────────
  async function getChallenge() {
    const now = Date.now();
    for (const [cid, entry] of challengeStore) {
      if (entry.exp > now && entry.publicKey) {
        challengeStore.set(cid, { privateKey: entry.privateKey, exp: now + CHALLENGE_TTL_MS });
        setImmediate(() => warmChallengeStore(1));
        return { status: 200, body: { cid, publicKey: entry.publicKey } };
      }
    }
    const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const cid = crypto.randomUUID();
    challengeStore.set(cid, { privateKey, exp: now + CHALLENGE_TTL_MS });
    return { status: 200, body: { cid, publicKey: Buffer.from(publicKey).toString('base64') } };
  }

  // ─── /auth/login ──────────────────────────────────────────────────────────
  async function login({ email, cid, ciphertext, rememberMe }, reqMeta) {
    const challenge = challengeStore.get(cid);
    if (!challenge || challenge.exp < Date.now()) {
      throw new AuthError(400, 'CHALLENGE_INVALID', 'Challenge inválido o expirado.');
    }
    challengeStore.delete(cid);

    let password;
    try {
      password = crypto.privateDecrypt(
        { key: challenge.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(ciphertext, 'base64'),
      ).toString('utf8');
    } catch {
      throw new AuthError(401, 'BAD_CREDENTIALS', 'Credenciales inválidas.');
    }

    const empleado = await repo.findEmpleadoByEmailWithActiveRoles(email);
    if (!empleado || empleado.bloqueado || !empleado.passwordHash) {
      password = null;
      throw new AuthError(401, 'BAD_CREDENTIALS', 'Credenciales inválidas.');
    }
    const valid = await bcrypt.compare(password, empleado.passwordHash);
    password = null;
    if (!valid) {
      auditReq('auth:login_fail', _fakeReqForAudit(reqMeta), { email });
      throw new AuthError(401, 'BAD_CREDENTIALS', 'Credenciales inválidas.');
    }

    // 2FA-by-role: si el rol exige 2FA y el usuario aún no lo configuró,
    // emitimos sesión con flag needs2FASetup (forzará el setup en el primer click).
    const requires2FAByRole = empleado.roles.some(r => r.require2FA);
    if (requires2FAByRole && !empleado.twoFactorEnabled) {
      auditReq('auth:login_success', _fakeReqForAudit(reqMeta), { email: empleado.email, needs2FASetup: true }, { userId: empleado.id, userName: empleado.nombre });
      return completarLogin(empleado, reqMeta, rememberMe, true);
    }

    // Login desde IP diferente al último login exitoso → alerta (no bloqueo).
    try {
      const lastLogin = await repo.findLastLoginAudit(empleado.id);
      if (lastLogin?.ip && lastLogin.ip !== reqMeta?.ip) {
        auditReq('auth:suspicious_location', _fakeReqForAudit(reqMeta), { knownIP: lastLogin.ip, newIP: reqMeta?.ip }, { userId: empleado.id, userName: empleado.nombre });
      }
    } catch { /* non-fatal */ }

    if (empleado.twoFactorEnabled) {
      const tempToken = crypto.randomUUID();
      twoFAStore.set(tempToken, { empleadoId: empleado.id, exp: Date.now() + TWO_FA_TTL_MS, rememberMe });
      auditReq('auth:2fa_challenge', _fakeReqForAudit(reqMeta), { email: empleado.email }, { userId: empleado.id, userName: empleado.nombre });
      return { status: 200, body: { requires2FA: true, tempToken } };
    }

    auditReq('auth:login_success', _fakeReqForAudit(reqMeta), { email: empleado.email }, { userId: empleado.id, userName: empleado.nombre });
    return completarLogin(empleado, reqMeta, rememberMe);
  }

  // ─── /auth/me ─────────────────────────────────────────────────────────────
  async function getMe(user) {
    const emp = await repo.findEmpleadoByIdForMe(user.sub);
    const permisos = Array.isArray(user.permisos) ? user.permisos : [];
    const needs2FASetup = user.needs2FASetup === true && !emp?.twoFactorEnabled;
    const nivelMax = emp?.roles?.length ? Math.max(...emp.roles.map(r => r.nivel ?? 0)) : 0;
    const backupCodesCount = Array.isArray(emp?.backupCodes) ? emp.backupCodes.length : 0;
    const body = {
      id: user.sub, nombre: user.nombre, permisos,
      twoFactorEnabled:    emp?.twoFactorEnabled ?? false,
      nivelMax,
      backupCodesCount,
      backupCodesAviso:    emp?.twoFactorEnabled && backupCodesCount <= 2,
      backupCodesAgotados: emp?.twoFactorEnabled && backupCodesCount === 0,
      webauthnEnrolled:    (emp?._count?.webauthnCredentials ?? 0) > 0,
    };
    if (needs2FASetup) body.needs2FASetup = true;
    return { status: 200, body };
  }

  function getPermissionsMap() {
    return { status: 200, body: PERMISSIONS_MAP };
  }

  // ─── /auth/csrf ───────────────────────────────────────────────────────────
  function getOrIssueCsrf(existingCookieValue) {
    if (existingCookieValue) {
      return { status: 200, body: { csrfToken: existingCookieValue } };
    }
    const token = crypto.randomBytes(32).toString('hex');
    return {
      status: 200,
      body: { csrfToken: token },
      cookies: {
        set: [{
          name: 'csrf',
          value: token,
          opts: { ..._baseCookieOpts(IDLE_TTL_MS), httpOnly: false },
        }],
      },
    };
  }

  // ─── /auth/logout ─────────────────────────────────────────────────────────
  async function logout(user, reqMeta) {
    auditReq('auth:logout', _fakeReqForAudit(reqMeta, user));
    await repo.deleteSessionByJtiAll(user.jti);
    return {
      status: 204,
      body: null,
      cookies: { clear: ['token', 'csrf'] },
    };
  }

  // ─── /auth/refresh ────────────────────────────────────────────────────────
  async function refresh(signedTokenCookie, reqMeta) {
    if (!signedTokenCookie) throw new AuthError(401, 'NO_SESSION', 'No autenticado.');
    let payload;
    try {
      const jwtStr = unwrapJWT(signedTokenCookie);
      payload = jwt.verify(jwtStr, process.env.JWT_SECRET, { ignoreExpiration: true });
    } catch {
      throw new AuthError(401, 'TOKEN_INVALID', 'Token inválido.');
    }
    const session = await repo.findSessionByJti(payload.jti);
    if (!session) throw new AuthError(401, 'SESSION_INVALID', 'Sesión inválida.');
    const maxRefreshAt = new Date(session.expiresAt.getTime() + REFRESH_GRACE_MS);
    if (maxRefreshAt < new Date()) throw new AuthError(401, 'SESSION_EXPIRED', 'Sesión expirada. Inicia sesión de nuevo.');

    const empleado = await repo.findEmpleadoForRefresh(payload.sub);
    if (!empleado || empleado.deletedAt || empleado.bloqueado) throw new AuthError(401, 'ACCOUNT_INACTIVE', 'Cuenta inactiva.');

    const newJti    = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await repo.rotateSession(payload.jti, {
      jti: newJti, empleadoId: empleado.id, userAgent: session.userAgent, ip: session.ip, expiresAt,
    });

    const permisos = [...new Set([
      ...(empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : []),
      ...(Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra : []),
    ])];
    const ua       = reqMeta?.ua ?? '';
    const newJwt   = jwt.sign({ sub: empleado.id, nombre: empleado.nombre, permisos, jti: newJti, ua }, process.env.JWT_SECRET, { expiresIn: '8h' });
    const newToken = wrapJWT(newJwt);
    const csrf     = crypto.randomBytes(32).toString('hex');
    const base     = _baseCookieOpts(REFRESH_TTL_MS);

    auditReq('auth:refresh', _fakeReqForAudit(reqMeta), { empleadoId: empleado.id });
    return {
      status: 200,
      body:   { id: empleado.id, nombre: empleado.nombre, permisos },
      cookies: {
        set: [
          { name: 'token', value: newToken, opts: { ...base, httpOnly: true } },
          { name: 'csrf',  value: csrf,     opts: { ...base, httpOnly: false } },
        ],
      },
    };
  }

  // ─── 2FA helpers ──────────────────────────────────────────────────────────
  function generarBackupCodes() {
    const codes = [];
    for (let i = 0; i < BACKUP_CODES_COUNT; i++) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      const bytes = crypto.randomBytes(10);
      for (let j = 0; j < 10; j++) code += chars[bytes[j] % chars.length];
      codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    }
    return codes;
  }

  async function _hashBackupCodes(plainCodes) {
    return Promise.all(plainCodes.map(c => bcrypt.hash(c.replace(/-/g, '').toUpperCase(), 10)));
  }

  // ─── /auth/2fa/verify ─────────────────────────────────────────────────────
  async function verifyTwoFA({ tempToken, totp }, reqMeta) {
    const entry = twoFAStore.get(tempToken);
    if (!entry || entry.exp < Date.now()) {
      throw new AuthError(400, 'TEMP_TOKEN_EXPIRED', 'Token expirado. Vuelve a iniciar sesión.');
    }
    twoFAStore.delete(tempToken);

    const empleado = await repo.findEmpleadoByIdWithActiveRoles(entry.empleadoId);
    if (!empleado || !empleado.twoFactorSecret) {
      throw new AuthError(400, 'TOTP_NOT_CONFIGURED', 'Error de configuración 2FA.');
    }

    let secret;
    try {
      secret = decryptTOTP(empleado.twoFactorSecret);
    } catch (decryptErr) {
      console.error('[2FA ERROR] decryptTOTP failed:', { empleadoId: empleado.id, message: decryptErr.message });
      throw new AuthError(400, '2FA_SECRET_INVALID', 'El secreto 2FA no puede descifrarse. El administrador debe resetear el 2FA de este usuario.');
    }

    let valido    = authenticator.verify({ token: totp, secret });
    let viaBackup = false;
    if (!valido && totp.replace(/[-\s]/g, '').length >= 10) {
      valido = await repo.consumeBackupCodeTx(empleado.id, totp);
      viaBackup = valido;
    }
    if (!valido) {
      auditReq('auth:2fa_fail', _fakeReqForAudit(reqMeta), {}, { userId: empleado.id, userName: empleado.nombre });
      throw new AuthError(401, 'PIN_INVALID', 'PIN inválido.');
    }

    let backupCodesRestantes = null;
    if (viaBackup) {
      const recargado = await repo.findEmpleadoBackupCodesOnly(empleado.id);
      backupCodesRestantes = Array.isArray(recargado?.backupCodes) ? recargado.backupCodes.length : null;
      auditReq('auth:2fa_backup_used', _fakeReqForAudit(reqMeta), { restantes: backupCodesRestantes }, { userId: empleado.id, userName: empleado.nombre });
    }
    auditReq('auth:login_success', _fakeReqForAudit(reqMeta), { via: viaBackup ? 'backup' : '2fa' }, { userId: empleado.id, userName: empleado.nombre });

    const out = await completarLogin(empleado, reqMeta, entry.rememberMe ?? false);
    if (viaBackup) out.body.backupCodesRestantes = backupCodesRestantes;
    return out;
  }

  // ─── /auth/2fa/setup ──────────────────────────────────────────────────────
  async function setupTwoFA(user) {
    const secret     = authenticator.generateSecret();
    const encrypted  = encryptTOTP(secret);
    const otpauthUrl = authenticator.keyuri(user.nombre, 'ACR Networks ERP', secret);
    const qrCode     = await QRCode.toDataURL(otpauthUrl);
    await repo.setEmpleadoTwoFactorSecret(user.sub, encrypted);
    return { status: 200, body: { qrCode, secret } };
  }

  // ─── /auth/2fa/enable ─────────────────────────────────────────────────────
  async function enableTwoFA(user, { totp }, reqMeta) {
    const emp = await repo.findEmpleadoTwoFactorState(user.sub);
    if (!emp?.twoFactorSecret)  throw new AuthError(400, 'NO_SECRET',     'Genera el QR primero.');
    if (emp.twoFactorEnabled)   throw new AuthError(400, 'ALREADY_ENABLED','2FA ya está activo.');
    const secret = decryptTOTP(emp.twoFactorSecret);
    if (!authenticator.verify({ token: totp, secret })) {
      throw new AuthError(401, 'PIN_INVALID', 'PIN inválido.');
    }
    const plain  = generarBackupCodes();
    const hashed = await _hashBackupCodes(plain);
    await repo.setEmpleadoTwoFactorEnabled(user.sub, hashed);
    auditReq('auth:2fa_enabled', _fakeReqForAudit(reqMeta, user), { backupCodesGenerados: plain.length });
    return { status: 201, body: { backupCodes: plain, count: plain.length } };
  }

  // ─── /auth/2fa/disable ────────────────────────────────────────────────────
  async function disableTwoFA(user, { totp }, reqMeta) {
    const emp = await repo.findEmpleadoTwoFactorState(user.sub);
    if (!emp?.twoFactorEnabled) throw new AuthError(400, 'NOT_ENABLED', '2FA no está activo.');
    const secret = decryptTOTP(emp.twoFactorSecret);
    if (!authenticator.verify({ token: totp, secret })) {
      throw new AuthError(401, 'PIN_INVALID', 'PIN inválido.');
    }
    await repo.disableEmpleadoTwoFactor(user.sub);
    auditReq('auth:2fa_disabled', _fakeReqForAudit(reqMeta, user));
    return { status: 204, body: null };
  }

  // ─── /auth/2fa/backup-codes/regenerate ────────────────────────────────────
  async function regenerateBackupCodes(user, { totp }, reqMeta) {
    const emp = await repo.findEmpleadoTwoFactorState(user.sub);
    if (!emp?.twoFactorEnabled) throw new AuthError(400, 'NOT_ENABLED', '2FA no está activo.');
    const secret = decryptTOTP(emp.twoFactorSecret);
    if (!authenticator.verify({ token: totp, secret })) {
      throw new AuthError(401, 'PIN_INVALID', 'PIN inválido.');
    }
    const plain  = generarBackupCodes();
    const hashed = await _hashBackupCodes(plain);
    await repo.setEmpleadoBackupCodes(user.sub, hashed);
    auditReq('auth:2fa_backup_regen', _fakeReqForAudit(reqMeta, user));
    return { status: 200, body: { backupCodes: plain, count: plain.length } };
  }

  async function countBackupCodes(user) {
    const emp = await repo.findEmpleadoBackupCodesOnly(user.sub);
    const codes = Array.isArray(emp?.backupCodes) ? emp.backupCodes : [];
    return { status: 200, body: { count: codes.length } };
  }

  // ─── /auth/me/password ────────────────────────────────────────────────────
  async function changeOwnPassword(user, { currentPassword, newPassword }, reqMeta) {
    const emp = await repo.findEmpleadoPasswordHashOnly(user.sub);
    if (!emp) throw new AuthError(404, 'USER_NOT_FOUND', 'Usuario no encontrado.');
    const valid = await bcrypt.compare(currentPassword, emp.passwordHash);
    if (!valid) throw new AuthError(401, 'BAD_CURRENT_PASSWORD', 'Contraseña actual incorrecta.');
    const newHash = await bcrypt.hash(newPassword, 12);
    await repo.updatePasswordAndRevokeOtherSessions(user.sub, newHash, user.jti);
    auditReq('auth:self_password_change', _fakeReqForAudit(reqMeta, user));
    return { status: 204, body: null };
  }

  // ─── /auth/me/sessions ────────────────────────────────────────────────────
  async function listMySessions(user) {
    const data = await repo.findActiveSessionsByEmpleado(user.sub);
    return { status: 200, body: { data, current: user.jti } };
  }

  async function revokeMySession(user, jti, reqMeta) {
    if (!jti) throw new AuthError(400, 'JTI_REQUIRED', 'JTI requerido.');
    const session = await repo.findSessionByJti(jti);
    if (!session || session.empleadoId !== user.sub) throw new AuthError(404, 'SESSION_NOT_FOUND', 'Sesión no encontrada.');
    await repo.deleteSessionByJti(jti);
    auditReq('auth:session_revoked', _fakeReqForAudit(reqMeta, user), { jti });
    return { status: 204, body: null };
  }

  async function revokeAllMyOtherSessions(user, reqMeta) {
    const r = await repo.deleteOtherSessionsByEmpleado(user.sub, user.jti);
    auditReq('auth:sessions_revoked_bulk', _fakeReqForAudit(reqMeta, user), { count: r.count });
    return { status: 200, body: { ok: true, count: r.count } };
  }

  // ─── WebAuthn ─────────────────────────────────────────────────────────────
  async function webauthnRegisterOptions(user) {
    _requireWebauthn();
    const emp = await repo.findEmpleadoWithWebauthnCredentials(user.sub);
    if (!emp) throw new AuthError(404, 'EMPLEADO_NOT_FOUND', 'Empleado no encontrado.');
    const options = await _webauthn.generateRegistrationOptions({
      rpName:           RP_NAME,
      rpID:             RP_ID,
      userName:         emp.email,
      userDisplayName:  emp.nombre,
      userID:           Buffer.from(String(emp.id)),
      attestationType:  'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: emp.webauthnCredentials.map(c => ({ id: c.credentialId, transports: c.transports })),
    });
    _webauthnChallengeStore.set(`reg:${emp.id}`, { challenge: options.challenge, exp: Date.now() + WEBAUTHN_CHALLENGE_TTL });
    return { status: 200, body: options };
  }

  async function webauthnRegisterVerify(user, body, deviceName, reqMeta) {
    _requireWebauthn();
    const stored = _webauthnChallengeStore.get(`reg:${user.sub}`);
    if (!stored || stored.exp < Date.now()) throw new AuthError(400, 'CHALLENGE_EXPIRED', 'Challenge expirado. Reintenta.');
    _webauthnChallengeStore.delete(`reg:${user.sub}`);

    const verification = await _webauthn.verifyRegistrationResponse({
      response:                body,
      expectedChallenge:       stored.challenge,
      expectedOrigin:          RP_ORIGIN,
      expectedRPID:            RP_ID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new AuthError(401, 'WEBAUTHN_VERIFY_FAIL', 'Verificación WebAuthn falló.');
    }
    const { credential, credentialBackedUp } = verification.registrationInfo;
    await repo.createWebauthnCredential({
      empleadoId:     user.sub,
      credentialId:   credential.id,
      publicKey:      Buffer.from(credential.publicKey).toString('base64url'),
      counter:        BigInt(credential.counter ?? 0),
      transports:     credential.transports ?? [],
      deviceName:     deviceName ?? null,
      backupEligible: !!credentialBackedUp,
    });
    auditReq('auth:webauthn_registered', _fakeReqForAudit(reqMeta, user), { deviceName, backupEligible: !!credentialBackedUp });
    return { status: 201, body: { ok: true, deviceName: deviceName ?? null } };
  }

  async function webauthnLoginOptions({ email }) {
    _requireWebauthn();
    let allowCredentials = [];
    let empleadoId       = null;
    if (email) {
      const emp = await repo.findEmpleadoByEmailWithWebauthnCredentials(email);
      if (emp) {
        empleadoId = emp.id;
        allowCredentials = emp.webauthnCredentials.map(c => ({ id: c.credentialId, transports: c.transports }));
      }
    }
    const options = await _webauthn.generateAuthenticationOptions({
      rpID: RP_ID, allowCredentials, userVerification: 'required',
    });
    const sessionKey = `auth:${crypto.randomUUID()}`;
    _webauthnChallengeStore.set(sessionKey, { challenge: options.challenge, empleadoId, exp: Date.now() + WEBAUTHN_CHALLENGE_TTL });
    return { status: 200, body: { ...options, sessionKey } };
  }

  async function webauthnLoginVerify(body, reqMeta) {
    _requireWebauthn();
    const { sessionKey, rememberMe } = body;
    const stored = _webauthnChallengeStore.get(sessionKey);
    if (!stored || stored.exp < Date.now()) throw new AuthError(400, 'CHALLENGE_EXPIRED', 'Challenge expirado.');
    _webauthnChallengeStore.delete(sessionKey);

    const credentialId = body?.id;
    const cred = await repo.findWebauthnCredentialWithEmpleado(credentialId);
    if (!cred) throw new AuthError(404, 'CRED_UNKNOWN', 'Credencial no reconocida.');
    if (stored.empleadoId && stored.empleadoId !== cred.empleadoId) {
      throw new AuthError(401, 'CRED_MISMATCH', 'Credencial no asociada a este usuario.');
    }

    const verification = await _webauthn.verifyAuthenticationResponse({
      response:                body,
      expectedChallenge:       stored.challenge,
      expectedOrigin:          RP_ORIGIN,
      expectedRPID:            RP_ID,
      credential: {
        id:        cred.credentialId,
        publicKey: Buffer.from(cred.publicKey, 'base64url'),
        counter:   Number(cred.counter),
        transports: cred.transports,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      auditReq('auth:webauthn_fail', _fakeReqForAudit(reqMeta), { empleadoId: cred.empleadoId });
      throw new AuthError(401, 'ASSERTION_FAIL', 'Assertion falló verificación.');
    }
    const newCounter = BigInt(verification.authenticationInfo.newCounter ?? 0);
    if (cred.counter > 0n && newCounter <= cred.counter) {
      auditReq('auth:webauthn_replay_suspect', _fakeReqForAudit(reqMeta), { empleadoId: cred.empleadoId, oldCounter: String(cred.counter), newCounter: String(newCounter) });
      throw new AuthError(401, 'COUNTER_REGRESSION', 'Counter regresivo — posible clon de credencial.');
    }
    await repo.updateWebauthnCounter(cred.id, newCounter);
    auditReq('auth:login_success', _fakeReqForAudit(reqMeta), { via: 'webauthn' }, { userId: cred.empleadoId, userName: cred.empleado.nombre });
    return completarLogin(cred.empleado, reqMeta, rememberMe);
  }

  async function listWebauthnCredentials(user) {
    const data = await repo.listWebauthnCredentialsByEmpleado(user.sub);
    return { status: 200, body: { data, count: data.length } };
  }

  async function deleteWebauthnCredential(user, id, reqMeta) {
    const r = await repo.deleteWebauthnCredentialOwnedBy(id, user.sub);
    if (r.count === 0) throw new AuthError(404, 'CRED_NOT_FOUND', 'Credencial no encontrada.');
    auditReq('auth:webauthn_revoked', _fakeReqForAudit(reqMeta, user), { credentialId: id });
    return { status: 204, body: null };
  }

  return {
    AuthError,
    getChallenge,
    login,
    getMe,
    getPermissionsMap,
    getOrIssueCsrf,
    logout,
    refresh,
    verifyTwoFA,
    setupTwoFA,
    enableTwoFA,
    disableTwoFA,
    regenerateBackupCodes,
    countBackupCodes,
    changeOwnPassword,
    listMySessions,
    revokeMySession,
    revokeAllMyOtherSessions,
    webauthnRegisterOptions,
    webauthnRegisterVerify,
    webauthnLoginOptions,
    webauthnLoginVerify,
    listWebauthnCredentials,
    deleteWebauthnCredential,
  };
}

module.exports = createAuthService;
module.exports.AuthError = AuthError;
