/**
 * backend/modules/crm/suplidores/controller.js
 */

const { z } = require('zod');
const { SuplidorError } = require('./service');

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
      if (err instanceof z.ZodError)   return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof SuplidorError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[SUPLIDORES CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createSuplidoresController({ service, schemas, sharedSchemas, helpers }) {
  if (!service || !schemas || !sharedSchemas || !helpers) throw new Error('createSuplidoresController: deps required');
  const { listSuplidoresQuerySchema } = schemas;
  const { suplidorSchema, suplidorUpdateSchema } = sharedSchemas;
  const { rejectBadId } = helpers;

  const list = _wrap(async (req) => service.listarSuplidores(listSuplidoresQuerySchema.parse(req.query)));

  const create = _wrap(async (req) => {
    const data = suplidorSchema.parse(req.body);
    return service.crearSuplidor(data);
  });

  const update = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    const data = suplidorUpdateSchema.parse(req.body);
    return service.actualizarSuplidor(req.params.id, data);
  });

  const toggle = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    return service.toggleSuplidor(req.params.id);
  });

  return { list, create, update, toggle };
}

module.exports = createSuplidoresController;
