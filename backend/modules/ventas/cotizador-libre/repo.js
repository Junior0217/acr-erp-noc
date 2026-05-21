/**
 * backend/modules/ventas/cotizador-libre/repo.js
 *
 * Único punto donde se llama a `prisma.cotizacionLibreDraft.*`. Encapsula:
 *   - findOne                    — por (numeroDocumento, empleadoId?)
 *   - list                       — por empleadoId? + limit + include empleado
 *   - upsertByEmpleadoYNumero    — atomic via UNIQUE(empleadoId, numeroDocumento)
 *   - deleteByEmpleadoYNumero    — soft-target: filtra siempre por empleadoId
 *
 * Ciclo 13: las funciones aceptan `empleadoId` opcional para soportar el modo
 * global del Owner / Socios. Cuando NO se pasa, la consulta NO filtra por
 * empleado y devuelve drafts cross-user (con join al empleado para mostrar
 * el dueño en UI). El service decide cuándo invocar el modo global; el repo
 * solo expone la primitiva.
 *
 * Factory: createCotizadorLibreRepo(prisma)
 */

function createCotizadorLibreRepo(prisma) {
  if (!prisma) throw new Error('createCotizadorLibreRepo: prisma required');

  /**
   * findOne — si empleadoId está presente, usa el UNIQUE compuesto (rápido).
   * Si NO se pasa (modo global), busca por numeroDocumento únicamente. Como
   * el constraint UNIQUE es (empleadoId, numeroDocumento), varios empleados
   * podrían tener "COT-123" — devolvemos el más recientemente actualizado.
   */
  async function findOne({ numeroDocumento, empleadoId = null } = {}) {
    if (empleadoId != null) {
      return prisma.cotizacionLibreDraft.findUnique({
        where: { empleadoId_numeroDocumento: { empleadoId, numeroDocumento } },
        include: { empleado: { select: { id: true, nombre: true, cargo: true } } },
      });
    }
    // Modo global: sin filtro de empleado. Devolvemos el más reciente.
    return prisma.cotizacionLibreDraft.findFirst({
      where:   { numeroDocumento },
      orderBy: { updatedAt: 'desc' },
      include: { empleado: { select: { id: true, nombre: true, cargo: true } } },
    });
  }

  /**
   * list — devuelve un resumen ligero (sin items/condiciones) para el panel
   * de "mis drafts" o "drafts de todos" según se pase empleadoId o no.
   * Limita el take para evitar payload masivo (defaults sane).
   */
  async function list({ empleadoId = null, limit = 50 } = {}) {
    const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    return prisma.cotizacionLibreDraft.findMany({
      where:   empleadoId != null ? { empleadoId } : {},
      orderBy: { updatedAt: 'desc' },
      take,
      // Resumen ligero — items / condiciones se cargan aparte con findOne.
      // Nota: NO incluimos `items` para evitar transportar fotos en el listado.
      select: {
        id:               true,
        empleadoId:       true,
        numeroDocumento:  true,
        updatedAt:        true,
        createdAt:        true,
        cliente:          true,
        meta:             true,
        empleado:         { select: { id: true, nombre: true, cargo: true } },
      },
    });
  }

  /**
   * Upsert idempotente. Si el draft (empleadoId, numeroDocumento) existe, se
   * actualiza; si no, se crea. Postgres garantiza atomicidad via la constraint
   * UNIQUE — dos PUT concurrentes con el mismo key no duplican filas.
   *
   * empleadoId aquí ES el dueño del draft (puede ser distinto al requester
   * cuando un usuario global sobreescribe el borrador de otro técnico).
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
    findOne,
    list,
    upsertByEmpleadoYNumero,
    deleteByEmpleadoYNumero,
  };
}

module.exports = createCotizadorLibreRepo;
