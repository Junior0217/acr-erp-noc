/**
 * backend/shared/services/owner-alerts.service.js
 *
 * Mejora #5 — Owner God-Mode Alerts.
 *
 * Publica notificaciones críticas al dueño en dos canales:
 *   1. SSE in-app (clientes conectados al stream)
 *   2. Webhook outbound HMAC-firmado (opcional, env-driven)
 *
 * Eventos típicos (registro `tipo`):
 *   - 'factura.anulada'         — factura DGII anulada
 *   - 'nc.emitida'              — NC B04 emitida
 *   - 'nd.emitida'              — ND B03 emitida
 *   - 'precio.modificado'       — Producto.precio cambió
 *   - 'descuento.alto'          — descuento PIN >= umbral (default 20%)
 *   - 'stock.ajustado_manual'   — ajuste manual de inventario
 *   - 'login.sospechoso'        — login desde IP/UA nuevos
 *   - 'pin.bloqueado'           — rate-limit PIN supervisor disparado
 *
 * Severity: 'info' | 'warn' | 'critical' (default 'warn').
 *
 * Factory: createOwnerAlertsService({ prisma })
 *
 * Cyber Neo:
 *   - Webhook firmado: HMAC-SHA256(secret, `${ts}.${rawBody}`). El receiver
 *     debe verificar `X-OwnerAlert-Sig` y `X-OwnerAlert-Ts` con ventana
 *     de 5 min para prevenir replay.
 *   - NO incluir password/hash/token en payload. El service NO valida —
 *     responsabilidad del caller (igual que auditReq).
 *   - Webhook timeout 3s, no bloquea el flujo principal (fire-and-forget
 *     con catch).
 *   - SSE subscribers: cap 50 conexiones simultáneas para evitar
 *     resource exhaustion.
 */

const crypto = require('crypto');

const TIPOS_VALIDOS = new Set([
  'factura.anulada',
  'nc.emitida',
  'nd.emitida',
  'precio.modificado',
  'descuento.alto',
  'stock.ajustado_manual',
  'login.sospechoso',
  'pin.bloqueado',
]);

const SEVERIDADES = new Set(['info', 'warn', 'critical']);

class OwnerAlertsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createOwnerAlertsService({ prisma }) {
  if (!prisma) throw new Error('createOwnerAlertsService: prisma required');

  // ─── SSE subscribers ─────────────────────────────────────────────────────
  // Map<subId, { res, userSub, addedAt }>. Limita conexiones por proceso.
  const _subs = new Map();
  const _MAX_SUBS = 50;
  let _subSeq = 0;

  function subscribe(res, userSub) {
    if (_subs.size >= _MAX_SUBS) {
      throw new OwnerAlertsError(503, 'TOO_MANY_SUBS',
        `Cap de ${_MAX_SUBS} subscribers SSE alcanzado. Espera unos segundos.`);
    }
    const id = ++_subSeq;
    _subs.set(id, { res, userSub, addedAt: Date.now() });
    return () => _subs.delete(id);
  }

