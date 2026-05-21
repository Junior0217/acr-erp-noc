/**
 * backend/modules/ventas/cotizador-libre/repo.js
 *
 * Único punto donde se llama a `prisma.cotizacionLibreDraft.*`. Encapsula:
 *   - findByEmpleadoYNumero
 *   - listByEmpleado (paginado + ordenado por updatedAt DESC)
 *   - upsertByEmpleadoYNumero (atomic: race-safe)
 *   - deleteByEmpleadoYNumero
 *
 * No conoce HTTP, no valida shape — eso vive en service.js + schema.js. Solo
 * habla SQL via Prisma.
 *
 * Factory: createCotizadorLibreRepo(prisma)
 */

function createCotizadorLibreRepo(prisma) {
  if (!prisma) throw new Error('createCotizadorLibreRepo: prisma required');

  async function findByEmpleadoYNumero(empleadoId, numeroDocumento) {
    return prisma.cotizacionLibreDraft.findUnique({
      where: { empleadoId_numeroDocumento: { empleadoId, numeroDocumento } },
    });
  }

  /**
   * Lista los drafts más recientes del empleado. Limitado para evitar payload
   * masivo si un usuario acumuló 500+ drafts en años de uso.
   */
  async function listByEmpleado(empleadoId, { limit = 50 } = {}) {
    const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    return prisma.cotizacionLibreDraft.findMany({
      where:   { empleadoId },
      orderBy: { updatedAt: 'desc' },
      take,
      // Resumen ligero — el cuerpo (items/cliente) se carga aparte con findUnique.
      select: {
        id: true, numeroDocumento: true, updatedAt: true, createdAt: true,
        cliente: true, meta: true,
      },
    });
  }

  /**
   * Upsert idempotente. Si el draft (empleadoId, numeroDocumento) existe, se
   * actualiza; si no, se crea. Postgres garantiza atomicidad via la constraint
   * UNIQUE — dos PUT concurrentes con el mismo key no duplican filas.
   */
  async function upsertByEmpleadoYNumero(empleadoId, numeroDocumento, data) {
    return prisma.cotizacionLibreDraft.upsert({
      where:  { empleadoId_numeroDocumento: { empleadoId, numeroDocumento } },
      create: {
        empleadoId,
        numeroDocumento,
        cliente:     data.cliente,
        items:       data.items,
        condiciones: data.condiciones,
        meta:        data.meta ?? null,
      },
      update: {
        cliente:     data.cliente,
        items:       data.items,
        condiciones: data.condiciones,
        meta:        data.meta ?? null,
      },
    });
  }

  async function deleteByEmpleadoYNumero(empleadoId, numeroDocumento) {
    return prisma.cotizacionLibreDraft.deleteMany({
      where: { empleadoId, numeroDocumento },
    });
  }

  return {
    findByEmpleadoYNumero,
    listByEmpleado,
    upsertByEmpleadoYNumero,
    deleteByEmpleadoYNumero,
  };
}

module.exports = createCotizadorLibreRepo;
