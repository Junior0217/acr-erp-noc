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

  /**
   * findEmpresaPerfil — singleton id=1. Lo usa el render PDF para heredar el
   * logo, RNC corporativo, eslogan, dirección, teléfono, etc. del template
   * oficial de Facturas/Cotizaciones. Si no existe, el caller debe degradar
   * a defaults hardcodeados (sin logo).
   */
  async function findEmpresaPerfil() {
    return prisma.empresaPerfil.findFirst();
  }

  /**
   * findByVerifyHash — lookup público para el endpoint /api/publico/verify/:hash.
   * El hash se persiste en `meta.verifyHash` (JSONB) tras cada render de PDF.
   * Como el campo no está indexado, usamos un filtro raw con `path:` de Postgres.
   * Para volúmenes <10K drafts es aceptable; con más debería añadirse índice
   * GIN parcial `WHERE meta ? 'verifyHash'`.
   */
  async function findByVerifyHash(hash) {
    if (!hash) return null;
    return prisma.cotizacionLibreDraft.findFirst({
      where:  { meta: { path: ['verifyHash'], equals: hash } },
      include: { empleado: { select: { id: true, nombre: true, cargo: true } } },
    });
  }

  /**
   * getStats — agregaciones del cotizador libre para panel admin.
   * Solo Owner / global permission accede. Devuelve:
   *   - totalDrafts
   *   - porEstado: { [Borrador, Enviada, Aprobada, Convertida, Perdida]: count }
   *   - porEmpleado: top 10 técnicos por cantidad de drafts
   *   - drafterMasAntiguo: { updatedAt, numeroDocumento } del más viejo en
   *     Borrador (señal "se quedó dormido — seguimiento sugerido").
   *
   * Usa el índice GIN sobre meta para que `meta.estado=X` sea index scan.
   */
  async function getStats() {
    const all = await prisma.cotizacionLibreDraft.findMany({
      select: {
        id:              true,
        empleadoId:      true,
        numeroDocumento: true,
        updatedAt:       true,
        createdAt:       true,
        meta:            true,
        empleado:        { select: { id: true, nombre: true } },
      },
    });

    const totalDrafts = all.length;
    const porEstado = { Borrador: 0, Enviada: 0, Aprobada: 0, Convertida: 0, Perdida: 0 };
    const porEmpleadoMap = new Map();
    let drafterMasAntiguo = null;

    for (const d of all) {
      const estado = (d.meta && typeof d.meta === 'object' && d.meta.estado) || 'Borrador';
      if (porEstado[estado] != null) porEstado[estado]++;

      const empKey = `${d.empleadoId}|${d.empleado?.nombre ?? '—'}`;
      porEmpleadoMap.set(empKey, (porEmpleadoMap.get(empKey) ?? 0) + 1);

      if (estado === 'Borrador') {
        if (!drafterMasAntiguo || d.updatedAt < drafterMasAntiguo.updatedAt) {
          drafterMasAntiguo = {
            id: d.id,
            empleadoId: d.empleadoId,
            empleadoNombre: d.empleado?.nombre ?? null,
            numeroDocumento: d.numeroDocumento,
            updatedAt: d.updatedAt,
            createdAt: d.createdAt,
            diasInactividad: Math.floor((Date.now() - d.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
          };
        }
      }
    }

    const porEmpleado = [...porEmpleadoMap.entries()]
      .map(([k, count]) => {
        const [empleadoId, nombre] = k.split('|');
        return { empleadoId: Number(empleadoId), nombre, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalDrafts,
      porEstado,
      porEmpleado,
      drafterMasAntiguo,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    findOne,
    list,
    upsertByEmpleadoYNumero,
    deleteByEmpleadoYNumero,
    findEmpresaPerfil,
    findByVerifyHash,
    getStats,
  };
}

module.exports = createCotizadorLibreRepo;
