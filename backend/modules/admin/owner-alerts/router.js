/**
 * backend/modules/admin/owner-alerts/router.js
 *
 * Rutas HTTP para Owner God-Mode Alerts. CERO lógica.
 *
 * Endpoints:
 *   GET    /owner-alerts            list paginado (filtros: tipo, severity, unread)
 *   GET    /owner-alerts/stream     SSE en tiempo real
 *   POST   /owner-alerts/:id/ack    marcar como leída
 *   GET    /owner-alerts/stats      contadores (unread, last24h)
 *
 * Solo accesible para `sistema:owner` (rol fundador). Resto del staff NO ve
 * estas alertas para evitar que un cajero comprometido detecte que su
 * comportamiento se está monitoreando.
 */

const express = require('express');
const createController = require('./controller');

function createOwnerAlertsRouter(deps) {
  const { middlewares, ownerAlerts } = deps;
  if (!middlewares) throw new Error('createOwnerAlertsRouter: middlewares required');
  if (!ownerAlerts) throw new Error('createOwnerAlertsRouter: ownerAlerts service required');

  const { verificarJWT, requerirPermiso } = middlewares;

  const ctrl = createController({ ownerAlerts });

  const router = express.Router();

  router.get('/owner-alerts',           verificarJWT, requerirPermiso('sistema:owner'), ctrl.list);
  router.get('/owner-alerts/stats',     verificarJWT, requerirPermiso('sistema:owner'), ctrl.stats);
  router.get('/owner-alerts/stream',    verificarJWT, requerirPermiso('sistema:owner'), ctrl.stream);
  router.post('/owner-alerts/:id/ack',  verificarJWT, requerirPermiso('sistema:owner'), ctrl.ack);

  return router;
}

module.exports = createOwnerAlertsRouter;
