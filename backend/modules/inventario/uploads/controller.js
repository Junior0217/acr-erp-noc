/**
 * backend/modules/inventario/uploads/controller.js
 *
 * Capa HTTP de uploads. Multer ya pobló req.file en upload-image; este
 * controller solo extrae buffer + kind y delega al service. CERO storage,
 * CERO descargas remotas (todo eso en service).
 *
 * Factory: createUploadsController({ service, schemas })
 */

const { z } = require('zod');
const { UploadError } = require('./service');

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
        return res.status(status).json(d?.body ?? {});
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof UploadError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      // Multer LIMIT_FILE_SIZE viene como error nativo (no UploadError).
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' });
      }
      console.error('[UPLOADS CTRL]', err.message, err.stack);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createUploadsController({ service, schemas }) {
  if (!service)             throw new Error('createUploadsController: service required');
  if (!schemas)             throw new Error('createUploadsController: schemas required');
  const { urlUploadSchema, fileKindSchema } = schemas;

  const uploadImage = _wrap(async (req) => {
    const reqMeta   = _extractReqMeta(req);
    const { kind }  = fileKindSchema.parse({ kind: req.body?.kind || req.query?.kind });
    const buffer    = req.file?.buffer;
    return service.uploadFromFile({ buffer, kind }, reqMeta, req.user);
  });

  const uploadFromUrl = _wrap(async (req) => {
    const reqMeta = _extractReqMeta(req);
    const dto     = urlUploadSchema.parse(req.body);
    return service.uploadFromUrl(dto, reqMeta, req.user);
  });

  return { uploadImage, uploadFromUrl };
}

module.exports = createUploadsController;
