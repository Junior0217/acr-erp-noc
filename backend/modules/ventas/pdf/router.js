/**
 * backend/modules/ventas/pdf/router.js
 *
 * Rutas HTTP del sub-módulo PDF. Declara bulkPdfLimiter LOCAL (5 req/min) —
 * el monolito legacy lo pasaba via _routerDeps, pero pertenece a este dominio.
 * CERO lógica: middlewares + delega a controller.
 *
 * Factory: createPdfRouter({ controller, middlewares })
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

function createPdfRouter({ controller, middlewares }) {
  if (!controller)  throw new Error('createPdfRouter: controller required');
  if (!middlewares) throw new Error('createPdfRouter: middlewares required');
  const { verificarJWT, requerirPermiso } = middlewares;

  const bulkPdfLimiter = rateLimit({
    windowMs: 60_000,
    max:      5,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Demasiadas exportaciones masivas. Intente en 1 minuto.' },
  });

  const router = express.Router();

  // GET /api/cotizaciones/:id/pdf — soporta ?fresh=1 ?json=1
  router.get('/cotizaciones/:id/pdf',
    verificarJWT,
    requerirPermiso('venta:ver_cotizaciones'),
    controller.getCotizacionPdf,
  );

  // GET /api/facturas/:id/pdf — soporta ?fresh=1 ?json=1
  router.get('/facturas/:id/pdf',
    verificarJWT,
    requerirPermiso('factura:ver'),
    controller.getFacturaPdf,
  );

  // POST /api/pdf/bulk — ZIP stream (max 50 docs)
  router.post('/pdf/bulk',
    bulkPdfLimiter,
    verificarJWT,
    requerirPermiso('factura:ver'),
    controller.postBulkPdf,
  );

  return router;
}

module.exports = createPdfRouter;
