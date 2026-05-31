/**
 * backend/modules/admin/empresa/service.js
 *
 * Cyber Neo:
 *   - GET público: SELECT explícito (sin PII representante).
 *   - PATCH: pinSupervisor + maxDescuentoCajero exigen sistema:owner
 *     (denial audit en intento de bypass).
 *   - Storage cleanup: solo borra paths del bucket whitelisted.
 */

const crypto = require('crypto');
const { invalidateEmpresaPerfilCache } = require('../../../shared/empresa-perfil-cache');

class EmpresaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function _parsearLegacyDescripcion(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { const o = JSON.parse(trimmed); if (o?.v === 1) return null; } catch {}
  }
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let titulo = ''; let bullets = [];
  const m = lines[0].match(/^\*\*(.+)\*\*\s*$/) || lines[0].match(/^#{1,6}\s+(.+)$/);
  if (m) { titulo = m[1].trim(); bullets = lines.slice(1); }
  else   { titulo = lines[0];    bullets = lines.slice(1); }
  bullets = bullets
    .map(l => l.replace(/^[-*•·]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map(b => b.slice(0, 200));
  return { v: 1, titulo: titulo.slice(0, 200), bullets };
}

function createEmpresaService(deps) {
  const {
    repo, auditReq, SECUENCIA_DEFAULTS,
    supabase, SUPABASE_BUCKET, pathFromSupabaseUrl,
    KINDS_VALIDOS, MIME_EXT, detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura,
  } = deps;
  if (!repo)                                       throw new Error('createEmpresaService: repo required');
  if (typeof auditReq !== 'function')              throw new Error('createEmpresaService: auditReq required');
  if (!SECUENCIA_DEFAULTS)                         throw new Error('createEmpresaService: SECUENCIA_DEFAULTS required');

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

  async function getPerfilPublico() {
    const e = await repo.findPublic();
    if (!e) throw new EmpresaError(404, 'NOT_INIT', 'Perfil no inicializado.');
    const safeAssets = {
      logoClaro:  e.assets?.logoClaro  ?? null,
      logoOscuro: e.assets?.logoOscuro ?? null,
    };
    return { status: 200, body: { ...e, assets: safeAssets } };
  }

  async function getPerfilCompleto() {
    const e = await repo.findFull();
    if (!e) throw new EmpresaError(404, 'NOT_INIT', 'Perfil no inicializado.');
    return { status: 200, body: e };
  }

  async function getSecuencias() {
    const e = await repo.findSecuenciasConfig();
    const config = (e?.secuenciasConfig && typeof e.secuenciasConfig === 'object') ? e.secuenciasConfig : {};
    const merged = {};
    for (const k of Object.keys(SECUENCIA_DEFAULTS)) {
      merged[k] = { ...SECUENCIA_DEFAULTS[k], ...(config[k] ?? {}) };
    }
    return { status: 200, body: { secuencias: merged, defaults: SECUENCIA_DEFAULTS } };
  }

  async function actualizarSecuencias(data, user, reqMeta) {
    const current = await repo.findSecuenciasConfig();
    const baseConfig = (current?.secuenciasConfig && typeof current.secuenciasConfig === 'object') ? current.secuenciasConfig : {};
    const next = { ...baseConfig, ...data };
    await repo.upsertSecuencias(next);
    auditReq('empresa:secuencias_update', _fakeReqForAudit(reqMeta, user), { entidades: Object.keys(data) });
    return { status: 200, body: { secuencias: next } };
  }

  async function previewSecuencia(entidad) {
    const def = SECUENCIA_DEFAULTS[entidad];
    if (!def) throw new EmpresaError(400, 'ENTIDAD_DESCONOCIDA', 'Entidad desconocida.');
    const e = await repo.findSecuenciasConfig();
    const cfg = e?.secuenciasConfig?.[entidad] ?? def;
    const next = Number(cfg.actual ?? def.actual) + 1;
    return {
      status: 200,
      body: {
        entidad,
        prefijo: cfg.prefijo,
        actual:  cfg.actual,
        padding: cfg.padding,
        proximo: `${cfg.prefijo}-${String(next).padStart(cfg.padding, '0')}`,
      },
    };
  }

  async function actualizarPerfil(data, user, reqMeta) {
    const reqStub = _fakeReqForAudit(reqMeta, user);
    const camposCriticos = ['pinSupervisor', 'maxDescuentoCajero'].filter(k => data[k] !== undefined);
    if (camposCriticos.length > 0) {
      const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
      if (!permisos.includes('sistema:owner')) {
        auditReq('empresa:critical_edit_denied', reqStub, { campos: camposCriticos });
        throw new EmpresaError(403, 'OWNER_REQUIRED', 'Solo el propietario absoluto puede modificar PIN o umbral de descuento.');
      }
      auditReq('empresa:critical_changed', reqStub, { campos: camposCriticos, maxDesc: data.maxDescuentoCajero });
    }
    const prevAssets = data.assets
      ? ((await repo.findAssets())?.assets ?? {})
      : null;
    if (data.assets) {
      data.assets = { ...(prevAssets ?? {}), ...data.assets };
    }
    const e = await repo.upsertEmpresa(data);
    // Invalida el cache compartido de EmpresaPerfil — los PDFs (facturas,
    // cotizaciones, cotizador libre) tomarán el logo/RNC/eslogan nuevo al
    // instante en vez de servir el viejo hasta que expire el TTL.
    invalidateEmpresaPerfilCache();
    auditReq('empresa:perfil_update', reqStub, { campos: Object.keys(data) });

    if (prevAssets && supabase && SUPABASE_BUCKET && typeof pathFromSupabaseUrl === 'function') {
      setImmediate(async () => {
        try {
          const paths = [];
          for (const [k, oldUrl] of Object.entries(prevAssets)) {
            if (!oldUrl) continue;
            const newUrl = data.assets?.[k];
            if (newUrl === oldUrl) continue;
            const p = pathFromSupabaseUrl(oldUrl);
            if (p) paths.push(p);
          }
          if (paths.length === 0) return;
          const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(paths);
          if (error) console.error('[EMPRESA PATCH CLEANUP]', error.message);
          else       console.log('[EMPRESA PATCH CLEANUP OK]', paths.length, 'paths');
        } catch (err) {
          console.error('[EMPRESA PATCH CLEANUP EXCEPTION]', err.message);
        }
      });
    }
    return { status: 200, body: e };
  }

  async function migrarDescripciones(user, reqMeta) {
    const t0 = Date.now();
    const stats = {
      producto:     { total: 0, migrados: 0, skipped: 0, errores: 0 },
      itemCatalogo: { total: 0, migrados: 0, skipped: 0, errores: 0 },
    };
    const productos = await repo.listProductosConDescripcion();
    stats.producto.total = productos.length;
    for (const p of productos) {
      const parsed = _parsearLegacyDescripcion(p.descripcion);
      if (!parsed) { stats.producto.skipped++; continue; }
      try {
        await repo.updateProductoDescripcion(p.id, JSON.stringify(parsed));
        stats.producto.migrados++;
      } catch (e) {
        console.error(`[MIGRACION] producto ${p.id}:`, e.message);
        stats.producto.errores++;
      }
    }
    const items = await repo.listItemCatalogoConDescripcion();
    stats.itemCatalogo.total = items.length;
    for (const it of items) {
      const parsed = _parsearLegacyDescripcion(it.descripcion);
      if (!parsed) { stats.itemCatalogo.skipped++; continue; }
      try {
        await repo.updateItemCatalogoDescripcion(it.id, JSON.stringify(parsed));
        stats.itemCatalogo.migrados++;
      } catch (e) {
        console.error(`[MIGRACION] itemCatalogo ${it.id}:`, e.message);
        stats.itemCatalogo.errores++;
      }
    }
    auditReq('admin:migrar_descripciones', _fakeReqForAudit(reqMeta, user), { stats, elapsedMs: Date.now() - t0 });
    return {
      status: 200,
      body: {
        ok: true,
        elapsedMs: Date.now() - t0,
        stats,
        resumen: `Productos: ${stats.producto.migrados}/${stats.producto.total} migrados, ${stats.producto.skipped} ya estructurados. ItemCatalogo: ${stats.itemCatalogo.migrados}/${stats.itemCatalogo.total} migrados, ${stats.itemCatalogo.skipped} ya estructurados.`,
      },
    };
  }

  async function uploadAsset({ file, kind }, user, reqMeta) {
    if (!supabase) throw new EmpresaError(503, 'STORAGE_DISABLED', 'Storage no configurado. Falta SUPABASE_SERVICE_ROLE_KEY.');
    if (!file)     throw new EmpresaError(400, 'FILE_REQUIRED',   'Archivo requerido (campo "file").');
    if (!KINDS_VALIDOS.includes(kind)) {
      throw new EmpresaError(400, 'BAD_KIND', `Parámetro "kind" debe ser uno de: ${KINDS_VALIDOS.join(', ')}.`);
    }
    const inputMime = detectMimeFromBuffer(file.buffer);
    if (!inputMime)        throw new EmpresaError(415, 'INVALID_MIME', 'Tipo de archivo no reconocido o corrupto.');
    if (!MIME_EXT[inputMime]) throw new EmpresaError(415, 'MIME_NOT_ALLOWED', `Mime ${inputMime} no permitido.`);
    if (inputMime === 'image/svg+xml' && !svgSeguro(file.buffer)) {
      auditReq('empresa:upload_svg_malicioso', _fakeReqForAudit(reqMeta, user), { kind, size: file.size });
      throw new EmpresaError(422, 'SVG_UNSAFE', 'SVG contiene contenido peligroso.');
    }
    let buffer, finalMime, ext;
    try {
      const compressed = await comprimirImagen(file.buffer, inputMime);
      buffer = compressed.buffer; finalMime = compressed.mime; ext = compressed.ext;
    } catch (e) {
      console.error('[SHARP COMPRESS]', e.message);
      throw new EmpresaError(422, 'COMPRESS_FAIL', 'Imagen corrupta o formato no procesable.');
    }
    // Cyber Neo: path = ${bucket}/${kind}-${ts}-${random}.${ext}. Cero req.params.
    const filename = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const path     = `acr/${filename}`;
    const { error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buffer, {
      contentType: finalMime, cacheControl: '3600', upsert: false,
    });
    if (upErr) {
      console.error('[UPLOAD ERROR]', upErr.message);
      throw new EmpresaError(502, 'STORAGE_UPLOAD_FAIL', `Error al subir: ${upErr.message}`);
    }
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
    const publicUrl = pub?.publicUrl;
    if (!publicUrl || !esAssetUrlSegura(publicUrl)) {
      throw new EmpresaError(500, 'URL_INVALID', 'URL pública generada inválida.');
    }
    const ahorroPct = ((file.size - buffer.length) / file.size * 100);
    auditReq('empresa:upload', _fakeReqForAudit(reqMeta, user), {
      kind, inputMime, finalMime,
      sizeOriginal: file.size, sizeComprimido: buffer.length,
      ahorroPct: Number(ahorroPct.toFixed(1)), url: publicUrl,
    });
    return {
      status: 201,
      body: {
        kind, url: publicUrl, mime: finalMime,
        size: buffer.length, sizeOriginal: file.size,
        ahorroPct: Number(ahorroPct.toFixed(1)),
      },
    };
  }

  return {
    EmpresaError,
    getPerfilPublico,
    getPerfilCompleto,
    getSecuencias,
    actualizarSecuencias,
    previewSecuencia,
    actualizarPerfil,
    migrarDescripciones,
    uploadAsset,
  };
}

module.exports = createEmpresaService;
module.exports.EmpresaError = EmpresaError;
