/**
 * backend/modules/dgii/index.js
 *
 * Parent factory del módulo DGII (Fase 3). Wiring puro — sin lógica HTTP.
 * F1 monta el sub-router de Compras. F2/F3 añadirán los sub-routers de
 * generación 606/607 cuando se implementen.
 */

const createDgiiRouter = require('./router');

module.exports = createDgiiRouter;
