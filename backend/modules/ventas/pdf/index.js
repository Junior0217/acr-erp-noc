/**
 * backend/modules/ventas/pdf/index.js
 *
 * Orquestador del sub-módulo PDF. Compone repo + service + controller + router
 * y dispara auto-bust del cache al boot si cambió PDF_TEMPLATE_VERSION.
 *
 * Devuelve `{ router, service }` para que server.js exponga:
 *   - router → mount en /api
 *   - service → consumido por _cron.js (prerenderPdfsBatch) y por handlers
 *               legacy que aún viven en server.js (invalidarPdfCache en
 *               /facturas/:id/condiciones).
 */

const createPdfRepo        = require('./repo');
const createPdfService     = require('./service');
const createPdfController  = require('./controller');
const createPdfRouter      = require('./router');
const pdfSchemas           = require('./schema');

function buildPdfModule(deps) {
  const {
    prisma, middlewares, auditReq, helpers,
    supabase, inlineAssets, renderPdfDoc, generarPdfDocumento,
    facturaVerifyHash, QRCode,
  } = deps;
  if (!prisma)              throw new Error('buildPdfModule: prisma required');
  if (!middlewares)         throw new Error('buildPdfModule: middlewares required');
  if (typeof auditReq !== 'function') throw new Error('buildPdfModule: auditReq required');

  const repo       = createPdfRepo(prisma);
  const service    = createPdfService({
    repo, supabase, inlineAssets, renderPdfDoc, generarPdfDocumento,
    facturaVerifyHash, QRCode,
  });
  const controller = createPdfController({
    service,
    schemas: pdfSchemas,
    helpers,
    auditReq,
  });
  const router     = createPdfRouter({ controller, middlewares });

  // Fire-and-forget: si el template version cambió, vacía pdfUrl masivamente
  // y registra el marker. Async — no bloquea el listen.
  service.invalidarPdfsSiCambioTemplate().catch(() => {});

  return { router, service };
}

module.exports = buildPdfModule;
