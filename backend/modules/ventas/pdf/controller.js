/**
 * backend/modules/ventas/pdf/controller.js
 *
 * Capa HTTP del sub-módulo PDF. 3 handlers:
 *   GET  /cotizaciones/:id/pdf  - cache hit (302/json) o render inline.
 *   GET  /facturas/:id/pdf      - igual + variantes NC/ND.
 *   POST /pdf/bulk              - genera N PDFs y los stream-empaqueta como ZIP.
 *
 * Permisos finos: bulk valida 'venta:ver_cotizaciones' si tipo='cotizacion',
 * 'factura:ver' si tipo='factura'. El router protege con el más amplio.
 *
 * Factory: createPdfController({ service, schemas, helpers, auditReq })
 */

const archiver = require('archiver');
const { z }    = require('zod');
const { PdfError } = require('./service');

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof PdfError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[PDF CTRL]', err.message, err.stack);
      if (!res.headersSent) res.status(500).json({ error: 'Error generando PDF.', detail: err.message });
    }
  };
}

function createPdfController({ service, schemas, helpers, auditReq }) {
  if (!service)                                throw new Error('createPdfController: service required');
  if (!schemas)                                throw new Error('createPdfController: schemas required');
  if (!helpers)                                throw new Error('createPdfController: helpers required');
  if (typeof auditReq !== 'function')          throw new Error('createPdfController: auditReq required');

  const { bulkPdfSchema, BULK_PDF_MAX } = schemas;
  const { validUUID } = helpers;
  const BULK_PDF_PARALLEL = 4;

  function _wantsJson(req) {
    return req.query.json === '1' || (req.headers.accept ?? '').includes('application/json');
  }

  async function _handleDocumento(req, res, { kind, eventoCacheHit, eventoFresh, permReq }) {
    if (!validUUID(req.params.id)) throw new PdfError(400, 'BAD_ID', 'ID inválido.');
    const fresh = req.query.fresh === '1';
    const out   = await service.fetchOrRenderDocument({ id: req.params.id, kind, fresh });

    if (out.mode === 'cache') {
      auditReq(eventoCacheHit, req, { id: req.params.id, noFactura: out.head?.noFactura, ncf: out.head?.ncf });
      if (_wantsJson(req)) return res.json({ url: out.url, cached: true });
      return res.redirect(302, out.url);
    }

    const { buf, factura, tipoDoc } = out;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${tipoDoc}-${factura.noFactura}.pdf"`);
    res.setHeader('Content-Length', buf.length);
    auditReq(eventoFresh, req, { id: factura.id, noFactura: factura.noFactura, ncf: factura.ncf });
    res.end(buf);
  }

  const getCotizacionPdf = _wrap(async (req, res) => {
    return _handleDocumento(req, res, {
      kind:           'cotizacion',
      eventoCacheHit: 'pdf:cotizacion:cache_hit',
      eventoFresh:    'pdf:cotizacion',
      permReq:        'venta:ver_cotizaciones',
    });
  });

  const getFacturaPdf = _wrap(async (req, res) => {
    return _handleDocumento(req, res, {
      kind:           'factura',
      eventoCacheHit: 'pdf:factura:cache_hit',
      eventoFresh:    'pdf:factura',
      permReq:        'factura:ver',
    });
  });

  /**
   * Bulk: stream-encode ZIP a res. archiver.pipe(res) inicia headers
   * inmediatamente — si el render falla DESPUÉS de pipe, ya no podemos
   * cambiar status (res.headersSent=true), solo abortar y end().
   */
  const postBulkPdf = _wrap(async (req, res) => {
    const { ids, tipo } = bulkPdfSchema.parse(req.body);
    const permReq  = tipo === 'cotizacion' ? 'venta:ver_cotizaciones' : 'factura:ver';
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : [];
    if (!permisos.includes('sistema:owner') && !permisos.includes(permReq)) {
      return res.status(403).json({ error: `Se requiere permiso "${permReq}".` });
    }

    const stamp    = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `${tipo === 'cotizacion' ? 'cotizaciones' : 'facturas'}-${stamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    let archive;
    try {
      archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => { console.error('[BULK ZIP]', err.message); try { res.destroy(err); } catch {} });
      archive.pipe(res);

      const resultados = await service._mapWithConcurrency(ids, BULK_PDF_PARALLEL, id => service.renderFacturaPdf(id, tipo));

      let ok = 0, fail = 0;
      for (let i = 0; i < resultados.length; i++) {
        const r = resultados[i];
        if (r.status !== 'fulfilled' || !r.value) {
          fail++;
          archive.append(`ID solicitado: ${ids[i]}\nMotivo: ${r.reason?.message ?? 'no encontrado o tipo incorrecto'}\n`, { name: `_fallidas/${ids[i]}.txt` });
          continue;
        }
        const { buf, noFactura } = r.value;
        archive.append(buf, { name: `${tipo === 'cotizacion' ? 'cotizacion' : 'factura'}-${noFactura}.pdf` });
        ok++;
      }
      archive.append(`Generación masiva ACR ERP\nFecha: ${new Date().toISOString()}\nSolicitadas: ${ids.length}\nGeneradas: ${ok}\nFallidas: ${fail}\n`, { name: 'RESUMEN.txt' });
      auditReq('pdf:bulk', req, { tipo, solicitadas: ids.length, generadas: ok, fallidas: fail });
      await archive.finalize();
    } catch (e) {
      if (archive) { try { archive.abort(); } catch {} }
      if (e instanceof z.ZodError) {
        if (!res.headersSent) return res.status(400).json({ error: e.issues?.[0]?.message ?? `Mínimo 1, máximo ${BULK_PDF_MAX} documentos por exportación.` });
      }
      console.error('[BULK PDF]', e.message);
      if (!res.headersSent) return res.status(500).json({ error: 'Error generando exportación masiva.' });
      try { res.end(); } catch {}
    }
  });

  // Mejora #12: preview PDF en memoria (no toca BD, no consume NCF).
  const previewPdfBodySchema = z.object({
    clienteId:           z.string().uuid(),
    esCotizacion:        z.boolean().optional().default(false),
    applyItbis:          z.boolean().optional().default(true),
    diasVence:           z.coerce.number().int().min(0).max(365).optional().default(30),
    descuentoGlobalPct:  z.coerce.number().min(0).max(100).optional().default(0),
    descuentoGlobalMonto:z.coerce.number().min(0).optional().default(0),
    condicionesOverride: z.any().optional(),
    notasOverride:       z.string().max(2000).nullable().optional(),
    lineas: z.array(z.object({
      itemCatalogoId:      z.string().uuid().optional().nullable(),
      productoId:          z.coerce.number().int().positive().optional().nullable(),
      descripcion:         z.string().max(500).optional(),
      cantidad:            z.coerce.number().int().min(1).max(9999).default(1),
      precioUnitario:      z.coerce.number().min(0).optional(),
      descuentoPorcentaje: z.coerce.number().min(0).max(100).optional().default(0),
      descuentoMonto:      z.coerce.number().min(0).optional().default(0),
    })).min(1).max(200),
  });
  const postPreviewPdf = _wrap(async (req, res) => {
    const dto = previewPdfBodySchema.parse(req.body ?? {});
    const buffer = await service.generarPreviewPdfBuffer(dto);
    if (!buffer) {
      return res.status(500).json({ error: 'Error generando preview PDF.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Preview', '1');
    res.end(buffer);
  });

  return { getCotizacionPdf, getFacturaPdf, postBulkPdf, postPreviewPdf };
}

module.exports = createPdfController;
