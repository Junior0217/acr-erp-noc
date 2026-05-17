/**
 * backend/modules/crm/clientes/controller.js
 *
 * Factory: createClientesController({ service, schemas, sharedSchemas, helpers })
 *
 * sharedSchemas trae clienteSchema/clienteUpdateSchema (transversales).
 */

const { z } = require('zod');
const { ClienteError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const d = await fn(req, res);
      if (!res.headersSent) {
        const status = d?.status ?? 200;
        if (d?.body == null && (status === 204 || status === 205)) return res.status(status).end();
        return res.status(status).json(d?.body ?? {});
      }
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof ClienteError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[CLIENTES CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createClientesController({ service, schemas, sharedSchemas, helpers, prisma }) {
  if (!service)        throw new Error('createClientesController: service required');
  if (!schemas)        throw new Error('createClientesController: schemas required');
  if (!sharedSchemas)  throw new Error('createClientesController: sharedSchemas required');
  if (!helpers)        throw new Error('createClientesController: helpers required');
  if (!prisma)         throw new Error('createClientesController: prisma required');
  const { listClientesQuerySchema, crearClienteExtrasSchema } = schemas;
  const { clienteSchema, clienteUpdateSchema } = sharedSchemas;
  const { rejectBadId } = helpers;

  const list = _wrap(async (req) => {
    const q = listClientesQuerySchema.parse(req.query);
    return service.listarClientes(q);
  });

  const create = _wrap(async (req) => {
    const { prospectoOrigenId } = crearClienteExtrasSchema.parse({ prospectoOrigenId: req.body?.prospectoOrigenId });
    const { prospectoOrigenId: _omit, ...body } = req.body ?? {};
    const data = clienteSchema.parse(body);
    return service.crearCliente(data, prospectoOrigenId, { prisma });
  });

  const update = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    const data = clienteUpdateSchema.parse(req.body);
    return service.actualizarCliente(req.params.id, data);
  });

  const remove = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    return service.eliminarCliente(req.params.id, req.user, _extractReqMeta(req));
  });

  const toggle = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    return service.toggleCliente(req.params.id);
  });

  return { list, create, update, remove, toggle };
}

module.exports = createClientesController;
