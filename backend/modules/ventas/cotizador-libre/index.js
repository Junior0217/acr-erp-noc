/**
 * backend/modules/ventas/cotizador-libre/index.js
 *
 * Orquestador del sub-módulo Cotizador Libre. Compone service + controller +
 * router. NO requiere prisma (no persiste); requiere generarPdfDocumento +
 * QRCode + middlewares + auditReq.
 *
 * Factory: buildCotizadorLibreModule({ middlewares, auditReq,
 *   generarPdfDocumento, QRCode, billingLimiter })
 */

const createService    = require('./service');
const createController = require('./controller');
const createRouter     = require('./router');

function buildCotizadorLibreModule(deps) {
  const { middlewares, auditReq, generarPdfDocumento, QRCode, billingLimiter } = deps;
  if (!middlewares)                            throw new Error('buildCotizadorLibreModule: middlewares required');
  if (typeof auditReq !== 'function')          throw new Error('buildCotizadorLibreModule: auditReq required');
  if (typeof generarPdfDocumento !== 'function') throw new Error('buildCotizadorLibreModule: generarPdfDocumento required');

  const service    = createService({ generarPdfDocumento, QRCode });
  const controller = createController({ service, auditReq });
  const router     = createRouter({ controller, middlewares, billingLimiter });

  return { router, service };
}

module.exports = buildCotizadorLibreModule;
