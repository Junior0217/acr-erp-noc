/**
 * backend/modules/ventas/index.js
 *
 * Parent factory del modulo Ventas. Wiring puro — NO contiene logica HTTP.
 */

const express = require('express');

const createCotizacionesRouter = require('./cotizaciones/router');
const createFacturasRouter     = require('./facturas/router');
const createPosRouter          = require('./pos/router');
const createCarritoRouter      = require('./carrito/router');
const createOrdenesRouter      = require('./ordenes/router');
const createTallerRouter       = require('./taller/router');
const createCatalogoRouter     = require('./catalogo/router');
// ncf/ MIGRADO a admin/empresa/ncf/ (Fase 2.3) — config NCF es dominio empresa,
// no ventas. El allocator atómico vive en shared/services/ncf.service.js.

function createVentasRouter(deps) {
  const router = express.Router();

  // PDF module (Blueprint Fase 1.3): construido en server.js y pasado via
  // deps.pdfModule = { router, service }. service se inyecta a cron + lib.
  // Esto evita que pdf se instancie dos veces (server.js lo necesita para el
  // handler legacy /facturas/:id/condiciones que sigue inline).
  const pdfModule  = deps.pdfModule;
  if (!pdfModule || !pdfModule.router || !pdfModule.service) {
    throw new Error('createVentasRouter: deps.pdfModule { router, service } requerido');
  }
  const subDepsWithPdf = { ...deps, pdfService: pdfModule.service };

  const lib = require('./_lib')(subDepsWithPdf);
  require('./_cron')(subDepsWithPdf, lib);

  const subDeps = { ...subDepsWithPdf, ...lib };

  router.use('/', pdfModule.router);
  router.use('/', createCotizacionesRouter(subDeps));
  router.use('/', createFacturasRouter(subDeps));
  router.use('/', createPosRouter(subDeps));
  router.use('/', createCarritoRouter(subDeps));
  router.use('/', createOrdenesRouter(subDeps));
  router.use('/', createTallerRouter(subDeps));
  router.use('/', createCatalogoRouter(subDeps));

  // Misc: health detallado (legacy, sin sub-dominio claro)
  // ─── Health detallado (requiere HEALTH_TOKEN) ────────────────────────────────
  // /api/health (sin auth) está registrado arriba del rate-limiter para Render.
  
  router.get('/health/detailed', async (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '')
    if (process.env.HEALTH_TOKEN && token !== process.env.HEALTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized.' })
    }
    const t0 = Date.now()
    let dbOk = false, dbMs = null
    try { await prisma.$queryRaw`SELECT 1`; dbMs = Date.now() - t0; dbOk = true } catch {}
    const mem = process.memoryUsage()
    const status = dbOk ? 'ok' : 'degraded'
    res.status(dbOk ? 200 : 503).json({
      status,
      timestamp:  new Date().toISOString(),
      uptime:     Math.floor(process.uptime()),
      commit:     process.env.RENDER_GIT_COMMIT ?? 'local',
      node:       process.version,
      env:        process.env.NODE_ENV ?? 'development',
      db:         { ok: dbOk, latencyMs: dbMs },
      redis:      redisClient ? (redisClient.status === 'ready' ? 'connected' : redisClient.status) : 'not configured',
      memory: {
        rss:       Math.round(mem.rss       / 1048576) + 'MB',
        heapUsed:  Math.round(mem.heapUsed  / 1048576) + 'MB',
        heapTotal: Math.round(mem.heapTotal / 1048576) + 'MB',
      },
    })
  })
  

  return router;
}

module.exports = createVentasRouter;
