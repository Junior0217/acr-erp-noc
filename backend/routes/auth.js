/**
 * backend/routes/auth.js
 *
 * Auth router migrated from monolith. Owns login/logout/refresh, 2FA TOTP
 * (con backup codes), WebAuthn (passkeys), self-service password change,
 * session listing, RSA challenge endpoint, and CSRF echo.
 *
 * Receives deps via factory (prisma, middlewares, schemas, limiters, jwt-crypto
 * helpers, completarLogin closure, stores, etc.) — see _routerDeps in server.js.
 */

const express = require('express');
const util    = require('util');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
const { authenticator } = require('otplib');
const { z } = require('zod');
const { wrapJWT, unwrapJWT, encryptTOTP, decryptTOTP } = require('../shared/jwt-crypto');

function createAuthRouter(deps) {
  const router = express.Router();
  const {
    prisma, middlewares, schemas, auditReq, limiters,
    completarLogin, twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
    PERMISSIONS_MAP,
  } = deps;
  const { verificarJWT, requerirPermiso } = middlewares;
  const { loginLimiter, totpLimiter, backupCodeLimiter } = limiters;
  const { passwordSchema } = schemas;

  const generateKeyPairAsync = util.promisify(crypto.generateKeyPair);

  router.get('/auth/challenge', async (req, res) => {
    try {
      const now = Date.now();
      for (const [cid, entry] of challengeStore) {
        if (entry.exp > now && entry.publicKey) {
          challengeStore.set(cid, { privateKey: entry.privateKey, exp: now + 120_000 });
          setImmediate(() => warmChallengeStore(1));
          return res.json({ cid, publicKey: entry.publicKey });
        }
      }
      const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding:  { type: 'spki',  format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const cid = crypto.randomUUID();
      challengeStore.set(cid, { privateKey, exp: now + 120_000 });
      res.json({ cid, publicKey: Buffer.from(publicKey).toString('base64') });
    } catch (error) {
      console.error('[CHALLENGE ERROR]', { message: error.message, code: error.code, stack: error.stack });
      res.status(500).json({ error: 'RSA_FAILURE', message: error.message });
    }
  });

  const loginSchema = z.object({
    email:      z.string().email(),
    cid:        z.string().uuid(),
    ciphertext: z.string().min(1),
    rememberMe: z.boolean().optional().default(false),
  });

  router.post('/auth/login', loginLimiter, async (req, res) => {
    try {
      const { email, cid, ciphertext, rememberMe } = loginSchema.parse(req.body);
      const challenge = challengeStore.get(cid);
      if (!challenge || challenge.exp < Date.now()) {
        return res.status(400).json({ error: 'Challenge inválido o expirado.' });
      }
      challengeStore.delete(cid);

      let password;
      try {
        password = crypto.privateDecrypt(
          { key: challenge.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(ciphertext, 'base64')
        ).toString('utf8');
      } catch { return res.status(401).json({ error: 'Credenciales inválidas.' }); }

      const empleado = await prisma.empleado.findUnique({
        where: { email },
        include: { roles: { where: { activo: true } } },
      });
      if (!empleado || empleado.bloqueado || !empleado.passwordHash) {
        password = null;
        return res.status(401).json({ error: 'Credenciales inválidas.' });
      }
      const valid = await bcrypt.compare(password, empleado.passwordHash);
      password = null;
      if (!valid) {
        auditReq('auth:login_fail', req, { email });
        return res.status(401).json({ error: 'Credenciales inválidas.' });
      }

      const requires2FAByRole = empleado.roles.some(r => r.require2FA);
      if (requires2FAByRole && !empleado.twoFactorEnabled) {
        auditReq('auth:login_success', req, { email: empleado.email, needs2FASetup: true }, { userId: empleado.id, userName: empleado.nombre });
        const payload = await completarLogin(empleado, req, res, rememberMe, true);
        return res.json(payload);
      }

      const currentIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
      const lastLogin = await prisma.auditLog.findFirst({
        where: { evento: 'auth:login_success', usuarioId: empleado.id },
        orderBy: { creadoEn: 'desc' },
      });
      if (lastLogin?.ip && lastLogin.ip !== currentIP) {
        auditReq('auth:suspicious_location', req, { knownIP: lastLogin.ip, newIP: currentIP }, { userId: empleado.id, userName: empleado.nombre });
      }

      if (empleado.twoFactorEnabled) {
        const tempToken = crypto.randomUUID();
        twoFAStore.set(tempToken, { empleadoId: empleado.id, exp: Date.now() + 5 * 60_000, rememberMe });
        auditReq('auth:2fa_challenge', req, { email: empleado.email }, { userId: empleado.id, userName: empleado.nombre });
        return res.json({ requires2FA: true, tempToken });
      }

      auditReq('auth:login_success', req, { email: empleado.email }, { userId: empleado.id, userName: empleado.nombre });
      const payload = await completarLogin(empleado, req, res, rememberMe);
      res.json(payload);
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  router.get('/auth/me', verificarJWT, async (req, res) => {
    try {
      const emp = await prisma.empleado.findUnique({
        where: { id: req.user.sub },
        select: {
          twoFactorEnabled: true,
          backupCodes:      true,
          roles:            { where: { activo: true }, select: { nivel: true } },
          _count:           { select: { webauthnCredentials: true } },
        },
      });
      const permisos = Array.isArray(req.user.permisos) ? req.user.permisos : [];
      const needs2FASetup = req.user.needs2FASetup === true && !emp?.twoFactorEnabled;
      const nivelMax = emp?.roles?.length ? Math.max(...emp.roles.map(r => r.nivel ?? 0)) : 0;
      const backupCodesCount = Array.isArray(emp?.backupCodes) ? emp.backupCodes.length : 0;
      const out = {
        id: req.user.sub, nombre: req.user.nombre, permisos,
        twoFactorEnabled: emp?.twoFactorEnabled ?? false, nivelMax,
        backupCodesCount,
        backupCodesAviso: emp?.twoFactorEnabled && backupCodesCount <= 2,
        backupCodesAgotados: emp?.twoFactorEnabled && backupCodesCount === 0,
        webauthnEnrolled: (emp?._count?.webauthnCredentials ?? 0) > 0,
      };
      if (needs2FASetup) out.needs2FASetup = true;
      res.json(out);
    } catch { res.status(500).json({ error: 'Error interno.' }); }
  });

  router.get('/auth/permissions', verificarJWT, (req, res) => {
    res.json(PERMISSIONS_MAP);
  });

  router.get('/auth/csrf', verificarJWT, (req, res) => {
    let token = req.cookies?.csrf;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      const isProd = process.env.NODE_ENV === 'production';
      res.cookie('csrf', token, {
        httpOnly: false,
        secure:   isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge:   IDLE_TTL_MS,
        ...(isProd ? { partitioned: true } : {}),
      });
    }
    res.json({ csrfToken: token });
  });

  router.post('/auth/logout', verificarJWT, async (req, res) => {
    auditReq('auth:logout', req);
    await prisma.sessionToken.deleteMany({ where: { jti: req.user.jti } });
    res.clearCookie('token');
    res.clearCookie('csrf');
    res.status(204).end();
  });

  router.post('/auth/refresh', async (req, res) => {
    try {
      const wrapped = req.signedCookies?.token;
      if (!wrapped) return res.status(401).json({ error: 'No autenticado.' });
      const jwtStr  = unwrapJWT(wrapped);
      const payload = jwt.verify(jwtStr, process.env.JWT_SECRET, { ignoreExpiration: true });
      const session = await prisma.sessionToken.findUnique({ where: { jti: payload.jti } });
      if (!session) return res.status(401).json({ error: 'Sesión inválida.' });
      const maxRefreshAt = new Date(session.expiresAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (maxRefreshAt < new Date()) return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
      const empleado = await prisma.empleado.findUnique({
        where:   { id: payload.sub },
        include: { roles: { where: { activo: true }, select: { permisos: true } } },
      });
      if (!empleado || empleado.deletedAt || empleado.bloqueado) return res.status(401).json({ error: 'Cuenta inactiva.' });
      const newJti    = crypto.randomUUID();
      const ttl       = 8 * 60 * 60 * 1000;
      const expiresAt = new Date(Date.now() + ttl);
      await prisma.$transaction([
        prisma.sessionToken.delete({ where: { jti: payload.jti } }),
        prisma.sessionToken.create({ data: { jti: newJti, empleadoId: empleado.id, userAgent: session.userAgent, ip: session.ip, expiresAt } }),
      ]);
      const permisos = [...new Set([
        ...(empleado.roles ?? []).flatMap(r => Array.isArray(r.permisos) ? r.permisos : []),
        ...(Array.isArray(empleado.permisosExtra) ? empleado.permisosExtra : []),
      ])];
      const ua        = req.headers['user-agent'] || '';
      const newJwt    = jwt.sign({ sub: empleado.id, nombre: empleado.nombre, permisos, jti: newJti, ua }, process.env.JWT_SECRET, { expiresIn: '8h' });
      const newToken  = wrapJWT(newJwt);
      const csrf      = crypto.randomBytes(32).toString('hex');
      const isProd    = process.env.NODE_ENV === 'production';
      const cookieOpts = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', maxAge: ttl, ...(isProd ? { partitioned: true } : {}) };
      res.cookie('token', newToken, cookieOpts);
      res.cookie('csrf',  csrf,     { ...cookieOpts, httpOnly: false });
      auditReq('auth:refresh', req, { empleadoId: empleado.id });
      res.json({ id: empleado.id, nombre: empleado.nombre, permisos });
    } catch {
      res.status(401).json({ error: 'Token inválido.' });
    }
  });

  // ─── 2FA ──────────────────────────────────────────────────────────────────
  function aplicarBackupLimiterSiAplica(req, res, next) {
    const candidate = String(req.body?.totp ?? '').replace(/[-\s]/g, '');
    if (candidate.length >= 10) return backupCodeLimiter(req, res, next);
    next();
  }

  const BACKUP_CODES_COUNT = 8;

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

  async function hashBackupCodes(plainCodes) {
    return Promise.all(plainCodes.map(c => bcrypt.hash(c.replace(/-/g, '').toUpperCase(), 10)));
  }

  async function consumeBackupCode(empleadoId, candidate) {
    if (!candidate) return false;
    const normalized = String(candidate).replace(/[-\s]/g, '').toUpperCase();
    return prisma.$transaction(async (tx) => {
      const emp = await tx.empleado.findUnique({ where: { id: empleadoId }, select: { backupCodes: true } });
      const codes = Array.isArray(emp?.backupCodes) ? emp.backupCodes : [];
      let matchIdx = -1;
      for (let i = 0; i < codes.length; i++) {
        const ok = await bcrypt.compare(normalized, codes[i]);
        if (ok && matchIdx === -1) matchIdx = i;
      }
      if (matchIdx === -1) return false;
      const next = [...codes.slice(0, matchIdx), ...codes.slice(matchIdx + 1)];
      await tx.empleado.update({ where: { id: empleadoId }, data: { backupCodes: next } });
      return true;
    }, { isolationLevel: 'Serializable', timeout: 8000 }).catch(e => {
      console.warn('[consumeBackupCode] tx conflict:', e.code, e.message);
      return false;
    });
  }

  router.post('/auth/2fa/verify', totpLimiter, aplicarBackupLimiterSiAplica, async (req, res) => {
    try {
      const { tempToken, totp } = z.object({
        tempToken: z.string().uuid(),
        totp:      z.string().min(6).max(20),
      }).parse(req.body);
      const entry = twoFAStore.get(tempToken);
      if (!entry || entry.exp < Date.now()) return res.status(400).json({ error: 'Token expirado. Vuelve a iniciar sesión.' });
      twoFAStore.delete(tempToken);
      const empleado = await prisma.empleado.findUnique({
        where: { id: entry.empleadoId },
        include: { roles: { where: { activo: true } } },
      });
      if (!empleado || !empleado.twoFactorSecret) return res.status(400).json({ error: 'Error de configuración 2FA.' });

      let secret;
      try {
        secret = decryptTOTP(empleado.twoFactorSecret);
      } catch (decryptErr) {
        console.error('[2FA ERROR] decryptTOTP failed:', { empleadoId: empleado.id, message: decryptErr.message });
        return res.status(400).json({
          error: '2FA_SECRET_INVALID',
          message: 'El secreto 2FA no puede descifrarse. El administrador debe resetear el 2FA de este usuario.',
        });
      }

      let valido = authenticator.verify({ token: totp, secret });
      let viaBackup = false;
      if (!valido) {
        if (totp.replace(/[-\s]/g, '').length >= 10) {
          valido = await consumeBackupCode(empleado.id, totp);
          viaBackup = valido;
        }
      }
      if (!valido) {
        auditReq('auth:2fa_fail', req, {}, { userId: empleado.id, userName: empleado.nombre });
        return res.status(401).json({ error: 'PIN inválido.' });
      }
      let backupCodesRestantes = null;
      if (viaBackup) {
        const recargado = await prisma.empleado.findUnique({ where: { id: empleado.id }, select: { backupCodes: true } });
        backupCodesRestantes = Array.isArray(recargado?.backupCodes) ? recargado.backupCodes.length : null;
        auditReq('auth:2fa_backup_used', req, { restantes: backupCodesRestantes }, { userId: empleado.id, userName: empleado.nombre });
      }
      auditReq('auth:login_success', req, { via: viaBackup ? 'backup' : '2fa' }, { userId: empleado.id, userName: empleado.nombre });
      const payload = await completarLogin(empleado, req, res, entry.rememberMe ?? false);
      if (viaBackup) payload.backupCodesRestantes = backupCodesRestantes;
      res.json(payload);
    } catch (e) {
      console.error('[2FA ERROR]', { message: e.message, stack: e.stack });
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.' });
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  router.get('/auth/2fa/setup', verificarJWT, async (req, res) => {
    try {
      const secret     = authenticator.generateSecret();
      const encrypted  = encryptTOTP(secret);
      const otpauthUrl = authenticator.keyuri(req.user.nombre, 'ACR Networks ERP', secret);
      const qrCode     = await QRCode.toDataURL(otpauthUrl);
      await prisma.empleado.update({ where: { id: req.user.sub }, data: { twoFactorSecret: encrypted } });
      res.json({ qrCode, secret });
    } catch (e) { console.error('[2fa/setup]', e); res.status(500).json({ error: 'Error generando 2FA.' }); }
  });

  router.post('/auth/2fa/enable', verificarJWT, async (req, res) => {
    try {
      const { totp } = z.object({ totp: z.string().length(6) }).parse(req.body);
      const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorSecret: true, twoFactorEnabled: true } });
      if (!emp?.twoFactorSecret) return res.status(400).json({ error: 'Genera el QR primero.' });
      if (emp.twoFactorEnabled) return res.status(400).json({ error: '2FA ya está activo.' });
      const secret = decryptTOTP(emp.twoFactorSecret);
      if (!authenticator.verify({ token: totp, secret })) return res.status(401).json({ error: 'PIN inválido.' });
      const plain  = generarBackupCodes();
      const hashed = await hashBackupCodes(plain);
      await prisma.empleado.update({
        where: { id: req.user.sub },
        data:  { twoFactorEnabled: true, backupCodes: hashed },
      });
      auditReq('auth:2fa_enabled', req, { backupCodesGenerados: plain.length });
      res.status(201).json({ backupCodes: plain, count: plain.length });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'PIN de 6 dígitos requerido.' });
      console.error('[2fa/enable]', e.message);
      res.status(500).json({ error: 'Error al activar 2FA.' });
    }
  });

  router.post('/auth/2fa/backup-codes/regenerate', verificarJWT, async (req, res) => {
    try {
      const { totp } = z.object({ totp: z.string().length(6) }).parse(req.body);
      const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorSecret: true, twoFactorEnabled: true } });
      if (!emp?.twoFactorEnabled) return res.status(400).json({ error: '2FA no está activo.' });
      const secret = decryptTOTP(emp.twoFactorSecret);
      if (!authenticator.verify({ token: totp, secret })) return res.status(401).json({ error: 'PIN inválido.' });
      const plain  = generarBackupCodes();
      const hashed = await hashBackupCodes(plain);
      await prisma.empleado.update({ where: { id: req.user.sub }, data: { backupCodes: hashed } });
      auditReq('auth:2fa_backup_regen', req);
      res.json({ backupCodes: plain, count: plain.length });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'PIN requerido.' });
      res.status(500).json({ error: 'Error.' });
    }
  });

  router.get('/auth/2fa/backup-codes/count', verificarJWT, async (req, res) => {
    try {
      const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { backupCodes: true } });
      const codes = Array.isArray(emp?.backupCodes) ? emp.backupCodes : [];
      res.json({ count: codes.length });
    } catch { res.status(500).json({ error: 'Error.' }); }
  });

  router.post('/auth/2fa/disable', verificarJWT, async (req, res) => {
    try {
      const { totp } = z.object({ totp: z.string().length(6) }).parse(req.body);
      const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorSecret: true, twoFactorEnabled: true } });
      if (!emp?.twoFactorEnabled) return res.status(400).json({ error: '2FA no está activo.' });
      const secret = decryptTOTP(emp.twoFactorSecret);
      if (!authenticator.verify({ token: totp, secret })) return res.status(401).json({ error: 'PIN inválido.' });
      await prisma.empleado.update({ where: { id: req.user.sub }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
      auditReq('auth:2fa_disabled', req);
      res.status(204).end();
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: 'PIN de 6 dígitos requerido.' });
      res.status(500).json({ error: 'Error al desactivar 2FA.' });
    }
  });

  // ─── WebAuthn / Passkeys ──────────────────────────────────────────────────
  let _webauthn = null;
  try { _webauthn = require('@simplewebauthn/server'); }
  catch { console.warn('[WEBAUTHN] @simplewebauthn/server no instalado.'); }

  const RP_NAME   = process.env.WEBAUTHN_RP_NAME ?? 'ACR Networks ERP';
  const RP_ID     = process.env.WEBAUTHN_RP_ID ?? (process.env.PUBLIC_FRONTEND_URL ? new URL(process.env.PUBLIC_FRONTEND_URL).hostname : 'localhost');
  const RP_ORIGIN = process.env.WEBAUTHN_ORIGIN ?? process.env.PUBLIC_FRONTEND_URL ?? 'http://localhost:5173';

  const _webauthnChallengeStore = new Map();
  const WEBAUTHN_CHALLENGE_TTL_MS = 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _webauthnChallengeStore.entries()) if (v.exp < now) _webauthnChallengeStore.delete(k);
  }, 60_000).unref();

  function _wa503() { return { status: 503, error: 'WebAuthn no instalado. Ejecuta `npm install` en backend.' }; }

  router.post('/auth/webauthn/register/options', verificarJWT, async (req, res) => {
    if (!_webauthn) { const e = _wa503(); return res.status(e.status).json({ error: e.error }); }
    try {
      const emp = await prisma.empleado.findUnique({
        where: { id: req.user.sub },
        include: { webauthnCredentials: { select: { credentialId: true, transports: true } } },
      });
      if (!emp) return res.status(404).json({ error: 'Empleado no encontrado.' });
      const options = await _webauthn.generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID,
        userName: emp.email, userDisplayName: emp.nombre,
        userID: Buffer.from(String(emp.id)),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: emp.webauthnCredentials.map(c => ({ id: c.credentialId, transports: c.transports })),
      });
      _webauthnChallengeStore.set(`reg:${emp.id}`, { challenge: options.challenge, exp: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
      res.json(options);
    } catch (e) {
      console.error('[WEBAUTHN reg/options]', e.message);
      res.status(500).json({ error: 'Error generando opciones.' });
    }
  });

  router.post('/auth/webauthn/register/verify', verificarJWT, async (req, res) => {
    if (!_webauthn) { const e = _wa503(); return res.status(e.status).json({ error: e.error }); }
    try {
      const { deviceName } = z.object({ deviceName: z.string().min(2).max(60).optional() }).parse({ deviceName: req.body?.deviceName });
      const stored = _webauthnChallengeStore.get(`reg:${req.user.sub}`);
      if (!stored || stored.exp < Date.now()) return res.status(400).json({ error: 'Challenge expirado. Reintenta.' });
      _webauthnChallengeStore.delete(`reg:${req.user.sub}`);

      const verification = await _webauthn.verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin:    RP_ORIGIN,
        expectedRPID:      RP_ID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(401).json({ error: 'Verificación WebAuthn falló.' });
      }
      const { credential, credentialBackedUp } = verification.registrationInfo;
      await prisma.webAuthnCredential.create({
        data: {
          empleadoId:     req.user.sub,
          credentialId:   credential.id,
          publicKey:      Buffer.from(credential.publicKey).toString('base64url'),
          counter:        BigInt(credential.counter ?? 0),
          transports:     credential.transports ?? [],
          deviceName:     deviceName ?? null,
          backupEligible: !!credentialBackedUp,
        },
      });
      auditReq('auth:webauthn_registered', req, { deviceName, backupEligible: !!credentialBackedUp });
      res.status(201).json({ ok: true, deviceName: deviceName ?? null });
    } catch (e) {
      console.error('[WEBAUTHN reg/verify]', e.message);
      res.status(500).json({ error: 'Error verificando registro.' });
    }
  });

  router.post('/auth/webauthn/login/options', loginLimiter, async (req, res) => {
    if (!_webauthn) { const e = _wa503(); return res.status(e.status).json({ error: e.error }); }
    try {
      const { email } = z.object({ email: z.string().email().optional() }).parse(req.body ?? {});
      let allowCredentials = [];
      let empleadoId = null;
      if (email) {
        const emp = await prisma.empleado.findUnique({
          where:   { email },
          include: { webauthnCredentials: { select: { credentialId: true, transports: true } } },
        });
        if (emp) {
          empleadoId = emp.id;
          allowCredentials = emp.webauthnCredentials.map(c => ({ id: c.credentialId, transports: c.transports }));
        }
      }
      const options = await _webauthn.generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials,
        userVerification: 'required',
      });
      const sessionKey = `auth:${crypto.randomUUID()}`;
      _webauthnChallengeStore.set(sessionKey, { challenge: options.challenge, empleadoId, exp: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
      res.json({ ...options, sessionKey });
    } catch (e) {
      console.error('[WEBAUTHN auth/options]', e.message);
      res.status(500).json({ error: 'Error generando opciones.' });
    }
  });

  router.post('/auth/webauthn/login/verify', loginLimiter, async (req, res) => {
    if (!_webauthn) { const e = _wa503(); return res.status(e.status).json({ error: e.error }); }
    try {
      const { sessionKey, rememberMe } = z.object({
        sessionKey: z.string().min(1),
        rememberMe: z.boolean().optional().default(false),
      }).parse({ sessionKey: req.body?.sessionKey, rememberMe: req.body?.rememberMe });

      const stored = _webauthnChallengeStore.get(sessionKey);
      if (!stored || stored.exp < Date.now()) return res.status(400).json({ error: 'Challenge expirado.' });
      _webauthnChallengeStore.delete(sessionKey);

      const credentialId = req.body?.id;
      const cred = await prisma.webAuthnCredential.findUnique({
        where:   { credentialId },
        include: { empleado: { include: { roles: { where: { activo: true } } } } },
      });
      if (!cred) return res.status(404).json({ error: 'Credencial no reconocida.' });
      if (stored.empleadoId && stored.empleadoId !== cred.empleadoId) {
        return res.status(401).json({ error: 'Credencial no asociada a este usuario.' });
      }

      const verification = await _webauthn.verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin:    RP_ORIGIN,
        expectedRPID:      RP_ID,
        credential: {
          id:        cred.credentialId,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter:   Number(cred.counter),
          transports:cred.transports,
        },
        requireUserVerification: true,
      });
      if (!verification.verified) {
        auditReq('auth:webauthn_fail', req, { empleadoId: cred.empleadoId });
        return res.status(401).json({ error: 'Assertion falló verificación.' });
      }
      const newCounter = BigInt(verification.authenticationInfo.newCounter ?? 0);
      if (cred.counter > 0n && newCounter <= cred.counter) {
        auditReq('auth:webauthn_replay_suspect', req, { empleadoId: cred.empleadoId, oldCounter: String(cred.counter), newCounter: String(newCounter) });
        return res.status(401).json({ error: 'Counter regresivo — posible clon de credencial.' });
      }
      await prisma.webAuthnCredential.update({
        where: { id: cred.id },
        data:  { counter: newCounter, lastUsedAt: new Date() },
      });
      auditReq('auth:login_success', req, { via: 'webauthn' }, { userId: cred.empleadoId, userName: cred.empleado.nombre });
      const payload = await completarLogin(cred.empleado, req, res, rememberMe);
      res.json(payload);
    } catch (e) {
      console.error('[WEBAUTHN auth/verify]', e.message);
      res.status(500).json({ error: 'Error verificando login.' });
    }
  });

  router.get('/auth/webauthn/credentials', verificarJWT, async (req, res) => {
    try {
      const creds = await prisma.webAuthnCredential.findMany({
        where:  { empleadoId: req.user.sub },
        select: { id: true, deviceName: true, transports: true, backupEligible: true, createdAt: true, lastUsedAt: true },
        orderBy:{ createdAt: 'desc' },
      });
      res.json({ data: creds, count: creds.length });
    } catch { res.status(500).json({ error: 'Error.' }); }
  });

  router.delete('/auth/webauthn/credentials/:id', verificarJWT, async (req, res) => {
    try {
      const r = await prisma.webAuthnCredential.deleteMany({
        where: { id: req.params.id, empleadoId: req.user.sub },
      });
      if (r.count === 0) return res.status(404).json({ error: 'Credencial no encontrada.' });
      auditReq('auth:webauthn_revoked', req, { credentialId: req.params.id });
      res.status(204).end();
    } catch { res.status(500).json({ error: 'Error.' }); }
  });

  router.patch('/auth/me/password', verificarJWT, async (req, res) => {
    try {
      const { currentPassword, newPassword } = z.object({
        currentPassword: z.string().min(1, 'Contraseña actual requerida.'),
        newPassword: passwordSchema,
      }).parse(req.body);
      const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { passwordHash: true } });
      if (!emp) return res.status(404).json({ error: 'Usuario no encontrado.' });
      const valid = await bcrypt.compare(currentPassword, emp.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta.' });
      const newHash = await bcrypt.hash(newPassword, 12);
      await prisma.$transaction([
        prisma.empleado.update({ where: { id: req.user.sub }, data: { passwordHash: newHash } }),
        prisma.sessionToken.deleteMany({ where: { empleadoId: req.user.sub, NOT: { jti: req.user.jti } } }),
      ]);
      auditReq('auth:self_password_change', req);
      res.status(204).end();
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors[0]?.message ?? 'Datos inválidos.' });
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  router.get('/auth/me/sessions', verificarJWT, async (req, res) => {
    try {
      const sessions = await prisma.sessionToken.findMany({
        where: { empleadoId: req.user.sub, expiresAt: { gt: new Date() } },
        select: { jti: true, userAgent: true, createdAt: true, expiresAt: true, ip: true },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ data: sessions, current: req.user.jti });
    } catch { res.status(500).json({ error: 'Error obteniendo sesiones.' }); }
  });

  router.delete('/auth/me/sessions/:jti', verificarJWT, async (req, res) => {
    const { jti } = req.params;
    if (!jti) return res.status(400).json({ error: 'JTI requerido.' });
    try {
      const session = await prisma.sessionToken.findUnique({ where: { jti } });
      if (!session || session.empleadoId !== req.user.sub) return res.status(404).json({ error: 'Sesión no encontrada.' });
      await prisma.sessionToken.delete({ where: { jti } });
      auditReq('auth:session_revoked', req, { jti });
      res.status(204).end();
    } catch { res.status(500).json({ error: 'Error cerrando sesión.' }); }
  });

  router.delete('/auth/me/sessions', verificarJWT, async (req, res) => {
    try {
      const r = await prisma.sessionToken.deleteMany({
        where: { empleadoId: req.user.sub, jti: { not: req.user.jti } },
      });
      auditReq('auth:sessions_revoked_bulk', req, { count: r.count });
      res.json({ ok: true, count: r.count });
    } catch { res.status(500).json({ error: 'Error cerrando sesiones.' }); }
  });

  return router;
}

module.exports = createAuthRouter;