  function _broadcast(payload) {
    if (_subs.size === 0) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const [id, sub] of _subs) {
      try { sub.res.write(data); }
      catch { _subs.delete(id); }
    }
  }

  // ─── Webhook outbound ─────────────────────────────────────────────────────
  const _WEBHOOK_URL    = process.env.OWNER_ALERT_WEBHOOK_URL ?? '';
  const _WEBHOOK_SECRET = process.env.OWNER_ALERT_WEBHOOK_SECRET ?? '';
  const _WEBHOOK_TIMEOUT_MS = Number(process.env.OWNER_ALERT_WEBHOOK_TIMEOUT_MS ?? 3000);

  async function _sendWebhook(alertRow) {
    if (!_WEBHOOK_URL) return;
    const ts  = Date.now().toString();
    const raw = JSON.stringify({
      id:        alertRow.id,
      tipo:      alertRow.tipo,
      severity:  alertRow.severity,
      empleadoNombre: alertRow.empleadoNombre,
      resourceType: alertRow.resourceType,
      resourceId:   alertRow.resourceId,
      payload:   alertRow.payload,
      createdAt: alertRow.createdAt,
      ts,
    });
    const sig = _WEBHOOK_SECRET
      ? crypto.createHmac('sha256', _WEBHOOK_SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex')
      : '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), _WEBHOOK_TIMEOUT_MS);
      await fetch(_WEBHOOK_URL, {
        method:  'POST',
        signal:  ctrl.signal,
        headers: {
          'content-type':         'application/json',
          'x-owneralert-ts':      ts,
          'x-owneralert-sig':     sig,
          'x-owneralert-version': '1',
        },
        body: raw,
      });
      clearTimeout(t);
    } catch (e) {
      // Fire-and-forget. NO propaga el error al flujo principal.
      console.warn('[OWNER-ALERT] webhook failed:', e.message);
    }
  }

  // ─── Emisión principal ────────────────────────────────────────────────────
  /**
   * Persiste + broadcast + webhook. Idempotency es responsabilidad del caller.
   *
   * @param {object} args
   * @param {string} args.tipo               Uno de TIPOS_VALIDOS.
   * @param {'info'|'warn'|'critical'} [args.severity='warn']
   * @param {object} args.payload            JSON libre con detalle del evento.
   * @param {string} [args.resourceType]
   * @param {string} [args.resourceId]
   * @param {object} [args.user]             req.user (para empleadoId/nombre).
   * @param {object} [args.reqMeta]          { ip, ua }
   */
  async function emit(args) {
    const {
      tipo, severity = 'warn', payload,
      resourceType = null, resourceId = null,
      user, reqMeta,
    } = args ?? {};

    if (!TIPOS_VALIDOS.has(tipo)) {
      throw new OwnerAlertsError(400, 'BAD_TIPO',
        `tipo "${tipo}" no es válido. Permitidos: ${[...TIPOS_VALIDOS].join(', ')}.`);
    }
    if (!SEVERIDADES.has(severity)) {
      throw new OwnerAlertsError(400, 'BAD_SEVERITY',
        `severity "${severity}" inválida. Permitidas: info|warn|critical.`);
    }
    if (!payload || typeof payload !== 'object') {
      throw new OwnerAlertsError(400, 'BAD_PAYLOAD', 'payload debe ser un objeto.');
    }

    const ip = reqMeta?.ip ? String(reqMeta.ip).slice(0, 64) : null;
    const ua = reqMeta?.ua ? String(reqMeta.ua).slice(0, 200) : null;
    const empleadoNombre = user?.nombre ?? user?.name ?? null;
    const empleadoId     = user?.sub ?? null;

    const row = await prisma.ownerAlert.create({
      data: {
        tipo,
        severity,
        empleadoId,
        empleadoNombre: empleadoNombre ? String(empleadoNombre).slice(0, 120) : null,
        resourceType:   resourceType ? String(resourceType).slice(0, 60) : null,
        resourceId:     resourceId   ? String(resourceId).slice(0, 64)  : null,
        payload,
        ip,
        ua,
      },
    });

    // SSE broadcast + webhook outbound (ambos best-effort, no awaitea webhook).
    _broadcast({
      id:          row.id,
      tipo:        row.tipo,
      severity:    row.severity,
      empleadoNombre: row.empleadoNombre,
      resourceType:   row.resourceType,
      resourceId:     row.resourceId,
      payload:     row.payload,
      createdAt:   row.createdAt,
    });
    _sendWebhook(row).catch(() => {});

    return row;
  }

  /**
   * Wrapper "no-throw" — el caller pasa contexto y nunca quiere que un fallo
   * de alerta tumbe el flujo de venta/anulación. Uso típico inline:
   *   ownerAlerts.tryEmit({ tipo: 'factura.anulada', ... });
   */
  function tryEmit(args) {
    return emit(args).catch(e => {
      console.warn('[OWNER-ALERT] emit fallo silencioso:', e.message);
      return null;
    });
  }

  async function listAlerts({ tipo, severity, unreadOnly, limit = 50, offset = 0 }) {
    const where = {};
    if (tipo)       where.tipo     = tipo;
    if (severity)   where.severity = severity;
    if (unreadOnly) where.ackAt    = null;
    const [data, total] = await Promise.all([
      prisma.ownerAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    Math.min(Math.max(parseInt(limit) || 50, 1), 200),
        skip:    Math.max(parseInt(offset) || 0, 0),
      }),
      prisma.ownerAlert.count({ where }),
    ]);
    return { data, total };
  }

  async function ackAlert(id, userSub) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new OwnerAlertsError(400, 'BAD_ID', 'id inválido.');
    }
    return prisma.ownerAlert.update({
      where: { id },
      data:  { ackBy: userSub ?? null, ackAt: new Date() },
    });
  }

  function stats() {
    return {
      subscribers: _subs.size,
      maxSubscribers: _MAX_SUBS,
      webhookEnabled: !!_WEBHOOK_URL,
      webhookSigned:  !!_WEBHOOK_SECRET,
      tiposValidos:   [...TIPOS_VALIDOS],
    };
  }

  return {
    OwnerAlertsError,
    TIPOS_VALIDOS:  [...TIPOS_VALIDOS],
    emit,
    tryEmit,
    subscribe,
    listAlerts,
    ackAlert,
    stats,
  };
}

module.exports = createOwnerAlertsService;
module.exports.OwnerAlertsError = OwnerAlertsError;
