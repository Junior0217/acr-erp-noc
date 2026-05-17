/**
 * backend/modules/admin/index.js
 *
 * Parent factory del modulo admin. Wiring puro — sin lógica HTTP.
 * Monta sub-routers DDD por sub-dominio.
 */

const express = require('express');

const createRrhhRouter = require('./rrhh/router');
const createRolesRouter = require('./roles/router');
const createEmpresaRouter = require('./empresa/router');
const createOpsRouter = require('./ops/router');
const createReportesRouter = require('./reportes/router');

function createAdminRouter(deps) {
  const router = express.Router();

  router.use('/', createRrhhRouter(deps));
  router.use('/', createRolesRouter(deps));
  router.use('/', createEmpresaRouter(deps));
  router.use('/', createOpsRouter(deps));
  router.use('/', createReportesRouter(deps));

  return router;
}

module.exports = createAdminRouter;
