/**
 * backend/modules/crm/portal-b2c/controller.js
 *
 * Capa HTTP del Portal B2C. Thin handlers + Zod + _wrap.
 *
 * Factory: createPortalController({ service, schemas })
 */

const { z } = require('zod');
const { PortalError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _applyDescriptor(res, d) {
  if (d?.cookies?.clear) { for (const n of d.cookies.clear) res.clearCookie(n); }
  if (d?.cookies?.set)   { for (const c of d.cookies.set) res.cookie(c.name, c.value, c.opts); }
  if (d?.headers) for (const [k, v] of Object.entries(d.headers)) res.setHeader(k, v);
  const status = d?.status ?? 200;
  if (d?.stream) {
    res.setHeader('Content-Type', d.stream.contentType);
    if (d.stream.disposition) res.setHeader('Content-Disposition', d.stream.disposition);
    res.setHeader('Content-Length', d.stream.buffer.length);
    return res.status(status).end(d.stream.buffer);
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
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof PortalError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[PORTAL CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createPortalController({ service, schemas }) {
  if (!service) throw new Error('createPortalController: service required');
  if (!schemas) throw new Error('createPortalController: schemas required');
  const {
    portalRegisterSchema, portalLoginSchema, settingsSchema,
    forgotSchema, resetSchema, sosSchema,
    portalCotizacionSchema, checkoutSchema, azulWebhookSchema,
    portalCatalogQuerySchema,
  } = schemas;

  const csrf = _wrap(async (req) => service.getOrIssueCsrf(req.cookies?.['pct-csrf']));

  const listCatalogPortal = _wrap(async (req) => {
    const q = portalCatalogQuerySchema.parse(req.query);
    return service.listCatalogPortal(q);
  });

  const getSettings    = _wrap(async () => service.getSettings());
  const putSettings    = _wrap(async (req) => {
    const dto = settingsSchema.parse(req.body);
    return service.updateSettings(dto, req.user, _extractReqMeta(req));
  });

  const register = _wrap(async (req) => {
    const dto = portalRegisterSchema.parse(req.body);
    return service.register(dto, _extractReqMeta(req));
  });

  const login = _wrap(async (req) => {
    const dto = portalLoginSchema.parse(req.body);
    return service.login(dto, _extractReqMeta(req));
  });

  const logout = _wrap(async () => service.logout());

  const me = _wrap(async (req) => service.getMe(req.portalUser));

  const forgot = _wrap(async (req) => {
    const dto = forgotSchema.parse(req.body);
    return service.forgotPassword(dto, _extractReqMeta(req));
  });

  const reset = _wrap(async (req) => {
    const dto = resetSchema.parse(req.body);
    return service.resetPassword(dto, _extractReqMeta(req));
  });

  const sos = _wrap(async (req) => {
    const dto = sosSchema.parse(req.body ?? {});
    return service.crearSosTicket(dto, req.portalUser, _extractReqMeta(req));
  });

  const cotizacionPortal = _wrap(async (req) => {
    const dto = portalCotizacionSchema.parse(req.body);
    return service.crearCotizacionPortal(dto, req.portalUser, _extractReqMeta(req));
  });

  const listCotizacionesPortal = _wrap(async (req) => service.listarCotizacionesPortal(req.portalUser));

  const dashboard = _wrap(async (req) => service.getDashboard(req.portalUser));

  const facturaPdfPortal = _wrap(async (req) => service.getFacturaPdfPortal(req.params.id, req.portalUser));

  const checkout = _wrap(async (req) => {
    const dto = checkoutSchema.parse(req.body);
    return service.checkout(dto, req.portalUser, _extractReqMeta(req), req.body);
  });

  /**
   * Webhook Azul: el express.raw middleware ya garantiza req.body es un Buffer.
   * Validamos firma + parseamos JSON dentro del service. Sin Zod-on-body porque
   * Buffer no es JSON. El service hace JSON.parse + zod validation interna.
   */
  const webhookAzul = async (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      let payload;
      try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        payload = azulWebhookSchema.parse(parsed);
      } catch (e) {
        if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues?.[0]?.message ?? 'Payload inválido.' });
        return res.status(400).json({ error: 'Payload inválido.' });
      }
      const d = await service.procesarWebhookAzul(
        { rawBody, firma: req.headers['x-azul-signature'] },
        payload,
        _extractReqMeta(req),
        { prisma: req.app.locals.prisma },
      );
      _applyDescriptor(res, d);
    } catch (err) {
      if (err instanceof PortalError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[WEBHOOK AZUL CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };

  return {
    csrf, listCatalogPortal,
    getSettings, putSettings,
    register, login, logout, me,
    forgot, reset, sos,
    cotizacionPortal, listCotizacionesPortal, dashboard, facturaPdfPortal,
    checkout, webhookAzul,
  };
}

module.exports = createPortalController;
