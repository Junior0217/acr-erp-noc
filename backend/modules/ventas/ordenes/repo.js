/**
 * backend/modules/ventas/ordenes/repo.js
 *
 * Capa de acceso a datos del módulo Ordenes. Único punto que toca prisma
 * para OrdenTrabajo (OT), OrdenInstalacion (OI), Servicio, OrdenFoto,
 * ReservaInventario, MovimientoInventario, ActivoCliente.
 *
 * Factory: createOrdenesRepo(prisma)
 *
 * CRÍTICO — Cyber Neo:
 *   - Deducción de stock atómica vía UPDATE ... RETURNING (anti-sobreventa).
 *   - findOrdenFotoConOrden trae orden.estado/estaFacturada para que el
 *     service rechace deletes de fotos sobre OTs inmutables.
 */

function createOrdenesRepo(prisma) {
  if (!prisma) throw new Error('createOrdenesRepo: prisma required');

  // ─── OrdenTrabajo ────────────────────────────────────────────────────────
  async function listOrdenesTrabajo({ where, take, skip }) {
    return prisma.$transaction([
      prisma.ordenTrabajo.count({ where }),
      prisma.ordenTrabajo.findMany({
        where,
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true } },
          tecnico: { select: { id: true, nombre: true } },
          lineas:  { include: { itemCatalogo: { select: { id: true, nombre: true, tipo: true } } } },
          _count:  { select: { facturas: true } },
        },
        orderBy: { createdAt: 'desc' },
        take, skip,
      }),
    ]);
  }

  async function findOrdenTrabajoLightById(id) {
    return prisma.ordenTrabajo.findUnique({
      where:  { id },
      select: { id: true, estaFacturada: true, deletedAt: true },
    });
  }

  async function findOrdenTrabajoForEstadoChange(id) {
    return prisma.ordenTrabajo.findUnique({
      where:   { id },
      include: { lineas: { select: { productoId: true, cantidad: true } } },
    });
  }

  async function createOrdenTrabajoTx(tx, data) {
    return tx.ordenTrabajo.create({ data });
  }

  async function createLineasOTTx(tx, lineas) {
    if (!lineas?.length) return { count: 0 };
    return tx.lineaOrdenTrabajo.createMany({ data: lineas });
  }

  async function findOrdenTrabajoFullById(tx, id) {
    return tx.ordenTrabajo.findUnique({
      where: { id },
      include: {
        cliente:  { select: { id: true, razonSocial: true } },
        lineas:   { include: { itemCatalogo: { select: { nombre: true } } } },
        reservas: { select: { id: true, productoId: true, cantidad: true, expiraEn: true } },
      },
    });
  }

  async function softDeleteOrdenTrabajo(id) {
    return prisma.ordenTrabajo.update({
      where: { id },
      data:  { deletedAt: new Date() },
    });
  }

  async function updateOrdenTrabajoEstadoTx(tx, id, update) {
    return tx.ordenTrabajo.update({ where: { id }, data: update });
  }

  // ─── Reservas + Stock atómico (anti-sobreventa) ──────────────────────────
  async function findItemCatalogoForExpansion(tx, itemCatalogoId) {
    return tx.itemCatalogo.findUnique({
      where:   { id: itemCatalogoId },
      include: {
        componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
        producto:    { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
      },
    });
  }

  async function createReservasInventarioTx(tx, reservas) {
    if (!reservas?.length) return { count: 0 };
    return tx.reservaInventario.createMany({ data: reservas });
  }

  async function findReservasOTActivasTx(tx, ordenId) {
    return tx.reservaInventario.findMany({
      where: { ordenId, liberada: false },
    });
  }

  async function liberarReservasOTTx(tx, ordenId) {
    return tx.reservaInventario.deleteMany({
      where: { ordenId, liberada: false },
    });
  }

  async function deleteAllReservasOTTx(tx, ordenId) {
    return tx.reservaInventario.deleteMany({ where: { ordenId } });
  }

  /**
   * Decremento atómico de stock dentro de la transacción. Devuelve null si
   * no había suficiente (WHERE stockActual >= cant). El service decide
   * skip+audit (cierre OT) o throw (factura manual).
   */
  async function deducirStockAtomicoTx(tx, productoId, cantidad) {
    const rows = await tx.$queryRaw`
      UPDATE "Producto"
      SET    "stockActual" = "stockActual" - ${cantidad}
      WHERE  id = ${Number(productoId)} AND "stockActual" >= ${cantidad}
      RETURNING id, "stockActual"
    `;
    return rows && rows.length ? rows[0] : null;
  }

  async function crearKardexSalidaTx(tx, productoId, cantidad) {
    return tx.movimientoInventario.create({
      data: { productoId: Number(productoId), tipo: 'Salida', cantidad },
    });
  }

  async function crearAuditCajaStockDriftTx(tx, payload) {
    return tx.auditCaja.create({ data: payload });
  }

  async function crearActivoClienteTx(tx, data) {
    return tx.activoCliente.create({ data });
  }

  // ─── OrdenInstalacion (legacy /ordenes-instalacion) ──────────────────────
  const ordenIncludeOI = {
    servicio: {
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true } },
        plan:    { select: { nombre: true, tipo: true } },
      },
    },
    tecnico:  { select: { id: true, nombre: true, cargo: true } },
    detalles: { include: { producto: { select: { id: true, nombre: true, sku: true, stockActual: true } } } },
  };

  async function listOrdenesInstalacion({ where, skip, take }) {
    return Promise.all([
      prisma.ordenInstalacion.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: ordenIncludeOI }),
      prisma.ordenInstalacion.count({ where }),
    ]);
  }

  async function findOrdenInstalacionConDetalles(id) {
    return prisma.ordenInstalacion.findUnique({
      where:   { id },
      include: { detalles: true },
    });
  }

  async function createOrdenInstalacion(data) {
    return prisma.ordenInstalacion.create({ data, include: ordenIncludeOI });
  }

  async function updateOrdenInstalacionTx(tx, id, data, opts = {}) {
    const { reemplazarDetalles } = opts;
    if (reemplazarDetalles?.detalles !== undefined) {
      await tx.detalleOrden.deleteMany({ where: { ordenId: id } });
      if (reemplazarDetalles.detalles.length > 0) {
        await tx.detalleOrden.createMany({
          data: reemplazarDetalles.detalles.map(d => ({ ...d, ordenId: id })),
        });
      }
    }
    return tx.ordenInstalacion.update({ where: { id }, data, include: ordenIncludeOI });
  }

  async function updateServicioEstadoTx(tx, servicioId, estado) {
    return tx.servicio.update({ where: { id: servicioId }, data: { estado } });
  }

  async function findProductosForStock(ids) {
    if (!ids?.length) return [];
    return prisma.producto.findMany({
      where:  { id: { in: ids } },
      select: { id: true, nombre: true, stockActual: true },
    });
  }

  async function ajustarStockTx(tx, productoId, delta) {
    return tx.producto.update({
      where: { id: productoId },
      data:  { stockActual: { increment: delta } },
    });
  }

  async function crearMovimientoOITx(tx, productoId, tipo, cantidad, ordenInstalacionId) {
    return tx.movimientoInventario.create({
      data: { productoId, tipo, cantidad, ordenInstalacionId },
    });
  }

  async function updateOrdenInstalacionCompletadaTx(tx, id) {
    return tx.ordenInstalacion.update({
      where: { id },
      data:  { estado: 'Completada', completadaEn: new Date() },
      include: ordenIncludeOI,
    });
  }

  // ─── Servicio ────────────────────────────────────────────────────────────
  const servicioIncludeFull = {
    cliente: { select: { id: true, razonSocial: true, noCliente: true, telefonoPrincipal: true } },
    plan:    { select: { id: true, nombre: true, tipo: true } },
  };

  async function listServicios({ where, skip, take }) {
    return Promise.all([
      prisma.servicio.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: servicioIncludeFull }),
      prisma.servicio.count({ where }),
    ]);
  }

  async function createServicioTx(tx, data) {
    return tx.servicio.create({ data, include: servicioIncludeFull });
  }

  async function updateServicio(id, data) {
    return prisma.servicio.update({ where: { id }, data, include: servicioIncludeFull });
  }

  async function findServicioEstado(id) {
    return prisma.servicio.findUnique({
      where:  { id },
      select: { id: true, estado: true },
    });
  }

  async function updateServicioEstadoOnly(id, estado) {
    return prisma.servicio.update({ where: { id }, data: { estado } });
  }

  // ─── OrdenFoto ───────────────────────────────────────────────────────────
  async function listFotosOrden(ordenId) {
    return prisma.ordenFoto.findMany({
      where:   { ordenId },
      include: { empleado: { select: { id: true, nombre: true } } },
      orderBy: { takenAt: 'desc' },
    });
  }

  async function findOrdenForFotoCheck(id) {
    return prisma.ordenTrabajo.findUnique({
      where:  { id },
      select: { id: true, estado: true, estaFacturada: true },
    });
  }

  async function createOrdenFoto(data) {
    return prisma.ordenFoto.create({
      data,
      include: { empleado: { select: { id: true, nombre: true } } },
    });
  }

  async function findFotoConOrden(fotoId) {
    return prisma.ordenFoto.findUnique({
      where:   { id: fotoId },
      include: { orden: { select: { estado: true, estaFacturada: true } } },
    });
  }

  async function deleteOrdenFoto(fotoId) {
    return prisma.ordenFoto.delete({ where: { id: fotoId } });
  }

  async function countFotosOrden(ordenId) {
    return prisma.ordenFoto.count({ where: { ordenId } });
  }

  return {
    // OT
    listOrdenesTrabajo,
    findOrdenTrabajoLightById,
    findOrdenTrabajoForEstadoChange,
    createOrdenTrabajoTx,
    createLineasOTTx,
    findOrdenTrabajoFullById,
    softDeleteOrdenTrabajo,
    updateOrdenTrabajoEstadoTx,
    // Reservas + stock
    findItemCatalogoForExpansion,
    createReservasInventarioTx,
    findReservasOTActivasTx,
    liberarReservasOTTx,
    deleteAllReservasOTTx,
    deducirStockAtomicoTx,
    crearKardexSalidaTx,
    crearAuditCajaStockDriftTx,
    crearActivoClienteTx,
    // OI
    listOrdenesInstalacion,
    findOrdenInstalacionConDetalles,
    createOrdenInstalacion,
    updateOrdenInstalacionTx,
    updateServicioEstadoTx,
    findProductosForStock,
    ajustarStockTx,
    crearMovimientoOITx,
    updateOrdenInstalacionCompletadaTx,
    // Servicio
    listServicios,
    createServicioTx,
    updateServicio,
    findServicioEstado,
    updateServicioEstadoOnly,
    // Foto
    listFotosOrden,
    findOrdenForFotoCheck,
    createOrdenFoto,
    findFotoConOrden,
    deleteOrdenFoto,
    countFotosOrden,
  };
}

module.exports = createOrdenesRepo;
