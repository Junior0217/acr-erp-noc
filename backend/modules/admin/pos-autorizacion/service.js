/**
 * backend/modules/admin/pos-autorizacion/service.js
 *
 * Dos canales de bypass del POS (alternativos al PIN supervisor):
 *
 *   1) TOTP — el supervisor presente físicamente teclea el código de 6
 *      dígitos generado por su app Authenticator. El secret vive cifrado
 *      en Empleado.twoFactorSecret (descifrado on-the-fly por decryptTOTP).
 *      Requiere que el usuario autenticado tenga 2FA habilitado.
 *
 *   2) Webhook remoto — el cajero pide aprobación al owner via webhook
 *      externo. El backend:
 *        a) Genera challengeId UUID + payload firmado HMAC-SHA256 con
 *           AUDIT_SECRET sobre `${challengeId}|${ts}|${ip}|${ua}`.
 *        b) POST async a OWNER_ALERT_WEBHOOK_URL (env). Fire-and-forget.
 *        c) Guarda el challenge en Map in-memory con TTL 5 min.
 *        d) Recipient (owner) responde POST /approve con HMAC sobre
 *           `${challengeId}|${decision}` — verificado timing-safe.
 *        e) Frontend hace polling GET /status hasta approved/rejected/expired.
 *
 *   AuditReq queda en cada verificación (success + failure) para forensia.
 */

const crypto = require('crypto');
const { authenticator } = require('otplib');
const { decryptTOTP } = require('../../../shared/jwt-crypto');

class PosAutorizacionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

const WEBHOOK_TTL_MS         = 5 * 60 * 1000;
const WEBHOOK_GC_INTERVAL_MS = 60 * 1000;

function _fakeReqForAudit(reqMeta, user) {
  return {
    headers: {
      'x-forwarded-for': reqMeta?.ip ?? null,
      'user-agent':      reqMeta?.ua ?? null,
    },
    socket: { remoteAddress: reqMeta?.ip ?? null },
    user:   user ?? null,
  };
}

