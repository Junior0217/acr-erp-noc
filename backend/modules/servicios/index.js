/**
 * backend/modules/servicios/index.js
 *
 * Parent factory del dominio Servicio Técnico (CCTV, impresoras,
 * servidores, PC, redes corporativas, cercos eléctricos, reparaciones
 * físicas). Wiring puro — compone sub-routers, NO contiene lógica HTTP.
 *
 * Foco exclusivo: soporte técnico físico. NO incluye contratos ISP
 * recurrentes (esos viven en modules/ventas/ordenes/ y servicios:ver
 * de "Servicios ISP").
 */

const express = require('express');

const createServiciosOrdenesRouter = require('./ordenes/router');

function createServiciosRouter(deps) {
  const router = express.Router();
  router.use('/', createServiciosOrdenesRouter(deps));
  return router;
}

module.exports = createServiciosRouter;
