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

const createRepo       = require('./repo');
const createService    = require('./service');
const createController = require('./controller');
const createRouter     = require('./router');

function buildCotizadorLibreModule(deps) {
  const { prisma, middlewares, auditReq, generarPdfDocumento, QRCode, billingLimiter, inlineAssets } = deps;
  if (!middlewares)                              throw new Error('buildCotizadorLibreModule: middlewares required');
  if (typeof auditReq !== 'function')            throw new Error('buildCotizadorLibreModule: auditReq required');
  if (typeof generarPdfDocumento !== 'function') throw new Error('buildCotizadorLibreModule: generarPdfDocumento required');

  // `prisma` es opcional para el render PDF, pero requerido para drafts y
  // para fetchar EmpresaPerfil (logo/RNC/eslogan del template oficial).
  // `inlineAssets` es opcional — si está disponible, los URL assets del logo
  // se convierten a data URI inline antes de pasar a Puppeteer (evita
  // requests externos durante el render).
  const repo       = prisma ? createRepo(prisma) : null;
  const service    = createService({ generarPdfDocumento, QRCode, repo, inlineAssets });
  const controller = createController({ service, auditReq });
  const router     = createRouter({ controller, middlewares, billingLimiter });

  return { router, service, repo };
}

module.exports = buildCotizadorLibreModule;
