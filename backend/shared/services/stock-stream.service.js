/**
 * backend/shared/services/stock-stream.service.js
 *
 * Hub Server-Sent Events para difundir cambios de stock en caliente al POS.
 *
 * Patrón pub/sub trivial sin dependencias:
 *   - createStockStreamHub() → instancia singleton (1 por proceso).
 *   - hub.registerClient(req, res) → suscribe el res al canal SSE. Mantiene
 *     heartbeat cada 25s para que el proxy (Render) no corte la conexión.
 *   - hub.emit({ productoId, stockActual, [motivo] }) → emite el evento
 *     `stock-update` a TODOS los clientes conectados.
 *   - hub.broadcast(eventName, data) → forma genérica.
 *
 * Mejora #13. No usa Redis ni infra extra — funciona contained en single
 * proceso. Si en algún momento la app escala a multi-instance, este hub
 * se reemplaza por Pusher/Ably/Redis-Sub.
 *
 * Cyber Neo:
 *   - Cap MAX_CLIENTS=200 (proceso single — más es DoS).
 *   - Cap MAX_PER_USER=5 (evita user comprometido abriendo 100 streams).
 *   - Auth se valida ANTES de registerClient en el router.
 *   - Datos del evento: solo productoId + stockActual + motivo. CERO PII.
 */

const MAX_CLIENTS = 200;
const MAX_PER_USER = 5;
const HEARTBEAT_MS = 25_000;

function createStockStreamHub() {
  /** @type {Set<{res: any, userId: string|null, openedAt: number}>} */
  const clients = new Set();

  function _send(client, eventName, data) {
    try {
      const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
      client.res.write(payload);
    } catch {
      // res cerrado — clean up async.
      try { clients.delete(client); } catch {}
    }
  }

  function registerClient(req, res) {
    if (clients.size >= MAX_CLIENTS) {
      try { res.status(503).json({ error: 'SSE: límite global de clientes alcanzado.' }); } catch {}
      return null;
    }
    const userId = req.user?.sub ? String(req.user.sub) : null;
    if (userId) {
      let count = 0;
      for (const c of clients) if (c.userId === userId) count++;
      if (count >= MAX_PER_USER) {
        try { res.status(429).json({ error: 'SSE: demasiadas conexiones para tu usuario.' }); } catch {}
        return null;
      }
    }

    // Headers SSE. Render proxy respeta no-buffering si X-Accel-Buffering: no.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const client = { res, userId, openedAt: Date.now() };
    clients.add(client);

    // Saludo inicial — el frontend confirma conexión activa.
    _send(client, 'hello', { ts: Date.now(), clients: clients.size });

    // Heartbeat — evita timeouts de proxy / load balancer.
    const hb = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); }
      catch { clearInterval(hb); clients.delete(client); }
    }, HEARTBEAT_MS);

    // Cleanup al cerrar conexión (cliente cerró pestaña / red caída).
    function close() {
      clearInterval(hb);
      clients.delete(client);
      try { res.end(); } catch {}
    }
    req.on('close', close);
    req.on('aborted', close);
    return client;
  }

  function broadcast(eventName, data) {
    if (clients.size === 0) return 0;
    let delivered = 0;
    for (const c of clients) {
      _send(c, eventName, data);
      delivered++;
    }
    return delivered;
  }

  function emit({ productoId, stockActual, motivo = null }) {
    if (productoId == null) return;
    return broadcast('stock-update', {
      productoId: Number(productoId),
      stockActual: Number(stockActual),
      motivo,
      ts: Date.now(),
    });
  }

  function stats() {
    return { clients: clients.size };
  }

  return { registerClient, broadcast, emit, stats };
}

module.exports = createStockStreamHub;
