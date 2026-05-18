/**
 * backend/modules/inventario/repo.js
 *
 * Capa de acceso a datos del módulo Inventario. Único punto donde se llama
 * a prisma para Categoria, Producto, MovimientoInventario y EquipoPrestamo.
 *
 * Factory: createInventarioRepo(prisma)
 *
 * Las transacciones complejas (prestamos: salida/entrada + kardex + stock)
 * viven aquí como funciones nombradas y atómicas — el service las invoca
 * pero NO conoce el detalle SQL.
 */

function createInventarioRepo(prisma) {
  if (!prisma) throw new Error('createInventarioRepo: prisma is required');

  // ─── Categorias ───────────────────────────────────────────────────────────
  async function listCategorias({ search }) {
    const where = search ? { nombre: { contains: search, mode: 'insensitive' } } : {};
    return prisma.categoria.findMany({
      where,
      orderBy: { nombre: 'asc' },
      include: { _count: { select: { productos: true } } },
    });
  }

  async function createCategoria(data) {
    return prisma.categoria.create({
      data,
      include: { _count: { select: { productos: true } } },
    });
  }

  async function updateCategoria(id, data) {
    return prisma.categoria.update({
      where: { id },
      data,
      include: { _count: { select: { productos: true } } },
    });
  }

  async function deleteCategoria(id) {
    return prisma.categoria.delete({ where: { id } });
  }

  // ─── Productos ────────────────────────────────────────────────────────────
  async function listProductos({ where, skip, take }) {
    const [productos, total] = await Promise.all([
      prisma.producto.findMany({
        where,
        orderBy: { nombre: 'asc' },
        skip,
        take,
        include: { categoria: { select: { id: true, nombre: true } } },
      }),
      prisma.producto.count({ where }),
    ]);
    return { productos, total };
  }

  /**
   * Crea producto en transacción para que la auto-generación de SKU
   * (via generarSiguienteCodigo del service) sea atómica con el insert.
   * El service nos pasa una función `nextSkuFn(tx)` cuando data.sku no viene.
   */
  async function createProductoTx(data, nextSkuFn) {
    return prisma.$transaction(async (tx) => {
      if (!data.sku && typeof nextSkuFn === 'function') {
        data.sku = await nextSkuFn(tx);
      }
      return tx.producto.create({
        data,
        include: { categoria: { select: { id: true, nombre: true } } },
      });
    });
  }

  async function updateProducto(id, data) {
    return prisma.producto.update({
      where: { id },
      data,
      include: { categoria: { select: { id: true, nombre: true } } },
    });
  }

  async function deleteProducto(id) {
    return prisma.producto.delete({ where: { id } });
  }

  /**
   * Lista series disponibles para captura en POS (sin reservar).
   * estado='Disponible' filtra fuera vendidas, reservadas, devueltas.
   */
  async function listSeriesDisponiblesForProducto(productoId) {
    return prisma.productoSerial.findMany({
      where:   { productoId, estado: 'Disponible' },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, serie: true, ubicacion: true, garantiaHasta: true },
    });
  }

  // ─── Movimientos (Kardex) ─────────────────────────────────────────────────
  async function listMovimientos({ where, skip, take }) {
    const [movimientos, total] = await Promise.all([
      prisma.movimientoInventario.findMany({
        where,
        orderBy: { fecha: 'desc' },
        skip,
        take,
        include: {
          producto: { select: { id: true, nombre: true, sku: true } },
          orden:    { select: { id: true, tipo: true, servicio: { select: { cliente: { select: { razonSocial: true } } } } } },
        },
      }),
      prisma.movimientoInventario.count({ where }),
    ]);
    return { movimientos, total };
  }

  // ─── Prestamos (transacciones atómicas con kardex + stock) ────────────────
  async function listPrestamos({ activos }) {
    const where = {};
    if (activos === 'true') where.fechaDevolucion = null;
    return prisma.equipoPrestamo.findMany({
      where,
      include: {
        cliente:  { select: { id: true, noCliente: true, razonSocial: true } },
        producto: { select: { id: true, sku: true, nombre: true } },
      },
      orderBy: { fechaPrestamo: 'desc' },
    });
  }

  async function findPrestamo(id) {
    return prisma.equipoPrestamo.findUnique({ where: { id } });
  }

  /**
   * Crea préstamo en transacción: registra salida en kardex, decrementa
   * stockActual del producto, y crea el préstamo con su FK movimientoSalidaId.
   * Si cualquier paso falla, todo se reversa.
   */
  async function createPrestamoTx({ clienteId, productoId, cantidad, fechaLimite, notas }) {
    return prisma.$transaction(async (tx) => {
      const mov = await tx.movimientoInventario.create({
        data: { productoId, tipo: 'Salida', cantidad },
      });
      await tx.producto.update({
        where: { id: productoId },
        data:  { stockActual: { decrement: cantidad } },
      });
      return tx.equipoPrestamo.create({
        data: {
          clienteId,
          productoId,
          cantidad,
          fechaLimite,
          notas:               notas ?? null,
          movimientoSalidaId:  mov.id,
        },
      });
    });
  }

  /**
   * Devolución atómica: entrada en kardex, incrementa stock, marca devuelto.
   */
  async function devolverPrestamoTx(prestamoId, prestamoPrev) {
    return prisma.$transaction(async (tx) => {
      const mov = await tx.movimientoInventario.create({
        data: { productoId: prestamoPrev.productoId, tipo: 'Entrada', cantidad: prestamoPrev.cantidad },
      });
      await tx.producto.update({
        where: { id: prestamoPrev.productoId },
        data:  { stockActual: { increment: prestamoPrev.cantidad } },
      });
      return tx.equipoPrestamo.update({
        where: { id: prestamoId },
        data:  { fechaDevolucion: new Date(), movimientoEntradaId: mov.id },
      });
    });
  }

  // Mejora #16: reserva temporal de stock POS. Crea row con expiraEn=
  // now+ttlMin. El cron del módulo ventas (cada 5 min) marca liberada=true
  // cuando expiraEn < now. NO modifica stockActual del Producto — es virtual.
  async function findProductoForReserva(productoId) {
    return prisma.producto.findUnique({
      where:  { id: productoId },
      select: { id: true, nombre: true, sku: true, stockActual: true },
    });
  }
  async function crearReservaInventario({ productoId, cantidad, expiraEn, motivo }) {
    return prisma.reservaInventario.create({
      data:   { productoId, cantidad, expiraEn, motivo: motivo ?? null },
      select: { id: true, productoId: true, cantidad: true, expiraEn: true, motivo: true },
    });
  }

  return {
    listCategorias,
    createCategoria,
    updateCategoria,
    deleteCategoria,
    listProductos,
    createProductoTx,
    updateProducto,
    deleteProducto,
    listSeriesDisponiblesForProducto,
    listMovimientos,
    listPrestamos,
    findPrestamo,
    createPrestamoTx,
    devolverPrestamoTx,
    findProductoForReserva,
    crearReservaInventario,
  };
}

// Exporta también helpers de reserva para el factory parent.
module.exports = createInventarioRepo;
