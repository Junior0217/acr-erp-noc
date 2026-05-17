/**
 * backend/modules/crm/credenciales/controller.js
 *
 * Capa HTTP del Vault. Thin handlers + Zod + _wrap. Cyber Neo:
 *   - NUNCA log de req.body en errores (password leak).
 *   - VaultError → status estable + code, sin extra info en stack.
 *   - res.json({ password }) en reveal — sin metadata adicional para
 *     reducir superficie de log accidental del SDK frontend.
 */

const { z } = require('zod');
const { VaultError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _applyDescriptor(res, d) {
  const status = d?.status ?? 200;
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
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof VaultError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      // CYBER NEO: log SIN req.body (password leak). Solo método + path + msg.
      console.error('[VAULT CTRL]', req.method, req.path, err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createCredencialesController({ service, schemas, helpers }) {
  if (!service) throw new Error('createCredencialesController: service required');
  if (!schemas) throw new Error('createCredencialesController: schemas required');
  if (!helpers) throw new Error('createCredencialesController: helpers required');
  const { credencialSchema, listCredencialesQuerySchema } = schemas;
  const { validUUID } = helpers;

  function _assertUUID(id) {
    if (!validUUID(id)) throw new VaultError(400, 'BAD_ID', 'ID inválido.');
  }

  const list = _wrap(async (req) => {
    const q = listCredencialesQuerySchema.parse(req.query);
    return service.listarCredenciales(q);
  });

  const create = _wrap(async (req) => {
    const dto = credencialSchema.parse(req.body);
    return service.crearCredencial(dto, req.user, _extractReqMeta(req));
  });

  const reveal = _wrap(async (req) => {
    _assertUUID(req.params.id);
    return service.revelarPassword(req.params.id, req.user, _extractReqMeta(req));
  });

  const remove = _wrap(async (req) => {
    _assertUUID(req.params.id);
    return service.eliminarCredencial(req.params.id, req.user, _extractReqMeta(req));
  });

  return { list, create, reveal, remove };
}

module.exports = createCredencialesController;
