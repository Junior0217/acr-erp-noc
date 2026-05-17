/**
 * backend/modules/crm/prospectos/controller.js
 */

const { z } = require('zod');
const { ProspectoError } = require('./service');

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
      if (err instanceof z.ZodError)     return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof ProspectoError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[PROSPECTOS CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createProspectosController({ service, schemas, sharedSchemas, helpers, prisma }) {
  if (!service || !schemas || !sharedSchemas || !helpers || !prisma) {
    throw new Error('createProspectosController: deps required');
  }
  const { listProspectosQuerySchema } = schemas;
  const { prospectoSchema, prospectoUpdateSchema } = sharedSchemas;
  const { rejectBadId } = helpers;

  const list = _wrap(async (req) => service.listarProspectos(listProspectosQuerySchema.parse(req.query)));

  const create = _wrap(async (req) => {
    const data = prospectoSchema.parse(req.body);
    return service.crearProspecto(data);
  });

  const update = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    const data = prospectoUpdateSchema.parse(req.body);
    return service.actualizarProspecto(req.params.id, data);
  });

  const remove = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    return service.eliminarProspecto(req.params.id);
  });

  const convert = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    return service.convertirProspecto(req.params.id, { prisma });
  });

  return { list, create, update, remove, convert };
}

module.exports = createProspectosController;
