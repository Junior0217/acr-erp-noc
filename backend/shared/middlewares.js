/**
 * backend/shared/middlewares.js
 *
 * Factory de middlewares reusables (auth, perms, CSRF, TOTP estricto, etc.).
 *
 * Recibe deps inyectadas (prisma, auditReq, jwt-crypto wrappers, stores).
 * Devuelve un objeto con todos los middlewares listos para usar tanto en
 * server.js como en routers de backend/routes/.
 *
 * Diseño:
 * - SIN imports directos a prisma → evita ciclos (prisma sigue siendo
 *   instanciado una sola vez en server.js).
 * - Estado in-memory (cooldowns vault, etc.) se pasa por deps para
 *   mantener una sola instancia compartida entre server.js y routers.
 */

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const { wrapJWT, unwrapJWT, decryptTOTP, PORTAL_JWT_SECRET } = require('./jwt-crypto');
const { rlsContext } = require('./rls-context');

const NIVEL_PROPIETARIO_ABSOLUTO = 100;

// ─── Cache in-memory de sessionToken (Cyber Neo + Rendimiento) ───────────────
// La validación JWT cripto-segura ya verifica firma + expiración del payload.
// El lookup `prisma.sessionToken.findUnique({ jti })` solo necesita correr para
// detectar invalidaciones administrativas (force logout / device wipe) y
// expiraciones server-side. Esos eventos son MUY infrecuentes — en ráfagas
// típicas de UI (5-10 clicks/segundo del cajero en el POS) la BD recibe 5-10
// findUnique idénticos por segundo, consumiendo pool de Supabase sin razón.
//
// Cache: Map<jti, { until: number }>. TTL hard de 30 segundos. Si un JTI ya
// pasó la validación contra BD en los últimos 30s, se skipea el findUnique.
// Ventana de invalidación máxima = 30s (aceptable para force-logout — el
// usuario admin que lo dispara ya sabe que no es instantáneo).
//
// Cleanup: setInterval cada 60s purga entradas vencidas. La estructura es
// process-local (ningún cross-pod sync), lo que está OK porque la pérdida de
// la cache al reiniciar un pod solo provoca 1 findUnique extra por sesión
// activa — costo despreciable.
const sessionTokenCache = new Map();
const SESSION_CACHE_TTL_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const [jti, entry] of sessionTokenCache) {
    if (entry.until <= now) sessionTokenCache.delete(jti);
  }
}, 60_000).unref();

/**
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma
 * @param {(evento: string, req: object, meta?: object, overrides?: object) => void} deps.auditReq
 * @param {Map<string, number>} [deps.vaultLastReveal]   - userId -> ms timestamp
 * @param {number} [deps.vaultCooldownMs]
 */
