/**
 * backend/modules/ventas/carrito/repo.js
 */

const CARRITO_INCLUDE = {
  cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, tipoNcf: true, tipoEmpresa: true } },
  lineas:  {
    include: { producto: { select: { id: true, nombre: true, sku: true, precio: true, stockActual: true, tipoItem: true } } },
    orderBy: { id: 'asc' },
  },
};

function createCarritoRepo(prisma) {
  if (!prisma) throw new Error('createCarritoRepo: prisma required');

  async function findCarritoByEmpleado(empleadoId) {
    return prisma.carritoTemp.findUnique({ where: { empleadoId }, include: CARRITO_INCLUDE });
  }

  async function createCarrito(empleadoId, extra = {}) {
    return prisma.carritoTemp.create({
      data: { empleadoId, applyItbis: true, ...extra },
      include: CARRITO_INCLUDE,
    });
  }

  async function upsertCarrito(empleadoId, data) {
    return prisma.carritoTemp.upsert({
      where:  { empleadoId },
      update: data,
      create: { empleadoId, ...data },
      include: CARRITO_INCLUDE,
    });
  }

  async function ensureCarrito(empleadoId) {
    return prisma.carritoTemp.upsert({
      where:  { empleadoId },
      update: {},
      create: { empleadoId },
    });
  }

  async function findProducto(id) {
    return prisma.producto.findUnique({
      where:  { id },
      select: { id: true, precio: true, tipoItem: true },
    });
  }

  async function findLineaExistente(carritoId, productoId) {
    return prisma.lineaCarrito.findFirst({ where: { carritoId, productoId } });
  }

  async function incrementarLinea(id, cantidad, precioOverride, descuentoPorcentaje, descuentoMonto) {
    return prisma.lineaCarrito.update({
      where: { id },
      data: {
        cantidad: { increment: cantidad },
        ...(precioOverride !== undefined ? { precioUnitario: precioOverride } : {}),
        descuentoPorcentaje,
        descuentoMonto,
      },
    });
  }

  async function crearLinea(carritoId, productoId, cantidad, precioUnitario, descuentoPorcentaje, descuentoMonto) {
    return prisma.lineaCarrito.create({
      data: { carritoId, productoId, cantidad, precioUnitario, descuentoPorcentaje, descuentoMonto },
    });
  }

  async function findLineaConCarrito(lineaId) {
    return prisma.lineaCarrito.findUnique({
      where:   { id: lineaId },
      include: { carrito: { select: { empleadoId: true } } },
    });
  }

  async function updateLinea(id, data) {
    return prisma.lineaCarrito.update({ where: { id }, data });
  }

  async function deleteLinea(id) {
    return prisma.lineaCarrito.delete({ where: { id } });
  }

  async function vaciarCarrito(carritoId) {
    return prisma.lineaCarrito.deleteMany({ where: { carritoId } });
  }

  async function findCarritoBare(empleadoId) {
    return prisma.carritoTemp.findUnique({ where: { empleadoId } });
  }

  async function findCarritoConLineas(empleadoId) {
    return prisma.carritoTemp.findUnique({
      where:   { empleadoId },
      include: { lineas: true },
    });
  }

  return {
    findCarritoByEmpleado,
    createCarrito,
    upsertCarrito,
    ensureCarrito,
    findProducto,
    findLineaExistente,
    incrementarLinea,
    crearLinea,
    findLineaConCarrito,
    updateLinea,
    deleteLinea,
    vaciarCarrito,
    findCarritoBare,
    findCarritoConLineas,
  };
}

module.exports = createCarritoRepo;
