/**
 * backend/routes/inventario.js
 *
 * Inventario router: productos, categorías, kardex (movimientos),
 * préstamos de equipos, upload de imágenes.
 */

const express = require('express');

function createInventarioRouter(deps) {
  const router = express.Router();
  // const { prisma, middlewares, schemas, auditReq } = deps;
  // const { verificarJWT, requerirPermiso } = middlewares;
  // const { prestamoSchema } = schemas;

  router.get('/_meta/inventario-router', (req, res) => res.json({ ok: true, router: 'inventario', migrated: 0 }));

  return router;
}

module.exports = createInventarioRouter;
