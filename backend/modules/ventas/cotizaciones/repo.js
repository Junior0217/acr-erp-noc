/**
 * backend/modules/ventas/cotizaciones/repo.js
 *
 * Capa de acceso a datos del módulo Cotizaciones (que también aloja
 * listado/cambio-de-estado de Facturas para mantener cohesión histórica
 * de UI). Único punto que toca prisma.
 */

function createCotizacionesRepo(prisma) {
  if (!prisma) throw new Error('createCotizacionesRepo: prisma required');

  async function listCotizaciones(where, limit, offset) {
    return prisma.$transaction([
      prisma.factura.count({ where }),
      prisma.factura.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true } },
          lineas:  { select: { id: true, descripcion: true, cantidad: true, precioUnitario: true, descuentoPorcentaje: true, descuentoMonto: true } },
        },
      }),
    ]);
  }

  async function findCotizacionFull(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: {
        cliente: true,
        lineas:  { include: { producto: { select: { id: true, precio: true, stockActual: true, tipoItem: true } } } },
      },
    });
  }

  async function findProductosForRevivir(ids) {
    if (!ids?.length) return [];
    return prisma.producto.findMany({
      where:  { id: { in: ids } },
      select: { id: true, nombre: true, precio: true, stockActual: true, tipoItem: true },
    });
  }

  async function findFacturaFullById(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
        lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true } } } },
        orden:   { select: { id: true, tipoOT: true } },
      },
    });
  }

  async function listFacturas(where, limit, offset) {
    return prisma.$transaction([
      prisma.factura.count({ where }),
      prisma.factura.findMany({
        where,
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true } },
          orden:   { select: { id: true, tipoOT: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
    ]);
  }

  async function findFacturaForEstadoChange(id) {
    return prisma.factura.findUnique({ where: { id } });
  }

  async function findEmpleadoTwoFactor(empleadoId) {
    return prisma.empleado.findUnique({
      where:  { id: empleadoId },
      select: { twoFactorEnabled: true, twoFactorSecret: true },
    });
  }

  async function updateFacturaEstado(id, data) {
    return prisma.factura.update({ where: { id }, data });
  }

  async function findOTForMikrotik(ordenId) {
    return prisma.ordenTrabajo.findUnique({
      where:  { id: ordenId },
      select: { tipoOT: true, metadatos: true },
    });
  }

  async function crearAuditCaja(data) {
    return prisma.auditCaja.create({ data });
  }

  async function findCotizacionLight(id) {
    return prisma.factura.findUnique({
      where:  { id },
      select: { id: true, esCotizacion: true, etapaPipeline: true, empleadoId: true },
    });
  }

  async function updateCotizacionEtapa(id, etapa) {
    return prisma.factura.update({
      where:  { id },
      data:   { etapaPipeline: etapa },
      select: { id: true, etapaPipeline: true, noFactura: true },
    });
  }

  async function deleteReservasFactura(facturaId) {
    return prisma.reservaInventario.deleteMany({ where: { facturaId } });
  }

  return {
    listCotizaciones,
    findCotizacionFull,
    findProductosForRevivir,
    findFacturaFullById,
    listFacturas,
    findFacturaForEstadoChange,
    findEmpleadoTwoFactor,
    updateFacturaEstado,
    findOTForMikrotik,
    crearAuditCaja,
    findCotizacionLight,
    updateCotizacionEtapa,
    deleteReservasFactura,
  };
}

module.exports = createCotizacionesRepo;