function _hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function _timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function createPosAutorizacionService(deps) {
  const { repo, auditReq } = deps;
  if (!repo)                          throw new Error('createPosAutorizacionService: repo required');
  if (typeof auditReq !== 'function') throw new Error('createPosAutorizacionService: auditReq required');

  // ─── State in-memory (process-local — Render single-instance OK) ───────────
  const _challenges = new Map();
  const _gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, ch] of _challenges) {
      if (now - ch.createdAt > WEBHOOK_TTL_MS) {
        _challenges.delete(id);
      }
    }
  }, WEBHOOK_GC_INTERVAL_MS);
  // Permite que Node cierre el proceso si el server termina — no bloquea exit.
  if (_gcTimer.unref) _gcTimer.unref();

  // ─── TOTP ──────────────────────────────────────────────────────────────────
  async function verifyTotp({ token }, user, reqMeta) {
    if (!user?.id) throw new PosAutorizacionError(401, 'NO_AUTH', 'Sesión no autenticada.');
    const emp = await repo.findEmpleadoTwoFactor(Number(user.id));
    if (!emp) {
      throw new PosAutorizacionError(404, 'EMPLEADO_NOT_FOUND', 'Empleado no encontrado.');
    }
    if (!emp.twoFactorEnabled || !emp.twoFactorSecret) {
      throw new PosAutorizacionError(409, 'TOTP_NO_DISPONIBLE',
        'Tu cuenta no tiene 2FA habilitado. Configúralo en Mi Empresa o usa otro canal (PIN / Webhook).');
    }
    let secret;
    try { secret = decryptTOTP(emp.twoFactorSecret); }
    catch {
      throw new PosAutorizacionError(500, 'TOTP_DECRYPT_FAIL',
        'No se pudo descifrar el secret TOTP (ENC_KEY desalineado?). Reporta al admin.');
    }
    const ok = authenticator.check(token, secret);
    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:   ok ? 'pos:autorizacion_totp_ok' : 'pos:autorizacion_totp_fail',
      tabla:    'Empleado',
      registroId: String(user.id),
      detalles: { canal: 'totp' },
    });
    if (!ok) {
      throw new PosAutorizacionError(401, 'TOTP_INVALIDO', 'Token TOTP inválido o expirado.');
    }
    return { valid: true, canal: 'totp', empleadoId: emp.id };
  }

  // ─── Webhook ───────────────────────────────────────────────────────────────
  async function requestWebhook({ motivo }, user, reqMeta) {
    const url = process.env.OWNER_ALERT_WEBHOOK_URL;
    if (!url) {
      throw new PosAutorizacionError(503, 'WEBHOOK_NO_CONFIGURADO',
        'OWNER_ALERT_WEBHOOK_URL no configurado en el ambiente.');
    }
    const secret = process.env.AUDIT_SECRET;
    if (!secret) {
      throw new PosAutorizacionError(503, 'AUDIT_SECRET_NO_CONFIGURADO', 'AUDIT_SECRET requerido.');
    }
    const challengeId = crypto.randomUUID();
    const ts          = Date.now();
    const ip          = reqMeta?.ip ?? '';
    const ua          = (reqMeta?.ua ?? '').slice(0, 200);
    const empleadoId  = String(user?.id ?? '');
    const empleado    = String(user?.email ?? user?.nombre ?? '');
    const reason      = (motivo ?? '').slice(0, 200);
    const baseline    = `${challengeId}|${ts}|${ip}|${ua}|${empleadoId}|${reason}`;
    const signature   = _hmac(baseline, secret);

    _challenges.set(challengeId, {
      status:     'pending',
      decision:   null,
      createdAt:  ts,
      ip, ua, empleadoId, empleado, motivo: reason,
    });

    // Fire-and-forget POST. Si falla, marcamos el challenge como bloqueado
    // pero el frontend igual hará polling — el operador verá el estado.
    const payload = JSON.stringify({
      challengeId, ts, ip, ua, empleadoId, empleado, motivo: reason, signature,
      // El recipient debe responder POST a /api/pos/authorize-webhook/:id/approve
      // con su propia firma HMAC sobre `${challengeId}|${decision}` y AUDIT_SECRET.
      approveEndpoint: `/api/pos/authorize-webhook/${challengeId}/approve`,
    });
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
    }).then(async (res) => {
      if (!res.ok) {
        const ch = _challenges.get(challengeId);
        if (ch) ch.status = 'webhook_unreachable';
      }
    }).catch(() => {
      const ch = _challenges.get(challengeId);
      if (ch) ch.status = 'webhook_unreachable';
    });

    await auditReq(_fakeReqForAudit(reqMeta, user), {
      accion:     'pos:autorizacion_webhook_request',
      tabla:      'Empleado',
      registroId: empleadoId,
      detalles:   { challengeId, motivo: reason },
    });

    return { challengeId, ttlMs: WEBHOOK_TTL_MS, status: 'pending' };
  }

  // PÚBLICO: el endpoint /approve no exige JWT — la autorización viene por
  // la firma HMAC del payload. Sí valida ip/ua para forensia.
  async function approveWebhook({ challengeId, signature, decision }, reqMeta) {
    const ch = _challenges.get(challengeId);
    if (!ch) {
      throw new PosAutorizacionError(404, 'CHALLENGE_NOT_FOUND',
        'Challenge no encontrado o expirado. Pide al cajero generar uno nuevo.');
    }
    if (Date.now() - ch.createdAt > WEBHOOK_TTL_MS) {
      ch.status = 'expired';
      throw new PosAutorizacionError(410, 'CHALLENGE_EXPIRED', 'Challenge expirado (>5 min).');
    }
    if (ch.status !== 'pending' && ch.status !== 'webhook_unreachable') {
      throw new PosAutorizacionError(409, 'CHALLENGE_USED',
        `Challenge ya resuelto previamente (estado=${ch.status}).`);
    }
    const secret   = process.env.AUDIT_SECRET;
    const baseline = `${challengeId}|${decision}`;
    const expected = _hmac(baseline, secret);
    if (!_timingSafeHexEqual(expected, signature)) {
      // Cuenta el intento — pero NO revela el motivo del rechazo para no
      // facilitar oracle attacks.
      throw new PosAutorizacionError(401, 'SIGNATURE_INVALID', 'Firma HMAC inválida.');
    }
    ch.status   = decision;
    ch.decision = decision;
    ch.decidedAt = Date.now();
    ch.decidedFromIp = reqMeta?.ip ?? null;

    await auditReq(_fakeReqForAudit(reqMeta, { id: ch.empleadoId, email: ch.empleado }), {
      accion:     decision === 'approved'
        ? 'pos:autorizacion_webhook_approved'
        : 'pos:autorizacion_webhook_rejected',
      tabla:      'Empleado',
      registroId: String(ch.empleadoId ?? ''),
      detalles:   { challengeId, decision, fromIp: reqMeta?.ip ?? null },
    });
    return { ok: true, status: ch.status };
  }

  async function statusWebhook({ challengeId }, user) {
    const ch = _challenges.get(challengeId);
    if (!ch) {
      return { status: 'not_found' };
    }
    if (Date.now() - ch.createdAt > WEBHOOK_TTL_MS && ch.status === 'pending') {
      ch.status = 'expired';
    }
    // Aislamiento simple: solo el empleado que generó el challenge puede
    // consultar su estado (evita enumeration cross-empleado).
    if (String(user?.id ?? '') !== String(ch.empleadoId ?? '')) {
      return { status: 'forbidden' };
    }
    return {
      status:      ch.status,
      decision:    ch.decision,
      createdAt:   ch.createdAt,
      ttlMs:       WEBHOOK_TTL_MS,
      remainingMs: Math.max(0, WEBHOOK_TTL_MS - (Date.now() - ch.createdAt)),
    };
  }

  return {
    PosAutorizacionError,
    verifyTotp,
    requestWebhook,
    approveWebhook,
    statusWebhook,
    // Test hooks
    _challenges,
  };
}

module.exports = createPosAutorizacionService;
module.exports.PosAutorizacionError = PosAutorizacionError;
