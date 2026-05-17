/**
 * backend/routes/ventas.js
 *
 * Ventas router: facturas, cotizaciones, NCF config, POS, carrito,
 * órdenes de trabajo (OT), órdenes de instalación, taller (RMA), planes,
 * catálogo interno, notas de crédito/débito, bulk PDF.
 */

const express = require('express');

function createVentasRouter(deps) {
  const router = express.Router();
  // const { prisma, middlewares, schemas, auditReq, limiters } = deps;
  // const { verificarJWT, requerirPermiso, requerirNivel } = middlewares;
  // const { billingLimiter, uploadLimiter, uploadMulter } = limiters;
  // const { ticketTallerSchema, ticketEstadoSchema, ordenFotoSchema } = schemas;

  router.get('/_meta/ventas-router', (req, res) => res.json({ ok: true, router: 'ventas', migrated: 0 }));

  return router;
}

module.exports = createVentasRouter;