function createMiddlewares(deps) {
  const { prisma, auditReq } = deps;
  if (!prisma)   throw new Error('createMiddlewares: prisma is required');
  if (!auditReq) throw new Error('createMiddlewares: auditReq is required');

  const vaultLastReveal = deps.vaultLastReveal ?? new Map();
  const VAULT_COOLDOWN_MS = deps.vaultCooldownMs ?? 30_000;

  // ─── Admin JWT ─────────────────────────────────────────────────────────────
  async function verificarJWT(req, res, next) {
    const wrapped = req.signedCookies?.token;
    if (!wrapped) return res.status(401).json({ error: 'No autenticado.' });
    try {
      const jwtStr  = unwrapJWT(wrapped);
      const payload = jwt.verify(jwtStr, process.env.JWT_SECRET);
      const ua      = req.headers['user-agent'] || '';
      if (payload.ua != null && payload.ua !== ua) {
        auditReq('session:ua_mismatch', req, { jti: payload.jti }, { userId: payload.sub });
        sessionTokenCache.delete(payload.jti);
        await prisma.sessionToken.deleteMany({ where: { jti: payload.jti } });
        res.clearCookie('token');
        return res.status(401).json({ error: 'Sesión inválida.' });
      }
      // Skip findUnique si el JTI fue validado contra BD en los últimos 30s.
      // Sliding refresh (líneas abajo) hace su propio updateMany — esa rama
      // está cubierta de igual forma porque el JWT ya viene fresh entonces.
      const cached = sessionTokenCache.get(payload.jti);
      if (!cached || cached.until <= Date.now()) {
        const session = await prisma.sessionToken.findUnique({ where: { jti: payload.jti } });
        if (!session || session.expiresAt < new Date()) {
          // Invalida cache por si quedó stale.
          sessionTokenCache.delete(payload.jti);
          res.clearCookie('token');
          res.clearCookie('csrf');
          return res.status(401).json({ error: 'Sesión expirada.', code: 'SESSION_EXPIRED' });
        }
        sessionTokenCache.set(payload.jti, { until: Date.now() + SESSION_CACHE_TTL_MS });
      }
      req.user = payload;

      // Sliding refresh (CAS atómico vía updateMany con WHERE condicional)
      const nowSec    = Math.floor(Date.now() / 1000);
      const remaining = (payload.exp ?? 0) - nowSec;
      if (remaining > 0 && remaining < 900) {
        const newExpAt = new Date(Date.now() + 30 * 60 * 1000);
        const result = await prisma.sessionToken.updateMany({
          where: { jti: payload.jti, expiresAt: { lt: newExpAt } },
          data:  { expiresAt: newExpAt },
        });
        if (result.count > 0) {
          const newJwt = jwt.sign(
            { sub: payload.sub, nombre: payload.nombre, permisos: payload.permisos, jti: payload.jti, ua: payload.ua, ...(payload.needs2FASetup ? { needs2FASetup: true } : {}) },
            process.env.JWT_SECRET,
            { expiresIn: '30m' }
          );
          const newToken = wrapJWT(newJwt);
          const isProd   = process.env.NODE_ENV === 'production';
          const cookieOpts = {
            httpOnly: true, signed: true,
            secure:   isProd,
            sameSite: isProd ? 'none' : 'lax',
            maxAge:   30 * 60 * 1000,
            ...(isProd ? { partitioned: true } : {}),
          };
          res.cookie('token', newToken, cookieOpts);

          const csrfActual = req.cookies?.csrf || crypto.randomBytes(32).toString('hex');
          res.cookie('csrf', csrfActual, { ...cookieOpts, httpOnly: false, signed: false });
        }
      }

      // L1.1 RLS — Monta AsyncLocalStorage con el userId del JWT verificado.
      // Cualquier handler aguas abajo que use `prisma.withCurrentUserRls(fn)`
      // toma el userId desde aquí sin pasarlo explícitamente. Si el storage
      // ya estaba activo (handler anidado, test wrapper), `.run` crea un nuevo
      // scope shadow que se desmonta al finalizar `next()`.
      const uid = Number(payload.sub);
      if (Number.isInteger(uid) && uid > 0) {
        return rlsContext.run({ userId: uid }, () => next());
      }
      next();
    } catch {
      res.clearCookie('token');
      res.clearCookie('csrf');
      res.status(401).json({ error: 'Token inválido.' });
    }
  }

  // ─── Portal JWT ────────────────────────────────────────────────────────────
  async function verificarPortalJWT(req, res, next) {
    const raw = req.cookies?.pct;
    if (!raw) return res.status(401).json({ error: 'No autenticado.' });
    try {
      const payload = jwt.verify(raw, PORTAL_JWT_SECRET);
      if (payload.type !== 'portal') throw new Error('wrong type');
      req.portalUser = payload;
      next();
    } catch {
      res.clearCookie('pct');
      res.status(401).json({ error: 'Sesión expirada.' });
    }
  }

  // ─── Permisos ──────────────────────────────────────────────────────────────
  function requerirPermiso(permiso) {
    return (req, res, next) => {
      const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : [];
      if (permisos.includes('sistema:owner')) return next();
      if (!permisos.includes(permiso)) return res.status(403).json({ error: 'Sin permiso para esta acción.' });
      next();
    };
  }

  async function esPropietarioAbsoluto(userId) {
    if (!userId) return false;
    try {
      const roles = await prisma.rol.findMany({
        where:  { activo: true, empleados: { some: { id: userId } } },
        select: { nivel: true },
      });
      const max = roles.reduce((m, r) => Math.max(m, r.nivel ?? 0), 0);
      return max >= NIVEL_PROPIETARIO_ABSOLUTO;
    } catch { return false; }
  }

  function requerirNivel(min = NIVEL_PROPIETARIO_ABSOLUTO) {
    return async (req, res, next) => {
      const ok = await esPropietarioAbsoluto(req.user?.sub);
      if (!ok) return res.status(403).json({ error: `Acción reservada a rol nivel ${min}+ (Propietario Absoluto).` });
      next();
    };
  }

  async function protegerPropietario(req, res, next) {
    const targetId = parseInt(req.params.id ?? req.params.empleadoId);
    if (!targetId) return next();
    if (req.user?.permisos?.includes('sistema:owner')) return next();
    try {
      const [callerRoles, targetEmp] = await Promise.all([
        prisma.rol.findMany({
          where: { empleados: { some: { id: req.user.sub } }, activo: true },
          select: { nivel: true },
        }),
        prisma.empleado.findUnique({
          where: { id: targetId },
          include: { roles: { where: { activo: true }, select: { nivel: true } } },
        }),
      ]);
      if (!targetEmp) return next();
      const callerNivel = callerRoles.length ? Math.max(...callerRoles.map(r => r.nivel ?? 0)) : 0;
      const targetNivel = targetEmp.roles.length ? Math.max(...targetEmp.roles.map(r => r.nivel ?? 0)) : 0;
      if (callerNivel <= targetNivel) {
        return res.status(403).json({ error: `Sin autorización: tu nivel (${callerNivel}) no supera el nivel del objetivo (${targetNivel}).` });
      }
      next();
    } catch { next(); }
  }

  // ─── TOTP ──────────────────────────────────────────────────────────────────
  async function requerirTOTPEstricto(req, res, next) {
    try {
      const emp = await prisma.empleado.findUnique({ where: { id: req.user.sub }, select: { twoFactorEnabled: true, twoFactorSecret: true } });
      if (!emp?.twoFactorEnabled || !emp?.twoFactorSecret) {
        return res.status(422).json({ error: 'Activa 2FA primero. La bóveda PAM exige TOTP en cada revelación.', code: 'TOTP_NOT_CONFIGURED' });
      }
      const code = req.headers['x-totp'] || req.body?.totp;
      if (!code) return res.status(403).json({ error: 'Código TOTP requerido en header X-TOTP.', code: 'TOTP_REQUIRED' });
      const secret = decryptTOTP(emp.twoFactorSecret);
      if (!authenticator.verify({ token: String(code), secret })) {
        auditReq('vault:totp_invalid', req, { credencialId: req.params.id }, { userId: req.user.sub });
        return res.status(401).json({ error: 'Código TOTP inválido o expirado.', code: 'TOTP_INVALID' });
      }
      next();
    } catch (e) {
      console.error('[TOTP ESTRICTO]', e.message);
      res.status(500).json({ error: 'Error verificando 2FA.' });
    }
  }

  // Cooldown guard para revelaciones consecutivas del vault PAM
  function vaultCooldownGuard(req, res, next) {
    const uid  = req.user.sub;
    const now  = Date.now();
    const last = vaultLastReveal.get(uid) ?? 0;
    const wait = VAULT_COOLDOWN_MS - (now - last);
    if (wait > 0) {
      return res.status(429).json({
        error:        `Cool-down activo. Espera ${Math.ceil(wait / 1000)}s antes de otra revelación.`,
        code:         'VAULT_COOLDOWN',
        retryAfterMs: wait,
      });
    }
    next();
  }

  // Basic TOTP guard (no-op si user no tiene 2FA activo). Usado por endpoints
  // destructivos (delete empleado, etc.) — más laxo que requerirTOTPEstricto del vault.
  async function requerirTOTP(req, res, next) {
    try {
      const emp = await prisma.empleado.findUnique({
        where: { id: req.user.sub },
        select: { twoFactorEnabled: true, twoFactorSecret: true },
      });
      if (!emp?.twoFactorEnabled) return next();   // sin 2FA -> permite
      const code = req.headers['x-totp'] || req.body?.totp;
      if (!code) return res.status(403).json({ error: 'Esta acción destructiva requiere tu código TOTP de 2FA.' });
      const secret = decryptTOTP(emp.twoFactorSecret);
      if (!authenticator.verify({ token: String(code), secret })) {
        return res.status(401).json({ error: 'Código TOTP inválido o expirado.' });
      }
      next();
    } catch { next(); }
  }

  return {
    NIVEL_PROPIETARIO_ABSOLUTO,
    verificarJWT,
    verificarPortalJWT,
    requerirPermiso,
    requerirNivel,
    esPropietarioAbsoluto,
    protegerPropietario,
    requerirTOTP,
    requerirTOTPEstricto,
    vaultCooldownGuard,
    vaultLastReveal,
    invalidarSessionCache,
  };
}

// Invalida una entrada del cache de sessionToken. Llamar desde authService al
// hacer logout / force-revoke / device-wipe — garantiza que el próximo request
// con ese jti hace findUnique fresco contra BD en vez de honrar TTL stale.
function invalidarSessionCache(jti) {
  if (!jti) return false;
  return sessionTokenCache.delete(jti);
}

module.exports = createMiddlewares;
module.exports.NIVEL_PROPIETARIO_ABSOLUTO = NIVEL_PROPIETARIO_ABSOLUTO;
module.exports.invalidarSessionCache = invalidarSessionCache;
