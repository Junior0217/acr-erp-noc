/**
 * backend/modules/servicios/ordenes/controller.js
 *
 * Capa HTTP del módulo Órdenes de Servicio Técnico. CERO lógica de
 * negocio: extrae req.body/params/query, valida con Zod, delega al
 * service, mapea respuestas y errores a HTTP. NO toca Prisma.
 */

function createServiciosOrdenesController({ service, schemas }) {
  if (!service) throw new Error('createServiciosOrdenesController: service required');
  if (!schemas) throw new Error('createServiciosOrdenesController: schemas required');

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

  async function listar(req, res) {
    try {
      const query = schemas.listOrdenesQuerySchema.parse(req.query);
      const out   = await service.listar(query);
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function obtener(req, res) {
    try {
      const out = await service.obtener(req.params.id);
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function crear(req, res) {
    try {
      const dto = schemas.crearOrdenSchema.parse(req.body);
      const out = await service.crear(dto, req.user, _reqMeta(req));
      res.status(201).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function actualizar(req, res) {
    try {
      const dto = schemas.actualizarOrdenSchema.parse(req.body);
      const out = await service.actualizar(req.params.id, dto, req.user, _reqMeta(req));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function cambiarEstado(req, res) {
    try {
      const dto = schemas.cambiarEstadoSchema.parse(req.body);
      const out = await service.transicionarEstado(req.params.id, dto, req.user, _reqMeta(req));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function facturar(req, res) {
    try {
      const dto = schemas.facturarOrdenSchema.parse(req.body || {});
      const out = await service.facturar(req.params.id, dto, req.user, _reqMeta(req));
      res.status(200).json(out);
    } catch (err) { _enviarError(res, err); }
  }

  async function conducePdf(req, res) {
    try {
      const { buffer, filename } = await service.generarConducePdf(req.params.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.status(200).send(buffer);
    } catch (err) { _enviarError(res, err); }
  }

  return {
    listar,
    obtener,
    crear,
    actualizar,
    cambiarEstado,
    facturar,
    conducePdf,
  };
}

module.exports = createServiciosOrdenesController;
