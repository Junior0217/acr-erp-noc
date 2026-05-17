/**
 * backend/shared/services/audit.service.js
 *
 * AuditLog inmutable con hash-chain HMAC-SHA256. Cualquier mutación post-facto
 * rompe la cadena y queda visible en /api/auditoria/log/verify.
 *
 * Factory: createAuditService({ prisma }) -> { _canonicalizarLog, appendAuditLog, auditReq }
 *
 * Diseño:
 * - prisma debe ser la instancia extendida que bloquea mutaciones ORM sobre AuditLog
 *   (definida en server.js). El service no asume nada sobre el wrapper.
 * - AUDIT_SECRET se resuelve por env en CADA append; rotar el secret no exige reinicio.
 * - auditReq es fire-and-forget vía setImmediate: nunca bloquea la respuesta HTTP.
 */

const crypto = require('crypto');

function _canonicalizarLog(row) {
  const meta = row.meta ?? null;
  const safe = {
    evento:    row.evento ?? '',
    usuarioId: row.usuarioId ?? null,
    userName:  row.userName ?? '',
    ip:        row.ip ?? null,
    ua:        row.ua ?? null,
    meta:      meta == null ? null : (typeof meta === 'string' ? meta : JSON.stringify(meta, Object.keys(meta).sort())),
    creadoEn:  row.creadoEn ? new Date(row.creadoEn).toISOString() : new Date().toISOString(),
  };
  return JSON.stringify(safe, Object.keys(safe).sort());
}

function _resolveAuditSecret() {
  return process.env.AUDIT_SECRET
      ?? process.env.JWT_SECRET
      ?? 'change-me-audit-secret';
}

function createAuditService({ prisma }) {
  if (!prisma) throw new Error('createAuditService: prisma is required');

  async function appendAuditLog(data) {
    const SECRET = _resolveAuditSecret();
    const last = await prisma.auditLog.findFirst({
      where:   { hash: { not: null } },
      orderBy: { id: 'desc' },
      select:  { hash: true },
    });
    const prevHash = last?.hash ?? 'GENESIS';
    const creadoEn = data.creadoEn ?? new Date();
    const payload  = _canonicalizarLog({ ...data, creadoEn });
    const hash     = crypto.createHmac('sha256', SECRET).update(payload + '|' + prevHash).digest('hex');
    return prisma.auditLog.create({ data: { ...data, prevHash, hash } });
  }

  function auditReq(evento, req, meta, overrides) {
    const ip       = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;
    const ua       = req?.headers?.['user-agent'] || null;
    const userId   = overrides?.userId   ?? req?.user?.sub    ?? null;
    const userName = overrides?.userName ?? req?.user?.nombre ?? null;
    setImmediate(async () => {
      try { await appendAuditLog({ evento, usuarioId: userId, userName, ip, ua, meta: meta ?? undefined }); } catch {}
    });
  }

  return { _canonicalizarLog, appendAuditLog, auditReq };
}

module.exports = createAuditService;
module.exports._canonicalizarLog = _canonicalizarLog;
