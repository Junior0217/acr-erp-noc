/**
 * backend/modules/auth/controller.js
 *
 * Capa de transporte HTTP. NO toca Prisma, NO compone lógica, NO calcula.
 * Responsabilidades únicas:
 *   1. Validar req.body / params via schemas.
 *   2. Extraer "reqMeta" (IP/UA/Accept-Language) sin acoplar al service.
 *   3. Llamar al service correspondiente.
 *   4. Aplicar el descriptor `{ status, body, cookies }` sobre res.
 *   5. Mapear errores (Zod + AuthError + Error genérico) a respuestas HTTP.
 *
 * Factory: createAuthController({ service, schemas })
 */

const { z } = require('zod');
const { AuthError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip:           req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua:           req.headers?.['user-agent']      ?? '',
    acceptLang:   req.headers?.['accept-language'] ?? '',
    secChUa:      req.headers?.['sec-ch-ua']       ?? '',
  };
}

function _applyDescriptor(res, descriptor) {
  if (descriptor?.cookies?.clear) {
    for (const name of descriptor.cookies.clear) res.clearCookie(name);
  }
  if (descriptor?.cookies?.set) {
    for (const c of descriptor.cookies.set) res.cookie(c.name, c.value, c.opts);
  }
  const status = descriptor?.status ?? 200;
  if (descriptor?.body == null && (status === 204 || status === 205)) {
    return res.status(status).end();
  }
  return res.status(status).json(descriptor?.body ?? {});
}

/**
 * Wrap async handlers para que cualquier throw o rejection caiga al catch
 * común. Permite que el service haga `throw new AuthError(...)` sin que cada
 * controlador repita try/catch — única fuente de error mapping.
 */
function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const descriptor = await fn(req, res);
      if (!res.headersSent) _applyDescriptor(res, descriptor);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof AuthError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      console.error('[AUTH CONTROLLER]', err.message, err.stack);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createAuthController({ service, schemas }) {
  if (!service) throw new Error('createAuthController: service is required');
  if (!schemas) throw new Error('createAuthController: schemas is required');
  const {
    loginSchema, twoFAVerifySchema, totpSixDigitSchema, passwordChangeSchema,
    webauthnRegisterVerifySchema, webauthnLoginOptionsSchema, webauthnLoginVerifySchema,
  } = schemas;

  const getChallenge = _wrap(async () => service.getChallenge());

  const login = _wrap(async (req) => {
    const dto     = loginSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.login(dto, reqMeta);
  });

  const getMe        = _wrap(async (req) => service.getMe(req.user));
  const permissions  = _wrap(async ()   => service.getPermissionsMap());

  const csrf = _wrap(async (req) => service.getOrIssueCsrf(req.cookies?.csrf));

  const logout = _wrap(async (req) => {
    const reqMeta = _extractReqMeta(req);
    return service.logout(req.user, reqMeta);
  });

  const refresh = _wrap(async (req) => {
    const reqMeta = _extractReqMeta(req);
    return service.refresh(req.signedCookies?.token, reqMeta);
  });

  const verifyTwoFA = _wrap(async (req) => {
    const dto     = twoFAVerifySchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.verifyTwoFA(dto, reqMeta);
  });

  const setupTwoFA = _wrap(async (req) => service.setupTwoFA(req.user));

  const enableTwoFA = _wrap(async (req) => {
    const dto     = totpSixDigitSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.enableTwoFA(req.user, dto, reqMeta);
  });

  const disableTwoFA = _wrap(async (req) => {
    const dto     = totpSixDigitSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.disableTwoFA(req.user, dto, reqMeta);
  });

  const regenerateBackupCodes = _wrap(async (req) => {
    const dto     = totpSixDigitSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.regenerateBackupCodes(req.user, dto, reqMeta);
  });

  const countBackupCodes = _wrap(async (req) => service.countBackupCodes(req.user));

  const changePassword = _wrap(async (req) => {
    const dto     = passwordChangeSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.changeOwnPassword(req.user, dto, reqMeta);
  });

  const listSessions   = _wrap(async (req) => service.listMySessions(req.user));
  const revokeSession  = _wrap(async (req) => {
    const reqMeta = _extractReqMeta(req);
    return service.revokeMySession(req.user, req.params.jti, reqMeta);
  });
  const revokeAllOther = _wrap(async (req) => {
    const reqMeta = _extractReqMeta(req);
    return service.revokeAllMyOtherSessions(req.user, reqMeta);
  });

  // ─── WebAuthn handlers ────────────────────────────────────────────────────
  const webauthnRegOptions = _wrap(async (req) => service.webauthnRegisterOptions(req.user));

  const webauthnRegVerify  = _wrap(async (req) => {
    const { deviceName } = webauthnRegisterVerifySchema.parse({ deviceName: req.body?.deviceName });
    const reqMeta = _extractReqMeta(req);
    return service.webauthnRegisterVerify(req.user, req.body, deviceName, reqMeta);
  });

  const webauthnLoginOpts  = _wrap(async (req) => {
    const dto = webauthnLoginOptionsSchema.parse(req.body ?? {});
    return service.webauthnLoginOptions(dto);
  });

  const webauthnLoginVerify = _wrap(async (req) => {
    const partial = webauthnLoginVerifySchema.parse({
      sessionKey: req.body?.sessionKey,
      rememberMe: req.body?.rememberMe,
    });
    const reqMeta = _extractReqMeta(req);
    return service.webauthnLoginVerify({ ...partial, id: req.body?.id, ...req.body }, reqMeta);
  });

  const listCredentials   = _wrap(async (req) => service.listWebauthnCredentials(req.user));
  const deleteCredential  = _wrap(async (req) => {
    const reqMeta = _extractReqMeta(req);
    return service.deleteWebauthnCredential(req.user, req.params.id, reqMeta);
  });

  return {
    getChallenge,
    login,
    getMe,
    permissions,
    csrf,
    logout,
    refresh,
    verifyTwoFA,
    setupTwoFA,
    enableTwoFA,
    disableTwoFA,
    regenerateBackupCodes,
    countBackupCodes,
    changePassword,
    listSessions,
    revokeSession,
    revokeAllOther,
    webauthnRegOptions,
    webauthnRegVerify,
    webauthnLoginOpts,
    webauthnLoginVerify,
    listCredentials,
    deleteCredential,
  };
}

module.exports = createAuthController;
