/**
 * backend/modules/auth/repo.js
 *
 * Capa de acceso a datos del módulo Auth. Único punto donde se llama a
 * prisma.<model>.<method>() para entidades relacionadas con autenticación.
 *
 * Factory: createAuthRepo(prisma) -> { ...funciones nombradas y testeables }
 *
 * Reglas:
 * - Funciones puras de I/O: NO valida, NO formatea, NO audita.
 * - Encapsula filtros, includes, soft-delete y paginación.
 * - Transacciones cuando hay invariantes cross-row (rotación de sesión, consumo
 *   de backup code, cambio de password con revocación masiva).
 */

const bcrypt = require('bcryptjs');

function createAuthRepo(prisma) {
  if (!prisma) throw new Error('createAuthRepo: prisma is required');

  // ─── Empleado ────────────────────────────────────────────────────────────
  async function findEmpleadoByEmailWithActiveRoles(email) {
    return prisma.empleado.findUnique({
      where:   { email },
      include: { roles: { where: { activo: true } } },
    });
  }

  async function findEmpleadoByIdForMe(id) {
    return prisma.empleado.findUnique({
      where:  { id },
      select: {
        twoFactorEnabled: true,
        backupCodes:      true,
        roles:            { where: { activo: true }, select: { nivel: true } },
        _count:           { select: { webauthnCredentials: true } },
      },
    });
  }

  async function findEmpleadoForRefresh(id) {
    return prisma.empleado.findUnique({
      where:   { id },
      include: { roles: { where: { activo: true }, select: { permisos: true } } },
    });
  }

  async function findEmpleadoByIdWithActiveRoles(id) {
    return prisma.empleado.findUnique({
      where:   { id },
      include: { roles: { where: { activo: true } } },
    });
  }

  async function findEmpleadoTwoFactorState(id) {
    return prisma.empleado.findUnique({
      where:  { id },
      select: { twoFactorSecret: true, twoFactorEnabled: true },
    });
  }

  async function findEmpleadoBackupCodesOnly(id) {
    return prisma.empleado.findUnique({
      where:  { id },
      select: { backupCodes: true },
    });
  }

  async function findEmpleadoPasswordHashOnly(id) {
    return prisma.empleado.findUnique({
      where:  { id },
      select: { passwordHash: true },
    });
  }

  async function setEmpleadoTwoFactorSecret(id, encryptedSecret) {
    return prisma.empleado.update({
      where: { id },
      data:  { twoFactorSecret: encryptedSecret },
    });
  }

  async function setEmpleadoTwoFactorEnabled(id, hashedBackupCodes) {
    return prisma.empleado.update({
      where: { id },
      data:  { twoFactorEnabled: true, backupCodes: hashedBackupCodes },
    });
  }

  async function setEmpleadoBackupCodes(id, hashedBackupCodes) {
    return prisma.empleado.update({
      where: { id },
      data:  { backupCodes: hashedBackupCodes },
    });
  }

  async function disableEmpleadoTwoFactor(id) {
    return prisma.empleado.update({
      where: { id },
      data:  { twoFactorEnabled: false, twoFactorSecret: null },
    });
  }

  /**
   * Cambio de password + revocación de sesiones distintas a la actual.
   * Atómico: si una falla, ambas se reversan.
   */
  async function updatePasswordAndRevokeOtherSessions(empleadoId, newHash, currentJti) {
    return prisma.$transaction([
      prisma.empleado.update({
        where: { id: empleadoId },
        data:  { passwordHash: newHash },
      }),
      prisma.sessionToken.deleteMany({
        where: { empleadoId, NOT: { jti: currentJti } },
      }),
    ]);
  }

  /**
   * Consumo atómico de backup code. Serializable para que dos requests
   * concurrentes no puedan consumir el mismo código.
   */
  async function consumeBackupCodeTx(empleadoId, candidate) {
    if (!candidate) return false;
    const normalized = String(candidate).replace(/[-\s]/g, '').toUpperCase();
    return prisma.$transaction(async (tx) => {
      const emp = await tx.empleado.findUnique({ where: { id: empleadoId }, select: { backupCodes: true } });
      const codes = Array.isArray(emp?.backupCodes) ? emp.backupCodes : [];
      let matchIdx = -1;
      for (let i = 0; i < codes.length; i++) {
        const ok = await bcrypt.compare(normalized, codes[i]);
        if (ok && matchIdx === -1) matchIdx = i;
      }
      if (matchIdx === -1) return false;
      const next = [...codes.slice(0, matchIdx), ...codes.slice(matchIdx + 1)];
      await tx.empleado.update({ where: { id: empleadoId }, data: { backupCodes: next } });
      return true;
    }, { isolationLevel: 'Serializable', timeout: 8000 }).catch(e => {
      console.warn('[consumeBackupCodeTx]', e.code, e.message);
      return false;
    });
  }

  // ─── SessionToken ────────────────────────────────────────────────────────
  async function findSessionByJti(jti) {
    return prisma.sessionToken.findUnique({ where: { jti } });
  }

  async function findActiveSessionsByEmpleado(empleadoId) {
    return prisma.sessionToken.findMany({
      where:   { empleadoId, expiresAt: { gt: new Date() } },
      select:  { jti: true, userAgent: true, createdAt: true, expiresAt: true, ip: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function createSessionToken(data) {
    return prisma.sessionToken.create({ data });
  }

  async function deleteSessionByJti(jti) {
    return prisma.sessionToken.delete({ where: { jti } });
  }

  async function deleteSessionsByJtiAndEmpleado(jti, empleadoId) {
    return prisma.sessionToken.deleteMany({ where: { jti } }).then(async (r) => {
      if (r.count === 0) return r;
      return r;
    });
  }

  async function deleteOtherSessionsByEmpleado(empleadoId, exceptJti) {
    return prisma.sessionToken.deleteMany({
      where: { empleadoId, jti: { not: exceptJti } },
    });
  }

  async function deleteSessionByJtiAll(jti) {
    return prisma.sessionToken.deleteMany({ where: { jti } });
  }

  /**
   * Rotación atómica de sesión (refresh): borra el JTI viejo y crea el nuevo
   * en una sola transacción.
   */
  async function rotateSession(oldJti, newSessionData) {
    return prisma.$transaction([
      prisma.sessionToken.delete({ where: { jti: oldJti } }),
      prisma.sessionToken.create({ data: newSessionData }),
    ]);
  }

  // ─── Audit lookups ───────────────────────────────────────────────────────
  async function findLastLoginAudit(empleadoId) {
    return prisma.auditLog.findFirst({
      where:   { evento: 'auth:login_success', usuarioId: empleadoId },
      orderBy: { creadoEn: 'desc' },
    });
  }

  // ─── Device fingerprint + alerta AuditCaja para login desde nuevo device ─
  async function findDeviceFingerprint(empleadoId, hash) {
    return prisma.deviceFingerprint.findUnique({
      where: { empleadoId_hash: { empleadoId, hash } },
    });
  }

  async function touchDeviceFingerprint(id, ip, userAgent) {
    return prisma.deviceFingerprint.update({
      where: { id },
      data:  { ultimoLogin: new Date(), ip, userAgent },
    });
  }

  async function createDeviceFingerprint(data) {
    return prisma.deviceFingerprint.create({ data });
  }

  async function createAuditCajaDeviceAlert(empleadoId, label, ip, ua) {
    return prisma.auditCaja.create({
      data: {
        tipo:    'device_nuevo',
        empleadoId,
        detalle: `Nuevo dispositivo: ${label} desde ${ip ?? 'IP desconocida'}`,
        ip,
        ua:      String(ua ?? '').slice(0, 200),
      },
    });
  }

  // ─── WebAuthn ────────────────────────────────────────────────────────────
  async function findEmpleadoWithWebauthnCredentials(empleadoId) {
    return prisma.empleado.findUnique({
      where:   { id: empleadoId },
      include: { webauthnCredentials: { select: { credentialId: true, transports: true } } },
    });
  }

  async function findEmpleadoByEmailWithWebauthnCredentials(email) {
    return prisma.empleado.findUnique({
      where:   { email },
      include: { webauthnCredentials: { select: { credentialId: true, transports: true } } },
    });
  }

  async function findWebauthnCredentialWithEmpleado(credentialId) {
    return prisma.webAuthnCredential.findUnique({
      where:   { credentialId },
      include: { empleado: { include: { roles: { where: { activo: true } } } } },
    });
  }

  async function createWebauthnCredential(data) {
    return prisma.webAuthnCredential.create({ data });
  }

  async function updateWebauthnCounter(id, counter) {
    return prisma.webAuthnCredential.update({
      where: { id },
      data:  { counter, lastUsedAt: new Date() },
    });
  }

  async function listWebauthnCredentialsByEmpleado(empleadoId) {
    return prisma.webAuthnCredential.findMany({
      where:   { empleadoId },
      select:  { id: true, deviceName: true, transports: true, backupEligible: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function deleteWebauthnCredentialOwnedBy(id, empleadoId) {
    return prisma.webAuthnCredential.deleteMany({
      where: { id, empleadoId },
    });
  }

  return {
    // empleado
    findEmpleadoByEmailWithActiveRoles,
    findEmpleadoByIdForMe,
    findEmpleadoForRefresh,
    findEmpleadoByIdWithActiveRoles,
    findEmpleadoTwoFactorState,
    findEmpleadoBackupCodesOnly,
    findEmpleadoPasswordHashOnly,
    setEmpleadoTwoFactorSecret,
    setEmpleadoTwoFactorEnabled,
    setEmpleadoBackupCodes,
    disableEmpleadoTwoFactor,
    updatePasswordAndRevokeOtherSessions,
    consumeBackupCodeTx,
    // sessionToken
    findSessionByJti,
    findActiveSessionsByEmpleado,
    createSessionToken,
    deleteSessionByJti,
    deleteSessionsByJtiAndEmpleado,
    deleteOtherSessionsByEmpleado,
    deleteSessionByJtiAll,
    rotateSession,
    // audit
    findLastLoginAudit,
    // device fingerprint
    findDeviceFingerprint,
    touchDeviceFingerprint,
    createDeviceFingerprint,
    createAuditCajaDeviceAlert,
    // webauthn
    findEmpleadoWithWebauthnCredentials,
    findEmpleadoByEmailWithWebauthnCredentials,
    findWebauthnCredentialWithEmpleado,
    createWebauthnCredential,
    updateWebauthnCounter,
    listWebauthnCredentialsByEmpleado,
    deleteWebauthnCredentialOwnedBy,
  };
}

module.exports = createAuthRepo;
