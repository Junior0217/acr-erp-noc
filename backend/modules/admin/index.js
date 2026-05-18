/**
 * backend/modules/admin/index.js
 *
 * Parent factory del modulo admin. Wiring puro — sin lógica HTTP.
 * Monta sub-routers DDD por sub-dominio.
 */

const express = require('express');

const createRrhhRouter         = require('./rrhh/router');
const createRolesRouter        = require('./roles/router');
const createEmpresaRouter      = require('./empresa/router');
const createOpsRouter          = require('./ops/router');
const createReportesRouter     = require('./reportes/router');
const createNcfAdminRouter     = require('./empresa/ncf/router');
const createOwnerAlertsRouter  = require('./owner-alerts/router');

function createAdminRouter(deps) {
  const router = express.Router();

  router.use('/', createRrhhRouter(deps));
  router.use('/', createRolesRouter(deps));
  router.use('/', createEmpresaRouter(deps));
  router.use('/', createOpsRouter(deps));
  router.use('/', createReportesRouter(deps));
  // NCF config: sub-módulo de empresa (Fase 2.3). Antes vivía en ventas/ncf/
  // — error conceptual: la config de secuencias NCF es dato de empresa, no
  // operativo de ventas. El allocator atómico vive en
  // shared/services/ncf.service.js — este sub-router solo expone /ncf-config.
  router.use('/', createNcfAdminRouter(deps));
  // Mejora #5 — Owner God-Mode Alerts (SSE + webhook). Solo sistema:owner.
  router.use('/', createOwnerAlertsRouter(deps));

  return router;
}

module.exports = createAdminRouter;
