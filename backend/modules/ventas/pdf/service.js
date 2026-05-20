/**
 * backend/modules/ventas/pdf/service.js
 *
 * Lógica de negocio del sub-módulo PDF. NO conoce req/res. Hace:
 *   - buildPdfData         : compone el payload del template (snapshot + verify hash + QR)
 *   - renderFacturaPdf     : pipeline completo "id → buf" (DB → buildData → HTML → PDF)
 *   - subirPdfAlStorage    : upload + URL pública desde Supabase Storage
 *   - invalidarPdfCache    : pdfUrl=null + remove archivo + bump invalidatedAt
 *   - invalidarPdfsSiCambioTemplate : auto-bust al boot cuando cambia PDF_TEMPLATE_VERSION
 *   - prerenderPdfsBatch   : worker cron-driven que pre-renderiza docs recientes
 *   - mergeCondiciones, _composicionFactura : helpers privados del template
 *   - renderVerifyQr (con LRU cache 256 entradas)
 *
 * Constantes:
 *   - PDF_TEMPLATE_VERSION : bump aquí invalida caches globalmente al próximo boot
 *   - PDF_CACHE_BUCKET     : bucket Supabase (env override)
 *   - PUBLIC_VERIFY_BASE   : host del frontend para construir el QR /verify/<hash>
 *
 * Factory: createPdfService({ repo, supabase, inlineAssets, renderPdfDoc,
 *   generarPdfDocumento, facturaVerifyHash, QRCode })
 */

const crypto       = require('crypto');
const { LRUCache } = require('lru-cache');

const PDF_TEMPLATE_VERSION = 'v11-2026-05-17-qr-url-natural-wrap';
const PDF_CACHE_BUCKET     = process.env.SUPABASE_PDF_BUCKET ?? 'documentos-pdf';

const PREDER_BATCH        = 15;
const PREDER_CONCURRENCY  = 2;
const PREDER_MAX_ATTEMPTS = 5;
const PREDER_LOOKBACK_MS  = 7 * 86_400_000;

const QR_CACHE_MAX = 256;

// Cache LRU para evitar re-procesar mergeCondiciones en bulk-PDF (cron y
// /api/pdf/bulk). Key incluye empresa.id + factura.id + hash de los inputs
// que el merge consume (condicionesDefault + condiciones override). TTL
// corto (5 min) para que cualquier cambio en empresa/factura se refleje
// rápido al regenerar PDFs después de editar configuración.
const _condCache = new LRUCache({ max: 200, ttl: 5 * 60 * 1000 });

class PdfError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

/**
 * Cadena de fallbacks para que el QR del PDF SIEMPRE tenga URL que apuntar.
 *   1. PUBLIC_FRONTEND_URL — preferida, configurada explícitamente.
 *   2. CORS_ORIGIN — primer origen https de la lista (típicamente frontend prod).
 *   3. localhost:5173 — último recurso para no romper dev.
 */
