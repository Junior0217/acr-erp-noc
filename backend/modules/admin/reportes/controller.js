/**
 * backend/modules/admin/reportes/controller.js
 */

const { z } = require('zod');
const { ReportesError } = require('./service');

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
      if (err instanceof ReportesError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[REPORTES CTRL]', err.message);
      res.status(500).json({ error: err.message || 'Error interno.' });
    }
  };
}

function createReportesController({ service, schemas }) {
  if (!service || !schemas) throw new Error('createReportesController: deps required');
  const { comisionesQuerySchema } = schemas;

  const dashboard = _wrap(async () => service.getDashboard());
  const semanal   = _wrap(async () => service.getReporteSemanal());
  const comisiones = _wrap(async (req) => {
    const q = comisionesQuerySchema.parse(req.query);
    return service.getReporteComisiones(q);
  });

  return { dashboard, semanal, comisiones };
}

module.exports = createReportesController;
