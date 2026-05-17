/**
 * backend/modules/inventario/uploads/service.js
 *
 * Lógica de negocio para subir imágenes al bucket de inventario. Cubre dos
 * pipelines:
 *   1. uploadFromFile(file, kind, reqMeta, user) — desde multer (buffer local).
 *   2. uploadFromUrl(url, kind, reqMeta, user)   — descarga remota con SSRF
 *      guard, validación MIME por magic bytes, compresión sharp + rehosting.
 *
 * Tanto el servicio como el repo son agnósticos a Express. Todo viaja como
 * Buffer + metadatos planos. Auditoría centralizada acá (no en controller).
 */

const crypto = require('crypto');

/** Error tipado del sub-módulo uploads; controller lo mapea a HTTP. */
class UploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createUploadsService(deps) {
  const {
    repo, auditReq, supabase, INVENTORY_BUCKET, MIME_EXT, KINDS_INVENTARIO,
    detectMimeFromBuffer, svgSeguro, comprimirImagen, esUrlPublicaSegura,
  } = deps;
  if (!repo)                                            throw new Error('createUploadsService: repo required');
  if (typeof auditReq !== 'function')                   throw new Error('createUploadsService: auditReq required');
  if (!INVENTORY_BUCKET)                                throw new Error('createUploadsService: INVENTORY_BUCKET required');
  if (!MIME_EXT)                                        throw new Error('createUploadsService: MIME_EXT required');
  if (!Array.isArray(KINDS_INVENTARIO))                 throw new Error('createUploadsService: KINDS_INVENTARIO required');
  if (typeof detectMimeFromBuffer !== 'function')       throw new Error('createUploadsService: detectMimeFromBuffer required');
  if (typeof svgSeguro !== 'function')                  throw new Error('createUploadsService: svgSeguro required');
  if (typeof comprimirImagen !== 'function')            throw new Error('createUploadsService: comprimirImagen required');
  if (typeof esUrlPublicaSegura !== 'function')         throw new Error('createUploadsService: esUrlPublicaSegura required');

  function _ensureStorageReady() {
    if (!supabase) throw new UploadError(503, 'STORAGE_DISABLED', 'Storage no configurado.');
  }

  function _validateKind(kind) {
    if (!KINDS_INVENTARIO.includes(kind)) {
      throw new UploadError(400, 'KIND_INVALID', `Parámetro "kind" debe ser uno de: ${KINDS_INVENTARIO.join(', ')}.`);
    }
  }

  function _fakeReqForAudit(reqMeta, user) {
    return {
      headers: {
        'x-forwarded-for': reqMeta?.ip ?? null,
        'user-agent':      reqMeta?.ua ?? null,
      },
      socket: { remoteAddress: reqMeta?.ip ?? null },
      user:   user ?? null,
    };
  }

  function _validateAndDetectMime(buffer) {
    const inputMime = detectMimeFromBuffer(buffer);
    if (!inputMime)           throw new UploadError(415, 'INVALID_MIME', 'Tipo no reconocido.');
    if (!MIME_EXT[inputMime]) throw new UploadError(415, 'MIME_NOT_ALLOWED', `Mime ${inputMime} no permitido.`);
    if (inputMime === 'image/svg+xml' && !svgSeguro(buffer)) {
      throw new UploadError(422, 'SVG_UNSAFE', 'SVG con contenido peligroso.');
    }
    return inputMime;
  }

  async function _compressOrFail(buffer, inputMime, msg = 'Imagen corrupta.') {
    try {
      return await comprimirImagen(buffer, inputMime);
    } catch {
      throw new UploadError(422, 'COMPRESS_FAIL', msg);
    }
  }

  async function _uploadBufferAndAudit(buffer, finalMime, ext, kind, evento, auditMeta, reqMeta, user) {
    const filename = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const path     = `${kind}/${filename}`;
    let publicUrl;
    try {
      publicUrl = await repo.uploadFile(path, buffer, finalMime);
    } catch (e) {
      throw new UploadError(502, 'STORAGE_UPLOAD_FAIL', `Error al subir: ${e.message}`);
    }
    auditReq(evento, _fakeReqForAudit(reqMeta, user), { kind, mime: finalMime, size: buffer.length, ...auditMeta });
    return { kind, url: publicUrl, mime: finalMime, size: buffer.length };
  }

  // ─── /api/inventario/upload-image ─────────────────────────────────────────
  async function uploadFromFile({ buffer, kind = 'producto' }, reqMeta, user) {
    _ensureStorageReady();
    if (!buffer || !buffer.length) throw new UploadError(400, 'FILE_REQUIRED', 'Archivo requerido (campo "file").');
    _validateKind(kind);
    const inputMime = _validateAndDetectMime(buffer);
    const { buffer: compressed, mime: finalMime, ext } = await _compressOrFail(buffer, inputMime);
    const out = await _uploadBufferAndAudit(compressed, finalMime, ext, kind, 'inventario:upload_imagen', {}, reqMeta, user);
    return { status: 201, body: out };
  }

  // ─── /api/inventario/upload-url ───────────────────────────────────────────
  async function uploadFromUrl({ url, kind }, reqMeta, user) {
    _ensureStorageReady();
    if (!esUrlPublicaSegura(url)) {
      throw new UploadError(400, 'URL_BLOCKED', 'URL no válida o bloqueada por seguridad.');
    }

    // Descarga con timeout 8s + cap 5MB. redirect:'error' previene SSRF chains
    // tipo bit.ly → metadata interna 169.254.169.254.
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 8000);
    let buf;
    try {
      const r = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!r.ok)  throw new UploadError(422, 'REMOTE_FAIL', `Servidor remoto devolvió ${r.status}.`);
      const len = Number(r.headers.get('content-length') ?? 0);
      if (len > 5 * 1024 * 1024) throw new UploadError(413, 'TOO_LARGE', 'Imagen remota excede 5MB.');
      const ab = await r.arrayBuffer();
      if (ab.byteLength > 5 * 1024 * 1024) throw new UploadError(413, 'TOO_LARGE', 'Imagen remota excede 5MB.');
      buf = Buffer.from(ab);
    } catch (e) {
      if (e instanceof UploadError) throw e;
      if (e.name === 'AbortError') throw new UploadError(504, 'TIMEOUT', 'Descarga remota timeout (8s).');
      throw new UploadError(502, 'FETCH_FAIL', `No se pudo descargar: ${e.message}`);
    } finally { clearTimeout(timer); }

    const inputMime = _validateAndDetectMime(buf);
    const { buffer: compressed, mime: finalMime, ext } = await _compressOrFail(buf, inputMime, 'Imagen remota corrupta o ilegible.');
    const out = await _uploadBufferAndAudit(compressed, finalMime, ext, kind, 'inventario:upload_imagen_url', { sourceUrl: url }, reqMeta, user);
    return { status: 201, body: { ...out, sourceUrl: url } };
  }

  return { UploadError, uploadFromFile, uploadFromUrl };
}

module.exports = createUploadsService;
module.exports.UploadError = UploadError;
