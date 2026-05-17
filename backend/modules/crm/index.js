/**
 * backend/modules/crm/index.js
 *
 * Parent factory del modulo crm. Wiring puro — sin lógica HTTP.
 * Monta sub-routers DDD por sub-dominio.
 */

const express = require('express');

const createClientesRouter = require('./clientes/router');
const createSuplidoresRouter = require('./suplidores/router');
const createProspectosRouter = require('./prospectos/router');
const createPortalB2cRouter = require('./portal-b2c/router');
const createUsuariosPortalRouter = require('./usuarios-portal/router');
const createCredencialesRouter = require('./credenciales/router');
const createActivosRouter = require('./activos/router');

function createCrmRouter(deps) {
  const router = express.Router();

  router.use('/', createClientesRouter(deps));
  router.use('/', createSuplidoresRouter(deps));
  router.use('/', createProspectosRouter(deps));
  router.use('/', createPortalB2cRouter(deps));
  router.use('/', createUsuariosPortalRouter(deps));
  router.use('/', createCredencialesRouter(deps));
  router.use('/', createActivosRouter(deps));

  return router;
}

module.exports = createCrmRouter;
