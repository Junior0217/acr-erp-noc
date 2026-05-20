/**
 * backend/modules/admin/pos-autorizacion/repo.js
 *
 * Único punto Prisma del módulo. Lee el secret TOTP del empleado autenticado
 * para validarlo en el service. El secret viaja cifrado (decryptTOTP en
 * shared/jwt-crypto) — el repo solo devuelve el ciphertext.
 */

function createPosAutorizacionRepo(prisma) {
  if (!prisma) throw new Error('createPosAutorizacionRepo: prisma required');

  async function findEmpleadoTwoFactor(empleadoId) {
    return prisma.empleado.findUnique({
      where:  { id: empleadoId },
      select: { id: true, nombre: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
  }

  return { findEmpleadoTwoFactor };
}

module.exports = createPosAutorizacionRepo;
