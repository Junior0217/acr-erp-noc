/**
 * backend/modules/admin/empresa/controller.js
 */

const { z } = require('zod');
const { EmpresaError } = require('./service');

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
      if (err instanceof EmpresaError) return res.status(err.status).json({ error: err.message, code: err.code });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo excede 2MB.', code: 'TOO_LARGE' });
      console.error('[EMPRESA CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createEmpresaController({ service, schemas }) {
  if (!service || !schemas) throw new Error('createEmpresaController: deps required');
  const { secuenciasPatchSchema, empresaPatchSchema, previewParamsSchema } = schemas;

  const getPublico  = _wrap(async () => service.getPerfilPublico());
  const getEmpresa  = _wrap(async () => service.getPerfilCompleto());

  const getSecuencias = _wrap(async () => service.getSecuencias());

  const patchSecuencias = _wrap(async (req) => {
    const data = secuenciasPatchSchema.parse(req.body);
    return service.actualizarSecuencias(data, req.user, _extractReqMeta(req));
  });

  const previewSecuencia = _wrap(async (req) => {
    const { entidad } = previewParamsSchema.parse(req.params);
    return service.previewSecuencia(entidad);
  });

  const patchEmpresa = _wrap(async (req) => {
    const data = empresaPatchSchema.parse(req.body);
    return service.actualizarPerfil(data, req.user, _extractReqMeta(req));
  });

  const migrarDescripciones = _wrap(async (req) =>
    service.migrarDescripciones(req.user, _extractReqMeta(req))
  );

  const upload = _wrap(async (req) => {
    const kind = String(req.body?.kind ?? req.query?.kind ?? '');
    return service.uploadAsset({ file: req.file, kind }, req.user, _extractReqMeta(req));
  });

  return {
    getPublico, getEmpresa,
    getSecuencias, patchSecuencias, previewSecuencia,
    patchEmpresa, migrarDescripciones, upload,
  };
}

module.exports = createEmpresaController;
