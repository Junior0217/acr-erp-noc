/**
 * backend/modules/admin/preferencias-pos/repo.js
 *
 * Único punto Prisma del módulo. Upsert porque la tabla es 1:1 con Empleado.
 */

const DEFAULTS = {
  mostrarValidez:   true,
  mostrarFormaPago: true,
  mostrarEntrega:   true,
  mostrarGarantia:  true,
  mostrarNotas:     false,
};

function createPreferenciasPosRepo(prisma) {
  if (!prisma) throw new Error('createPreferenciasPosRepo: prisma required');

  async function obtener(empleadoId) {
    const row = await prisma.usuarioPreferenciasPOS.findUnique({
      where: { empleadoId },
    });
    return row || { empleadoId, ...DEFAULTS, updatedAt: null };
  }

  async function upsert(empleadoId, data) {
    return prisma.usuarioPreferenciasPOS.upsert({
      where:  { empleadoId },
      create: { empleadoId, ...DEFAULTS, ...data },
      update: data,
    });
  }

  return { obtener, upsert, DEFAULTS };
}

module.exports = createPreferenciasPosRepo;
