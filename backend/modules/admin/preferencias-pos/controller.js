/**
 * backend/modules/admin/preferencias-pos/controller.js
 */

function createPreferenciasPosController({ service, schemas }) {
  if (!service) throw new Error('createPreferenciasPosController: service required');
  if (!schemas) throw new Error('createPreferenciasPosController: schemas required');

  function _reqMeta(req) {
    return {
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
      ua: req.headers['user-agent'] || null,
    };
  }

  function _enviarError(res, err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', detalles: err.errors });
    }
    if (err?.status && err?.code) {
      return res.status(err.status).json({ error: err.code, mensaje: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL', mensaje: 'Error interno del servidor.' });
  }

  async function obtenerMias(req, res) {
    try {
      const out = await service.obtener(Number(req.user?.id));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function actualizarMias(req, res) {
    try {
      const dto = schemas.preferenciasPosSchema.parse(req.body || {});
      const out = await service.actualizar(Number(req.user?.id), dto, req.user, _reqMeta(req));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  return { obtenerMias, actualizarMias };
}

module.exports = createPreferenciasPosController;
