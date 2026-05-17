/**
 * backend/modules/inventario/index.js
 *
 * Orquestador del módulo Inventario. Compone:
 *   - Router principal (categorias, productos, movimientos, prestamos)
 *   - Sub-módulo uploads/ (upload-image, upload-url)
 *
 * Devuelve un Router único para montar bajo /api en server.js.
 * No contiene handlers ni schemas — solo composición.
 */

const express = require('express');
const createInventarioMainRouter = require('./router');
const createUploadsRouter        = require('./uploads/router');

function createInventarioRouter(deps) {
  const router = express.Router();
  router.use(createInventarioMainRouter(deps));
  router.use(createUploadsRouter(deps));
  return router;
}

module.exports = createInventarioRouter;
