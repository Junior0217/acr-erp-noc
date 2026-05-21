/**
 * backend/modules/ventas/cotizador-libre/router.js
 *
 * Rutas HTTP del Cotizador Libre. Una sola ruta:
 *   POST /api/ventas/cotizador-libre/pdf
 *
 * Protegida con verificarJWT + requerirPermiso('venta:ver_cotizaciones').
 * Rate-limited con billingLimiter para evitar spam de renders (cada PDF
 * cuesta ~400-700ms de Puppeteer y abre un page del pool).
 *
 * Factory: createCotizadorLibreRouter({ controller, middlewares, billingLimiter })
 */

const express = require('express');

function createCotizadorLibreRouter({ controller, middlewares, billingLimiter }) {
  if (!controller)  throw new Error('createCotizadorLibreRouter: controller required');
  if (!middlewares) throw new Error('createCotizadorLibreRouter: middlewares required');
  const { verificarJWT, requerirPermiso } = middlewares;

  const router = express.Router();

  router.post('/cotizador-libre/pdf',
    verificarJWT,
    requerirPermiso('venta:ver_cotizaciones'),
    ...(billingLimiter ? [billingLimiter] : []),
    controller.postPdf,
  );

  return router;
}

module.exports = createCotizadorLibreRouter;
