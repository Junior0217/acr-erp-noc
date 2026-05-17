/**
 * backend/modules/ventas/ordenes/controller.js
 *
 * Capa HTTP del módulo Ordenes. Handlers thin: extrae req, valida con Zod,
 * delega al service, aplica el descriptor sobre res. Cero lógica.
 *
 * Multer ya pobló req.file en /ordenes/:id/fotos/upload — el controller solo
 * lo pasa al service como `file` (sin transformar).
 *
 * Factory: createOrdenesController({ service, schemas, prisma, helpers })
 */

const { z } = require('zod');
const { OtError } = require('./service');

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
      if (err instanceof OtError) {
        const body = { error: err.message };
        if (err.code)  body.code = err.code;
        if (err.extra) Object.assign(body, err.extra);
        return res.status(err.status).json(body);
      }
      // Multer cap de tamaño viene como error nativo.
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' });
      }
      console.error('[ORDENES CTRL]', err.message, err.stack);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : 'Error interno.' });
    }
  };
}

function createOrdenesController({ service, schemas, prisma, helpers }) {
  if (!service) throw new Error('createOrdenesController: service required');
  if (!schemas) throw new Error('createOrdenesController: schemas required');
  if (!prisma)  throw new Error('createOrdenesController: prisma required');
  if (!helpers) throw new Error('createOrdenesController: helpers required');

  const {
    listOrdenesQuerySchema, ordenTrabajoSchema, cambiarEstadoOTSchema,
    listOrdenesInstalacionQuerySchema, ordenInstalacionSchema, ordenInstalacionUpdateSchema,
    listServiciosQuerySchema, servicioSchema, servicioUpdateSchema, cambiarEstadoServicioSchema,
    ordenFotoSchema, ordenFotoUploadMetaSchema,
  } = schemas;
  const { validUUID } = helpers;

  function _assertValidUUID(value, msg = 'ID inválido.') {
    if (!validUUID(value)) throw new OtError(400, 'BAD_ID', msg);
  }

  // ─── Orden de Trabajo ────────────────────────────────────────────────────
  const listOrdenesTrabajo = _wrap(async (req) => {
    const q = listOrdenesQuerySchema.parse(req.query);
    return service.listarOrdenesTrabajo(q);
  });

  const createOrdenTrabajo = _wrap(async (req) => {
    const dto     = ordenTrabajoSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.crearOrdenTrabajo(dto, req.user, reqMeta, { prisma });
  });

  const deleteOrdenTrabajo = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const reqMeta = _extractReqMeta(req);
    return service.eliminarOrdenTrabajo(req.params.id, req.user, reqMeta);
  });

  const patchEstadoOT = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto     = cambiarEstadoOTSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.cambiarEstadoOT(req.params.id, dto, req.user, reqMeta, { prisma });
  });

  // ─── Orden de Instalación (legacy /ordenes-instalacion) ─────────────────
  const listOrdenesInstalacion = _wrap(async (req) => {
    const q = listOrdenesInstalacionQuerySchema.parse(req.query);
    return service.listarOrdenesInstalacion(q);
  });

  const createOrdenInstalacion = _wrap(async (req) => {
    const dto = ordenInstalacionSchema.parse(req.body);
    return service.crearOrdenInstalacion(dto, { prisma });
  });

  const updateOrdenInstalacion = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto = ordenInstalacionUpdateSchema.parse(req.body);
    return service.actualizarOrdenInstalacion(req.params.id, dto, { prisma });
  });

  const completarOrdenInstalacion = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    return service.completarOrdenInstalacion(req.params.id, { prisma });
  });

  // ─── Servicios ──────────────────────────────────────────────────────────
  const listServicios = _wrap(async (req) => {
    const q = listServiciosQuerySchema.parse(req.query);
    return service.listarServicios(q);
  });

  const createServicio = _wrap(async (req) => {
    const dto = servicioSchema.parse(req.body);
    return service.crearServicio(dto, { prisma });
  });

  const updateServicio = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto = servicioUpdateSchema.parse(req.body);
    return service.actualizarServicio(req.params.id, dto);
  });

  const patchEstadoServicio = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const dto = cambiarEstadoServicioSchema.parse(req.body);
    return service.cambiarEstadoServicio(req.params.id, dto);
  });

  // ─── Fotos ──────────────────────────────────────────────────────────────
  const listFotos = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    return service.listarFotosOrden(req.params.id);
  });

  const uploadFoto = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    // El multer ya validó el field "file". El service hace todo el pipeline
    // (MIME real, sharp + EXIF strip, Supabase, OrdenFoto record).
    const reqMeta = _extractReqMeta(req);
    const meta = ordenFotoUploadMetaSchema.parse({
      latitud:     req.body?.latitud,
      longitud:    req.body?.longitud,
      descripcion: req.body?.descripcion,
    });
    return service.subirFotoUpload({
      otId:            req.params.id,
      file:            req.file,
      latitudRaw:      meta.latitud,
      longitudRaw:     meta.longitud,
      descripcionRaw:  meta.descripcion,
      headers:         req.headers,
    }, req.user, reqMeta);
  });

  const registrarFotoUrl = _wrap(async (req) => {
    _assertValidUUID(req.params.id);
    const data    = ordenFotoSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.registrarFotoUrl({ otId: req.params.id, data }, req.user, reqMeta);
  });

  const deleteFoto = _wrap(async (req) => {
    _assertValidUUID(req.params.ordenId);
    _assertValidUUID(req.params.fotoId);
    const reqMeta = _extractReqMeta(req);
    return service.eliminarFoto({ ordenId: req.params.ordenId, fotoId: req.params.fotoId }, req.user, reqMeta);
  });

  return {
    listOrdenesTrabajo, createOrdenTrabajo, deleteOrdenTrabajo, patchEstadoOT,
    listOrdenesInstalacion, createOrdenInstalacion, updateOrdenInstalacion, completarOrdenInstalacion,
    listServicios, createServicio, updateServicio, patchEstadoServicio,
    listFotos, uploadFoto, registrarFotoUrl, deleteFoto,
  };
}

module.exports = createOrdenesController;
