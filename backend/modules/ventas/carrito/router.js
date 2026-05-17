/**
 * backend/modules/ventas/carrito/router.js
 *
 * Blueprint 5-file MVC. Inyecta deps de ventas/_lib (formatCarrito,
 * procesarFacturaPOS, persistirVerifyHash).
 */

const express = require('express');
const createCarritoRepo       = require('./repo');
const createCarritoService    = require('./service');
const createCarritoController = require('./controller');
const carritoSchemas          = require('./schema');

function createCarritoRouter(deps) {
  const {
    prisma, auditReq, middlewares, limiters,
    formatCarrito, persistirVerifyHash,
  } = deps;
  // procesarFacturaPOS es opcional — si no se inyecta, /carrito/checkout devuelve 503.
  const procesarFacturaPOS = typeof deps.procesarFacturaPOS === 'function' ? deps.procesarFacturaPOS : null;
  if (!prisma)                                       throw new Error('createCarritoRouter: prisma required');
  if (!middlewares)                                  throw new Error('createCarritoRouter: middlewares required');
  if (typeof auditReq !== 'function')                throw new Error('createCarritoRouter: auditReq required');
  if (typeof formatCarrito !== 'function')           throw new Error('createCarritoRouter: formatCarrito required (inject from ventas/_lib)');
  if (typeof persistirVerifyHash !== 'function')     throw new Error('createCarritoRouter: persistirVerifyHash required');

  const { verificarJWT, requerirPermiso } = middlewares;
  const { billingLimiter } = limiters || {};

  const repo       = createCarritoRepo(prisma);
  const service    = createCarritoService({ repo, auditReq, formatCarrito, procesarFacturaPOS, persistirVerifyHash });
  const controller = createCarritoController({ service, schemas: carritoSchemas });

  const router = express.Router();

  router.get('/carrito',                       verificarJWT, controller.get);
  router.patch('/carrito',                     verificarJWT, controller.patch);
  router.post('/carrito/item',                 verificarJWT, controller.addItem);
  router.patch('/carrito/item/:lineaId',       verificarJWT, controller.updateItem);
  router.delete('/carrito/item/:lineaId',      verificarJWT, controller.removeItem);
  router.delete('/carrito',                    verificarJWT, controller.clear);
  router.post('/carrito/checkout',             verificarJWT,
                                               ...(billingLimiter ? [billingLimiter] : []),
                                               requerirPermiso('factura:emitir'),
                                               controller.checkout);

  return router;
}

module.exports = createCarritoRouter;
