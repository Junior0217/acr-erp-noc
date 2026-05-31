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
    // 1) Conteo total — query indexado, <5ms aún con 100K+ drafts.
    const totalDrafts = await prisma.cotizacionLibreDraft.count();

    // 2) GroupBy por empleadoId — Postgres usa el índice secundario sobre
    // empleadoId. Limita a top 10 directo en la query (orderBy + take).
    const porEmpleadoRaw = await prisma.cotizacionLibreDraft.groupBy({
      by:       ['empleadoId'],
      _count:   { _all: true },
      orderBy:  { _count: { empleadoId: 'desc' } },
      take:     10,
    });
    const empIds = porEmpleadoRaw.map(r => r.empleadoId);
    const empleados = empIds.length
      ? await prisma.empleado.findMany({
          where:  { id: { in: empIds } },
          select: { id: true, nombre: true },
        })
      : [];
    const empMap = new Map(empleados.map(e => [e.id, e.nombre]));
    const porEmpleado = porEmpleadoRaw.map(r => ({
      empleadoId: r.empleadoId,
      nombre:     empMap.get(r.empleadoId) ?? `Empl. #${r.empleadoId}`,
      count:      r._count?._all ?? 0,
    }));

    // 3) Por estado: GROUP BY raw sobre meta->>'estado' — Postgres agrega del
    //    lado del servidor (usa el índice de expresión meta_estado_idx) en vez
    //    de transportar TODAS las filas a memoria y agrupar en JS. COUNT(*)::int
    //    evita BigInt. estado NULL/'' → 'Borrador' (semántica histórica).
    const porEstadoRows = await prisma.$queryRaw`
      SELECT "meta"->>'estado' AS estado, COUNT(*)::int AS count
      FROM "CotizacionLibreDraft"
      GROUP BY "meta"->>'estado'
    `;
    const porEstado = { Borrador: 0, Enviada: 0, Aprobada: 0, Convertida: 0, Perdida: 0 };
    for (const row of porEstadoRows) {
      const estado = row.estado || 'Borrador';
      if (porEstado[estado] != null) porEstado[estado] += Number(row.count);
    }

    // 4) Drafter más antiguo en Borrador: 1 fila vía ORDER BY updatedAt ASC
    //    LIMIT 1 (índice meta_estado_idx + updatedAt). estado NULL = Borrador.
    const oldestRows = await prisma.$queryRaw`
      SELECT "id", "empleadoId", "numeroDocumento", "updatedAt", "createdAt"
      FROM "CotizacionLibreDraft"
      WHERE COALESCE("meta"->>'estado', 'Borrador') = 'Borrador'
      ORDER BY "updatedAt" ASC
      LIMIT 1
    `;
    let drafterMasAntiguo = null;
    if (oldestRows.length) {
      const d = oldestRows[0];
      drafterMasAntiguo = {
        id:              d.id,
        empleadoId:      d.empleadoId,
        empleadoNombre:  empMap.get(d.empleadoId) ?? null,
        numeroDocumento: d.numeroDocumento,
        updatedAt:       d.updatedAt,
        createdAt:       d.createdAt,
        diasInactividad: Math.floor((Date.now() - new Date(d.updatedAt).getTime()) / (1000 * 60 * 60 * 24)),
      };
    }

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
