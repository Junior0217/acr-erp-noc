/**
 * backend/modules/admin/owner-alerts/controller.js
 *
 * Controllers thin: delega al shared service `ownerAlerts`.
 */

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function createOwnerAlertsController({ ownerAlerts }) {
  if (!ownerAlerts) throw new Error('createOwnerAlertsController: ownerAlerts required');

  async function list(req, res) {
    try {
      const { tipo, severity, unread, limit, offset } = req.query;
      const out = await ownerAlerts.listAlerts({
        tipo:       tipo ? String(tipo) : undefined,
        severity:   severity ? String(severity) : undefined,
        unreadOnly: unread === '1' || unread === 'true',
        limit:      limit ? Number(limit) : 50,
        offset:     offset ? Number(offset) : 0,
      });
      res.status(200).json(out);
    } catch (e) {
      console.error('[OWNER-ALERT] list error:', e.message);
      res.status(e.status ?? 500).json({ error: e.message ?? 'Error al listar alertas.' });
    }
  }

  async function stats(req, res) {
    try {
      const [unread, last24h] = await Promise.all([
        ownerAlerts.listAlerts({ unreadOnly: true, limit: 1 }).then(r => r.total),
        ownerAlerts.listAlerts({ limit: 1 }).then(r => r.total), // total general
      ]);
      const svc = ownerAlerts.stats?.() ?? {};
      res.status(200).json({ unread, total: last24h, service: svc });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }

  async function ack(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'id inválido.' });
      }
      const userSub = req.user?.sub ?? null;
      const updated = await ownerAlerts.ackAlert(id, userSub);
      res.status(200).json(updated);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  }

  /**
   * SSE stream — el owner se conecta y recibe cada alerta nueva en vivo.
   * Mantiene la conexión abierta hasta que el cliente cierra. Heartbeat
   * cada 30s para detectar conexión muerta.
   */
  function stream(req, res) {
    req.socket?.setTimeout(0);
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders?.();

    // Envía estado inicial.
    res.write(`event: ready\ndata: ${JSON.stringify({ connected: true, ts: Date.now() })}\n\n`);

    let unsubscribe;
    try {
      unsubscribe = ownerAlerts.subscribe(res, req.user?.sub ?? null);
    } catch (e) {
      return res.status(e.status ?? 503).end();
    }

    // Heartbeat cada 30s para evitar timeouts intermedios (proxies).
    const hb = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); }
      catch { clearInterval(hb); }
    }, 30 * 1000);

    function cleanup() {
      clearInterval(hb);
      try { unsubscribe?.(); } catch {}
      try { res.end(); } catch {}
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  return { list, stats, ack, stream };
}

module.exports = createOwnerAlertsController;
