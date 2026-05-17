/**
 * backend/modules/ventas/catalogo/repo.js
 *
 * Capa de datos del módulo Catálogo (Items, Planes, Productos directos,
 * Búsqueda unificada, Bundles, Portal catalog).
 */

function createCatalogoRepo(prisma) {
  if (!prisma) throw new Error('createCatalogoRepo: prisma required');

  // ─── Búsqueda unificada ─────────────────────────────────────────────────
  async function buscarItemCatalogos({ q, onlyActivos, limit }) {
    return prisma.itemCatalogo.findMany({
      where: {
        ...(onlyActivos ? { activo: true } : {}),
        ...(q ? { OR: [
          { nombre:      { contains: q, mode: 'insensitive' } },
          { codigo:      { contains: q, mode: 'insensitive' } },
          { descripcion: { contains: q, mode: 'insensitive' } },
        ] } : {}),
      },
      take: limit,
      orderBy: [{ tipoItem: 'asc' }, { nombre: 'asc' }],
      include: { producto: { select: { id: true, sku: true, stockActual: true, imagenUrl: true } } },
    });
  }

  async function buscarProductos({ q, onlyActivos, limit }) {
    return prisma.producto.findMany({
      where: {
        ...(q ? { OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { sku:    { contains: q, mode: 'insensitive' } },
        ] } : {}),
        itemsCatalogo: { none: onlyActivos ? { activo: true } : {} },
      },
      take: limit,
      orderBy: { nombre: 'asc' },
      select: { id: true, sku: true, nombre: true, descripcion: true, precio: true, stockActual: true, tipoItem: true, imagenUrl: true },
    });
  }

  async function buscarPlanes({ q, onlyActivos, limit }) {
    return prisma.plan.findMany({
      where: {
        ...(onlyActivos ? { activo: true } : {}),
        ...(q ? { OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { sku:    { contains: q, mode: 'insensitive' } },
        ] } : {}),
      },
      take: limit,
      orderBy: { nombre: 'asc' },
      select: { id: true, sku: true, nombre: true, tipo: true, precioMensualBase: true, activo: true },
    });
  }

  // ─── Catálogo CRUD ──────────────────────────────────────────────────────
  async function listItemCatalogos(where) {
    return prisma.itemCatalogo.findMany({
      where,
      orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
      include: { producto: { select: { id: true, sku: true, stockActual: true, stockMinimo: true, imagenUrl: true, descripcion: true } } },
    });
  }

  async function findReservasGrouped(productoIds) {
    if (!productoIds?.length) return [];
    return prisma.reservaInventario.groupBy({
      by:   ['productoId'],
      _sum: { cantidad: true },
      where:{ productoId: { in: productoIds }, liberada: false, expiraEn: { gt: new Date() } },
    });
  }

  async function findLastCodigoForTipo(prefijo) {
    return prisma.itemCatalogo.findFirst({
      where:   { codigo: { startsWith: `${prefijo}-` } },
      orderBy: { codigo: 'desc' },
      select:  { codigo: true },
    });
  }

  async function createItemCatalogo(data) {
    return prisma.itemCatalogo.create({ data });
  }

  async function findItemCatalogoCosto(id) {
    return prisma.itemCatalogo.findUnique({ where: { id }, select: { costo: true } });
  }

  async function updateItemCatalogo(id, data) {
    return prisma.itemCatalogo.update({ where: { id }, data });
  }

  async function countLineasOTUsing(itemCatalogoId) {
    return prisma.lineaOrdenTrabajo.count({ where: { itemCatalogoId } });
  }

  async function deleteItemCatalogo(id) {
    return prisma.itemCatalogo.delete({ where: { id } });
  }

  // ─── Planes ─────────────────────────────────────────────────────────────
  async function listPlanes({ where, skip, take }) {
    return Promise.all([
      prisma.plan.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } },
      }),
      prisma.plan.count({ where }),
    ]);
  }

  async function findPlanById(id) {
    return prisma.plan.findUnique({
      where:   { id },
      include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true, stockActual: true } } } } },
    });
  }

  async function createPlanTx(tx, data) {
    return tx.plan.create({
      data,
      include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } },
    });
  }

  async function updatePlanTx(tx, id, data, reemplazarEquipos) {
    if (reemplazarEquipos !== undefined) {
      await tx.plantillaEquipo.deleteMany({ where: { planId: id } });
      if (reemplazarEquipos.length > 0) {
        await tx.plantillaEquipo.createMany({ data: reemplazarEquipos.map(e => ({ ...e, planId: id })) });
      }
    }
    return tx.plan.update({
      where: { id }, data,
      include: { plantillaEquipos: { include: { producto: { select: { id: true, nombre: true, sku: true } } } } },
    });
  }

  async function findPlanLight(id) {
    return prisma.plan.findUnique({ where: { id } });
  }

  async function togglePlanActivo(id, activo) {
    return prisma.plan.update({ where: { id }, data: { activo } });
  }

  // ─── Catálogo público + portal ──────────────────────────────────────────
  async function listCatalogoPublico() {
    return prisma.itemCatalogo.findMany({
      where:  { activo: true, tipoItem: 'SERVICIO', categoria: { not: 'WISP' } },
      select: { id: true, nombre: true, descripcion: true, categoria: true, tipo: true },
      orderBy:{ categoria: 'asc' },
    });
  }

  async function listCatalogoPortal() {
    return prisma.itemCatalogo.findMany({
      where:  { activo: true, tipoItem: 'SERVICIO', categoria: { not: 'WISP' } },
      select: { id: true, nombre: true, descripcion: true, categoria: true, tipo: true, precio: true },
      orderBy:{ categoria: 'asc' },
    });
  }

  // ─── Bundles cross-sell ─────────────────────────────────────────────────
  async function findBundlesPorProducto(productoId) {
    return prisma.productoBundle.findMany({
      where:   { padreId: productoId },
      orderBy: { score: 'desc' },
      include: { hijo: { select: { id: true, sku: true, nombre: true, precio: true, stockActual: true, imagenUrl: true } } },
      take:    8,
    });
  }

  async function findItemCatalogoForBundles(id) {
    return prisma.itemCatalogo.findUnique({
      where:  { id },
      select: { productoId: true },
    });
  }

  return {
    buscarItemCatalogos, buscarProductos, buscarPlanes,
    listItemCatalogos, findReservasGrouped, findLastCodigoForTipo,
    createItemCatalogo, findItemCatalogoCosto, updateItemCatalogo,
    countLineasOTUsing, deleteItemCatalogo,
    listPlanes, findPlanById, createPlanTx, updatePlanTx, findPlanLight, togglePlanActivo,
    listCatalogoPublico, listCatalogoPortal,
    findBundlesPorProducto, findItemCatalogoForBundles,
  };
}

module.exports = createCatalogoRepo;
