/**
 * backend/modules/ventas/cotizador-libre/router.js
 *
 * Rutas HTTP del Cotizador Libre:
 *   POST   /api/ventas/cotizador-libre/pdf            → genera PDF on-demand.
 *   GET    /api/ventas/cotizador-libre/whoami         → flags de scope (isGlobal).
 *   GET    /api/ventas/cotizador-libre/drafts         → lista (mis o todos según permiso).
 *   GET    /api/ventas/cotizador-libre/draft/:n       → carga un draft específico.
 *   PUT    /api/ventas/cotizador-libre/draft          → upsert idempotente (auto-save).
 *   DELETE /api/ventas/cotizador-libre/draft/:n       → borra un draft.
 *
 * Ciclo 13 — permisos por capas:
 *   - `cotizador_libre_manual`     (legacy, alias de ventas:cotizador_libre)
 *   - `ventas:cotizador_libre`     base: solo sus propios borradores.
 *   - `ventas:cotizador_libre_global` supervisor: ver/editar drafts de cualquiera.
 *   - `sistema:owner`              short-circuit en requerirPermiso.
 *
 * El router solo valida que el caller tenga AL MENOS UNO de los tres permisos
 * (cualquiera abre la puerta). La distinción `mine` vs `global` la hace el
 * controller con `_isGlobalCaller(req)` — server-side, fail-closed.
 *
 * Rate-limit: billingLimiter compartido (cross-pod Redis). Aplica al PDF y al
 * upsert (auto-save) — los GET no se rate-limitean para no bloquear el monitoreo
 * en vivo del Owner mientras Cristian guarda.
 *
 * Factory: createCotizadorLibreRouter({ controller, middlewares, billingLimiter })
 */

const express = require('express');

// Permisos aceptados — cualquiera de estos abre el módulo. La discriminación
// entre acceso "mis drafts" vs "drafts de cualquier técnico" se hace en el
// controller (`_isGlobalCaller`), no aquí. Aquí solo: ¿puede entrar al panel?
const PERMISOS_ACEPTADOS = [
  'ventas:cotizador_libre',
  'ventas:cotizador_libre_global',
  'cotizador_libre_manual',
];

function _requerirAlguno(permisosOk) {
  return (req, res, next) => {
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : [];
    if (permisos.includes('sistema:owner')) return next();
    if (permisos.some((p) => permisosOk.includes(p))) return next();
    return res.status(403).json({ error: 'Sin permiso para esta acción.' });
  };
}

function createCotizadorLibreRouter({ controller, middlewares, billingLimiter }) {
  if (!controller)  throw new Error('createCotizadorLibreRouter: controller required');
  if (!middlewares) throw new Error('createCotizadorLibreRouter: middlewares required');
  const { verificarJWT } = middlewares;

  const router = express.Router();
  const requerirCotizadorLibre = _requerirAlguno(PERMISOS_ACEPTADOS);

  router.post('/cotizador-libre/pdf',
    verificarJWT,
    requerirCotizadorLibre,
    ...(billingLimiter ? [billingLimiter] : []),
    controller.postPdf,
  );

  router.get('/cotizador-libre/whoami',
    verificarJWT,
    requerirCotizadorLibre,
    controller.whoami,
  );

  // Stats: solo permiso supervisor o sistema:owner. El service rechaza si
  // isGlobal=false (fail-closed). Útil para panel admin del Owner.
  router.get('/cotizador-libre/stats',
    verificarJWT,
    requerirCotizadorLibre,
    controller.getStats,
  );

  router.get('/cotizador-libre/drafts',
    verificarJWT,
    requerirCotizadorLibre,
    controller.listDrafts,
  );

  router.get('/cotizador-libre/draft/:numero',
    verificarJWT,
    requerirCotizadorLibre,
    controller.getDraft,
  );

  router.put('/cotizador-libre/draft',
    verificarJWT,
    requerirCotizadorLibre,
    ...(billingLimiter ? [billingLimiter] : []),
    controller.upsertDraft,
  );

  router.delete('/cotizador-libre/draft/:numero',
    verificarJWT,
    requerirCotizadorLibre,
    controller.deleteDraft,
  );

  return router;
}

module.exports = createCotizadorLibreRouter;
module.exports.PERMISOS_ACEPTADOS = PERMISOS_ACEPTADOS;