function _resolverVerifyBase() {
  const explicit = (process.env.PUBLIC_FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const corsList = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const httpsCors = corsList.find(o => /^https:\/\//i.test(o));
  if (httpsCors) return httpsCors.replace(/\/+$/, '');
  if (corsList[0]) return corsList[0].replace(/\/+$/, '');
  return 'http://localhost:5173';
}

const PUBLIC_VERIFY_BASE = _resolverVerifyBase();

/**
 * Merge per-doc condiciones sobre EmpresaPerfil defaults.
 * Cada campo del doc puede ser:
 *   string             → incluir si no vacío
 *   {incluir, texto}   → toggle explícito (UI nueva): incluir=false oculta la fila
 *   null/undefined     → fall-through al default empresa
 * Default empresa es siempre string. Si el doc dice incluir=false, NUNCA cae al
 * default (el usuario decidió ocultarla en este documento concreto).
 */
function _mergeCondicionesRaw(empresa, factura) {
  const defs = empresa?.condicionesDefault ?? {};
  const obligatorios = defs?._obligatorio ?? {};
  const own  = factura?.condiciones ?? {};
  const defaultText = (k) => {
    const d = defs?.[k];
    return typeof d === 'string' && d.trim() ? d.trim() : null;
  };
  const pick = (k) => {
    if (obligatorios[k]) return defaultText(k);
    const v = own?.[k];
    if (v !== undefined && v !== null) {
      if (typeof v === 'string') {
        const s = v.trim();
        return s || null;
      }
      if (typeof v === 'object') {
        if (!v.incluir) return null;
        const s = String(v.texto ?? '').trim();
        return s || null;
      }
    }
    return defaultText(k);
  };
  return {
    validez:  pick('validez'),
    pago:     pick('pago'),
    entrega:  pick('entrega'),
    garantia: pick('garantia'),
  };
}

// Wrapper cacheado de mergeCondiciones. Para no pagar JSON.stringify en
// cada hit (las condicionesDefault pueden ser grandes), hasheamos los
// dos inputs con SHA1-trunc-12 — ~5-10× más rápido que stringify masivo
// y suficiente para uniquencess en este cache (200 entradas max).
function _condCacheKey(empresa, factura) {
  const h = crypto.createHash('sha1');
  h.update(String(empresa?.id ?? 0));
  h.update('|');
  h.update(JSON.stringify(empresa?.condicionesDefault ?? null));
  h.update('|');
  h.update(String(factura?.id ?? 'x'));
  h.update('|');
  h.update(JSON.stringify(factura?.condiciones ?? null));
  return h.digest('hex').slice(0, 12);
}

function mergeCondiciones(empresa, factura) {
  const key = _condCacheKey(empresa, factura);
  const hit = _condCache.get(key);
  if (hit) return hit;
  const out = _mergeCondicionesRaw(empresa, factura);
  _condCache.set(key, out);
  return out;
}

/**
 * Clasifica composición de líneas → 'Artículos' | 'Servicio' | 'Mixto'.
 */
function _composicionFactura(lineas) {
  let hasArt = false, hasSrv = false;
  for (const l of lineas) {
    const tipo = l.producto?.tipoItem;
    if (l.productoId && tipo !== 'SERVICIO') hasArt = true;
    else hasSrv = true;
    if (hasArt && hasSrv) break;
  }
  if (hasArt && hasSrv) return 'Mixto';
  if (hasArt) return 'Artículos';
  return 'Servicio';
}

/** Ejecuta promesas con concurrencia controlada. Devuelve resultados en orden. */
async function _mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (err) { results[i] = { status: 'rejected', reason: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function createPdfService(deps) {
  const {
    repo, supabase, inlineAssets, renderPdfDoc, generarPdfDocumento,
    facturaVerifyHash, QRCode, prisma,
  } = deps;
  if (!repo)                                        throw new Error('createPdfService: repo required');
  if (typeof inlineAssets !== 'function')           throw new Error('createPdfService: inlineAssets required');
  if (typeof renderPdfDoc !== 'function')           throw new Error('createPdfService: renderPdfDoc required');
  if (typeof generarPdfDocumento !== 'function')    throw new Error('createPdfService: generarPdfDocumento required');
  if (typeof facturaVerifyHash !== 'function')      throw new Error('createPdfService: facturaVerifyHash required');
  if (!QRCode)                                      throw new Error('createPdfService: QRCode required');
  // prisma opcional — solo necesario para previewPDF (mejora #12). Si falta,
  // la fn lanza al ejecutarse, no en factory init.
  const prismaPdf = prisma;

  // ─── QR cache (LRU simple) ────────────────────────────────────────────────
  const _qrCache = new Map();

  async function renderVerifyQr(url) {
    if (!url) return null;
    if (_qrCache.has(url)) return _qrCache.get(url);
    try {
      const dataUri = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        margin: 1,
        width: 256,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      if (_qrCache.size >= QR_CACHE_MAX) _qrCache.delete(_qrCache.keys().next().value);
      _qrCache.set(url, dataUri);
      return dataUri;
    } catch (e) {
      console.warn('[QR] fallo generar:', e.message);
      return null;
    }
  }

  // ─── buildPdfData ─────────────────────────────────────────────────────────
  async function buildPdfData(facturaOrCotizacion) {
    const f = facturaOrCotizacion;
    // Snapshot fiscal: si la factura tiene datos congelados al momento de emisión
    // (sistema nuevo), USA esa snapshot para garantizar inmutabilidad DGII.
    const snap = f.snapshot && typeof f.snapshot === 'object' ? f.snapshot : null;
    const empresa = snap?.empresa
      ? { ...snap.empresa, condicionesDefault: snap.empresa.condicionesDefault ?? {} }
      : await repo.findEmpresaPerfil();
    const empresaConAssets = empresa
      ? { ...empresa, assets: await inlineAssets(empresa.assets ?? {}) }
      : { razonSocial: '', rnc: '', assets: {} };
    const c = snap?.cliente ?? f.cliente ?? {};
    // M7: cotizaciones NO son documento fiscal. La cédula es PII sensible; si el
    // PDF se filtra (compartido por WhatsApp/email), el RNC empresarial basta.
    // Personas físicas sin RNC -> cédula enmascarada (últimos 4 dígitos).
    const cedulaParaPDF = f.esCotizacion
      ? (c.rnc ? null : (c.cedula ? `***-*******-${String(c.cedula).replace(/\D/g, '').slice(-4)}` : null))
      : c.cedula;
    // Hash computado UNA sola vez sobre la lectura DB — mismo valor viaja al QR
    // y a la sección verify (texto debajo del QR). Recomputar dos veces puede
    // divergir si f muta mid-build con relations lazy.
    const verifyHashFinal = facturaVerifyHash(f, 'pdf-build');
    const verifyUrl = `${PUBLIC_VERIFY_BASE}/verify/${verifyHashFinal}`;
    const lineasFiltered = (f.lineas?.length ? f.lineas : (f.orden?.lineas ?? [])).filter(l => !l.consumoInterno);
    return {
      empresa: empresaConAssets,
      cliente: {
        razonSocial: c.razonSocial,
        noCliente:   c.noCliente,
        rnc:         c.rnc,
        contacto:    c.nombreContacto ?? c.contacto ?? null,
        cedula:      cedulaParaPDF,
        direccion:   c.direccion,
        sector:      c.sector,
        provincia:   c.provincia,
        telefono:    c.telefono ?? c.telefonoPrincipal ?? c.telefonoContacto ?? null,
        email:       c.email,
      },
      items: lineasFiltered.map(l => ({
        codigo:         l.producto?.sku ?? (l.producto?.id ? `ART-${String(l.producto.id).padStart(3, '0')}` : null),
        descripcion:    l.descripcion,
        detalle:        l.producto?.nombre && l.producto.nombre !== l.descripcion ? l.producto.nombre : null,
        sku:            l.producto?.sku ?? null,
        cantidad:       l.cantidad,
        precioUnitario: Number(l.precioUnitario),
      })),
      tipoComposicion: _composicionFactura(lineasFiltered),
      ncf:          f.ncf ?? null,
      tipoNcf:      f.tipoNcf ?? null,
      subtotal:     Number(f.subtotal),
      itbis:        Number(f.itbis ?? 0),
      total:        Number(f.total),
      fechaEmision: f.fechaEmision,
      fechaVence:   f.fechaVence,
      estado:       f.estado,
      notas:        f.notas,
      condiciones:  mergeCondiciones(empresa, f),
      esNotaCredito:           !!f.esNotaCredito,
      esNotaDebito:            !!f.esNotaDebito,
      facturaOrigen:           f.facturaOrigen
        ? { noFactura: f.facturaOrigen.noFactura, ncf: f.facturaOrigen.ncf, tipoNcf: f.facturaOrigen.tipoNcf }
        : null,
      motivoNotaModificatoria: f.motivoNotaModificatoria ?? null,
      verify: { hash: verifyHashFinal, url: verifyUrl },
      verifyQrDataUri: await renderVerifyQr(verifyUrl),
    };
  }

  // ─── Storage upload + cache invalidation ──────────────────────────────────
  /**
   * Path construido como `{año}/{mes}/{facturaId}.pdf`. facturaId es UUID
   * generado por DB (no input de usuario) → path traversal imposible.
   */
  function _buildStoragePath(factura) {
    const fecha = new Date(factura.fechaEmision ?? Date.now());
    return `${fecha.getFullYear()}/${String(fecha.getMonth() + 1).padStart(2, '0')}/${factura.id}.pdf`;
  }

  async function subirPdfAlStorage(buf, factura) {
    if (!supabase) return null;
    const path = _buildStoragePath(factura);
    const { error } = await supabase.storage.from(PDF_CACHE_BUCKET).upload(path, buf, {
      contentType:  'application/pdf',
      cacheControl: '604800', // 7 días en CDN
      upsert:       true,     // regeneración sobrescribe
    });
    if (error) { console.error('[PDF CACHE upload]', error.message); return null; }
    const { data } = supabase.storage.from(PDF_CACHE_BUCKET).getPublicUrl(path);
    return data?.publicUrl ?? null;
  }

  async function invalidarPdfCache(facturaId) {
    if (!facturaId) return;
    try {
      const f = await repo.findFacturaCacheInfo(facturaId);
      // M8: SIEMPRE actualizar pdfInvalidatedAt para que el cron sepa que hubo
      // cambio mid-flight aunque no hubiera PDF previo.
      await repo.invalidateFacturaCacheRow(facturaId);
      if (f?.pdfUrl && supabase) {
        const path = _buildStoragePath({ id: facturaId, fechaEmision: f.fechaEmision });
        await supabase.storage.from(PDF_CACHE_BUCKET).remove([path]).catch(() => {});
      }
    } catch (e) { console.error('[PDF CACHE invalidate]', e.message); }
  }

  // ─── Template version bust (auto al boot) ────────────────────────────────
  let _pdfCacheVersionChecked = false;
  async function invalidarPdfsSiCambioTemplate() {
    if (_pdfCacheVersionChecked) return;
    _pdfCacheVersionChecked = true;
    try {
      const emp = await repo.findEmpresaSecuenciasConfig();
      const cfg = (emp?.secuenciasConfig && typeof emp.secuenciasConfig === 'object') ? emp.secuenciasConfig : {};
      if (cfg._pdfCacheVersion === PDF_TEMPLATE_VERSION) {
        console.log(`[PDF] template ${PDF_TEMPLATE_VERSION} ya activa, sin cambios`);
        return;
      }
      const r = await repo.invalidateAllCachedPdfs();
      if (emp) {
        try {
          await repo.setEmpresaSecuenciasConfig({ ...cfg, _pdfCacheVersion: PDF_TEMPLATE_VERSION });
        } catch (eUp) { console.warn('[PDF] no se pudo persistir versión activa:', eUp.message); }
      } else {
        console.warn('[PDF] empresa(id=1) no existe — invalidación corrió, marker se persistirá tras crear la empresa');
      }
      console.log(`[PDF] template ${PDF_TEMPLATE_VERSION} activa — invalidados ${r.count} PDFs cacheados`);
    } catch (e) { console.warn('[PDF] cache-version check fail:', e.message); }
  }

  // ─── Render por id ────────────────────────────────────────────────────────
  /**
   * Renderiza UN documento dado su id + tipo solicitado. Devuelve { buf,
   * noFactura } o null si no aplica (deleted, tipo mismatch).
   */
  async function renderFacturaPdf(id, tipo) {
    const f = await repo.findFacturaForRender(id);
    if (!f || f.deletedAt) return null;
    if (tipo === 'cotizacion' && !f.esCotizacion) return null;
    if (tipo === 'factura'    && f.esCotizacion)  return null;
    const data = await buildPdfData(f);
    const tipoFinal = (tipo === 'factura' && f.esNotaCredito) ? 'nota-credito'
                    : (tipo === 'factura' && f.esNotaDebito)  ? 'nota-debito'
                    : tipo;
    const html = renderPdfDoc({ tipo: tipoFinal, numero: f.noFactura, ...data });
    const buf  = await generarPdfDocumento(html);
    return { buf, noFactura: f.noFactura };
  }

  /**
   * Helpers usados por los handlers HTTP (cotización + factura). Hace todo el
   * pipeline cache-aware: lookup head, decide redirect vs render, render +
   * subida fire-and-forget al cache de Supabase.
   *
   * Devuelve { mode: 'cache' | 'render', ...payload } para que el controller
   * decida cómo responder (redirect / json / pdf buffer).
   */
  async function fetchOrRenderDocument({ id, kind, fresh }) {
    if (kind !== 'cotizacion' && kind !== 'factura') {
      throw new PdfError(400, 'KIND_INVALID', 'Tipo de documento inválido.');
    }
    const head = await repo.findFacturaHead(id);
    if (kind === 'cotizacion') {
      if (head?.deletedAt) throw new PdfError(404, 'NOT_FOUND', 'Cotización no encontrada.');
      if (head && !head.esCotizacion) throw new PdfError(400, 'IS_FACTURA', 'Este documento es una factura, usa /facturas/:id/pdf.');
    } else {
      if (!head || head.deletedAt) throw new PdfError(404, 'NOT_FOUND', 'Factura no encontrada.');
      if (head.esCotizacion)       throw new PdfError(400, 'IS_COTIZACION', 'Este documento es cotización, usa /cotizaciones/:id/pdf.');
    }
    if (head?.pdfUrl && !fresh) {
      return { mode: 'cache', url: head.pdfUrl, head };
    }

    const f = await repo.findFacturaForRender(id);
    if (!f) throw new PdfError(404, 'NOT_FOUND', kind === 'cotizacion' ? 'Cotización no encontrada.' : 'Factura no encontrada.');

    const data = await buildPdfData(f);
    const tipoDoc = (kind === 'factura' && f.esNotaCredito) ? 'nota-credito'
                  : (kind === 'factura' && f.esNotaDebito)  ? 'nota-debito'
                  : kind;
    const html = renderPdfDoc({ tipo: tipoDoc, numero: f.noFactura, ...data });
    const buf  = await generarPdfDocumento(html);

    // Fire-and-forget: sube al cache Storage sin bloquear respuesta.
    setImmediate(async () => {
      const url = await subirPdfAlStorage(buf, f);
      if (url) await repo.setFacturaPdfUrl(f.id, url).catch(() => {});
    });

    return { mode: 'render', buf, factura: f, tipoDoc };
  }

  // ─── Prerender batch (invocado desde _cron.js cada 5 min) ────────────────
  let _prerenderRunning = false;
  async function prerenderPdfsBatch() {
    if (_prerenderRunning) return;
    if (!supabase)         return;
    _prerenderRunning = true;
    const t0 = Date.now();
    let ok = 0, fail = 0, skipped = 0;
    try {
      const desde = new Date(Date.now() - PREDER_LOOKBACK_MS);
      const candidatos = await repo.findFacturasForPrerender({
        desde, maxAttempts: PREDER_MAX_ATTEMPTS, take: PREDER_BATCH,
      });
      if (candidatos.length === 0) return;

      async function renderOne(c) {
        try {
          const f = await repo.findFacturaForRender(c.id);
          if (!f || f.deletedAt) return;
          // M8: snapshot timestamp ANTES de renderizar para detectar mid-flight invalidations.
          const invalidatedAtBefore = f.pdfInvalidatedAt;
          const data    = await buildPdfData(f);
          const tipo    = f.esCotizacion ? 'cotizacion'
                         : f.esNotaCredito ? 'nota-credito'
                         : f.esNotaDebito  ? 'nota-debito'
                         : 'factura';
          const html    = renderPdfDoc({ tipo, numero: f.noFactura, ...data });
          const pdfBuf  = await generarPdfDocumento(html);

          // M8: re-check pdfInvalidatedAt mid-flight; descartar si cambió.
          const reFetch = await repo.findFacturaInvalidationState(f.id);
          if (reFetch?.deletedAt) return;
          if (reFetch?.pdfInvalidatedAt && (!invalidatedAtBefore || reFetch.pdfInvalidatedAt > invalidatedAtBefore)) {
            console.warn(`[PDF CRON] ${c.noFactura} invalidated mid-render — descartando.`);
            return;
          }

          const url = await subirPdfAlStorage(pdfBuf, f);
          if (url) {
            const r = await repo.setFacturaPdfUrlWithCas(f.id, url, invalidatedAtBefore);
            if (r.count === 0) {
              console.warn(`[PDF CRON] ${c.noFactura} CAS rechazó update — invalidación tardía.`);
            }
            ok++;
          } else {
            await repo.incPdfRenderAttempts(f.id, c.pdfRenderAttempts);
            fail++;
          }
        } catch (e) {
          console.error(`[PDF CRON] ${c.noFactura} (attempt ${(c.pdfRenderAttempts ?? 0) + 1}/${PREDER_MAX_ATTEMPTS}):`, e.message);
          await repo.incPdfRenderAttempts(c.id, c.pdfRenderAttempts);
          if ((c.pdfRenderAttempts ?? 0) + 1 >= PREDER_MAX_ATTEMPTS) {
            console.warn(`[PDF CRON] ${c.noFactura} ALCANZÓ ${PREDER_MAX_ATTEMPTS} intentos. Excluida hasta reset manual.`);
            skipped++;
          }
          fail++;
        }
      }

      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(PREDER_CONCURRENCY, candidatos.length) }, async () => {
          while (cursor < candidatos.length) {
            const idx = cursor++;
            await renderOne(candidatos[idx]);
          }
        }),
      );
      console.log(`[PDF CRON] batch ${candidatos.length} docs en ${Date.now() - t0}ms · ok=${ok} fail=${fail} dead=${skipped}`);
    } catch (e) {
      console.error('[PDF CRON]', e.message);
    } finally {
      _prerenderRunning = false;
    }
  }

  // Mejora #12: genera PDF buffer en memoria a partir de un DTO de carrito,
  // SIN tocar BD (no inserta factura, no consume NCF). El cajero ve cómo
  // queda el documento antes de emitir → cero typos en facturas reales.
  //
  // Se hidratan:
  //   - cliente desde clienteId
  //   - producto/item de cada línea
  // Se construye un objeto factura-mock con noFactura='PREVIEW' + ncf=null
  // que pasa por buildPdfData → renderPdfDoc → generarPdfDocumento.
  async function generarPreviewPdfBuffer(dto) {
    if (!dto?.clienteId) throw new PdfError(400, 'CLIENTE_REQUIRED', 'clienteId requerido para preview.');
    if (!Array.isArray(dto.lineas) || dto.lineas.length === 0) {
      throw new PdfError(400, 'LINEAS_REQUIRED', 'Se requiere al menos una línea.');
    }
    const cliente = await prismaPdf.cliente.findUnique({
      where:  { id: dto.clienteId },
      select: {
        id: true, noCliente: true, razonSocial: true, nombreContacto: true,
        rnc: true, cedula: true, direccion: true, sector: true, provincia: true,
        telefonoPrincipal: true, email: true, tipoNcf: true,
      },
    });
    if (!cliente) throw new PdfError(404, 'CLIENTE_NOT_FOUND', 'Cliente no encontrado.');

    // Hidrata productos + items para descripciones reales en PDF.
    const productoIds = [...new Set(dto.lineas.filter(l => l.productoId).map(l => l.productoId))];
    const itemIds     = [...new Set(dto.lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))];
    const [productos, itemsCat] = await Promise.all([
      productoIds.length ? prismaPdf.producto.findMany({
        where:  { id: { in: productoIds } },
        select: { id: true, sku: true, nombre: true, precio: true },
      }) : [],
      itemIds.length ? prismaPdf.itemCatalogo.findMany({
        where:  { id: { in: itemIds } },
        select: { id: true, codigo: true, nombre: true, precio: true, productoId: true,
                  producto: { select: { id: true, sku: true, nombre: true } } },
      }) : [],
    ]);
    const pMap = Object.fromEntries(productos.map(p => [p.id, p]));
    const iMap = Object.fromEntries(itemsCat.map(it => [it.id, it]));

    // Construye líneas con shape compatible con buildPdfData.
    let subtotal = 0;
    const lineas = dto.lineas.map(l => {
      const cantidad = Math.max(1, Number(l.cantidad) || 1);
      const p = l.productoId ? pMap[l.productoId] : null;
      const it = l.itemCatalogoId ? iMap[l.itemCatalogoId] : null;
      const precio = Number(l.precioUnitario ?? it?.precio ?? p?.precio ?? 0);
      const pct  = Number(l.descuentoPorcentaje ?? 0);
      const mon  = Number(l.descuentoMonto ?? 0);
      const efectivo = Math.max(0, precio * (1 - pct / 100) - mon);
      subtotal += efectivo * cantidad;
      return {
        producto:    p ?? it?.producto ?? null,
        itemCatalogo: it ? { sku: it.codigo, nombre: it.nombre, descripcion: null } : null,
        descripcion: l.descripcion ?? it?.nombre ?? p?.nombre ?? 'Item',
        cantidad,
        precioUnitario: efectivo,
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;
    const aplicarItbis = dto.applyItbis !== false;
    const itbisAmt = aplicarItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0;
    const descGlobalPct   = Number(dto.descuentoGlobalPct ?? 0);
    const descGlobalMonto = Number(dto.descuentoGlobalMonto ?? 0);
    const descGlobal = descGlobalPct > 0 ? subtotal * (descGlobalPct / 100) : descGlobalMonto;
    const subtotalConDesc = Math.max(0, subtotal - descGlobal);
    const total = Math.round((subtotalConDesc + (aplicarItbis ? subtotalConDesc * 0.18 : 0)) * 100) / 100;
    const diasVence = Math.max(0, Number(dto.diasVence ?? 30));

    // Mock factura — id falso, sin persistir. verifyHash se calcula a partir
    // de campos ya seteados (PDF lo muestra para coherencia visual; nunca se
    // persistirá porque la fn NO toca BD).
    const facturaMock = {
      id:           'preview-' + Date.now().toString(36),
      noFactura:    dto.esCotizacion ? 'COT-PREVIEW' : 'FAC-PREVIEW',
      ncf:          null,
      tipoNcf:      cliente.tipoNcf ?? null,
      clienteId:    cliente.id,
      cliente,
      lineas,
      subtotal:     subtotalConDesc,
      itbis:        aplicarItbis ? Math.round(subtotalConDesc * 0.18 * 100) / 100 : 0,
      total,
      fechaEmision: new Date(),
      fechaVence:   diasVence > 0 ? new Date(Date.now() + diasVence * 86_400_000) : null,
      estado:       'Borrador',
      esCotizacion: !!dto.esCotizacion,
      esNotaCredito: false,
      esNotaDebito:  false,
      facturaOrigen: null,
      notas:         dto.notasOverride ?? null,
      condiciones:   dto.condicionesOverride ?? {},
      snapshot:      null,
    };
    const data = await buildPdfData(facturaMock);
    // Marca visual PREVIEW para que el cajero no confunda con una factura real.
    data._preview = true;
    const html = renderPdfDoc({
      tipo:     facturaMock.esCotizacion ? 'cotizacion' : 'factura',
      ...data,
    });
    return generarPdfDocumento(html);
  }

  return {
    PdfError,
    PDF_TEMPLATE_VERSION,
    PDF_CACHE_BUCKET,
    PUBLIC_VERIFY_BASE,
    buildPdfData,
    subirPdfAlStorage,
    invalidarPdfCache,
    invalidarPdfsSiCambioTemplate,
    renderFacturaPdf,
    fetchOrRenderDocument,
    renderVerifyQr,
    prerenderPdfsBatch,
    generarPreviewPdfBuffer,
    _mapWithConcurrency,
  };
}

module.exports = createPdfService;
module.exports.PdfError = PdfError;
module.exports.PDF_TEMPLATE_VERSION = PDF_TEMPLATE_VERSION;
module.exports.PUBLIC_VERIFY_BASE   = PUBLIC_VERIFY_BASE;
