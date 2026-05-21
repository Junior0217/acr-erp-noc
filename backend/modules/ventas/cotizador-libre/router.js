/**
 * backend/modules/ventas/cotizador-libre/router.js
 *
 * Rutas HTTP del Cotizador Libre:
 *   POST /api/ventas/cotizador-libre/pdf         → genera PDF on-demand.
 *   GET  /api/ventas/cotizador-libre/drafts      → lista mis drafts (recientes).
 *   GET  /api/ventas/cotizador-libre/draft/:n    → carga un draft específico.
 *   PUT  /api/ventas/cotizador-libre/draft       → upsert idempotente (auto-save).
 *   DELETE /api/ventas/cotizador-libre/draft/:n  → borra un draft.
 *
 * Permiso server-side: `cotizador_libre_manual`. Sin este permiso, ni el PDF
 * ni los drafts son accesibles — incluso si un usuario adivina la URL del
 * panel React, el backend responde 403. El permiso se asigna a roles
 * específicos (Propietario, Socios, Beta Testers) vía panel de permisos.
 *
 * Rate-limit: billingLimiter compartido (cross-pod Redis). El PDF abre un
 * page de Puppeteer; los CRUD de drafts son baratos pero igual hereditan el
 * mismo limiter para no romper la cuota cuando un cajero alterna entre PDF
 * y guardado.
 *
 * Factory: createCotizadorLibreRouter({ controller, middlewares, billingLimiter })
 */

const express = require('express');

const PERMISO = 'cotizador_libre_manual';

function createCotizadorLibreRouter({ controller, middlewares, billingLimiter }) {
  if (!controller)  throw new Error('createCotizadorLibreRouter: controller required');
  if (!middlewares) throw new Error('createCotizadorLibreRouter: middlewares required');
  const { verificarJWT, requerirPermiso } = middlewares;

  const router = express.Router();

  router.post('/cotizador-libre/pdf',
    verificarJWT,
    requerirPermiso(PERMISO),
    ...(billingLimiter ? [billingLimiter] : []),
    controller.postPdf,
  );

  router.get('/cotizador-libre/drafts',
    verificarJWT,
    requerirPermiso(PERMISO),
    controller.listDrafts,
  );

  router.get('/cotizador-libre/draft/:numero',
    verificarJWT,
    requerirPermiso(PERMISO),
    controller.getDraft,
  );

  router.put('/cotizador-libre/draft',
    verificarJWT,
    requerirPermiso(PERMISO),
    ...(billingLimiter ? [billingLimiter] : []),
    controller.upsertDraft,
  );

  router.delete('/cotizador-libre/draft/:numero',
    verificarJWT,
    requerirPermiso(PERMISO),
    controller.deleteDraft,
  );

  return router;
}

module.exports = createCotizadorLibreRouter;
module.exports.PERMISO = PERMISO;
