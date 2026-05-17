/**
 * backend/modules/ventas/facturas/repo.js
 *
 * Capa de acceso a datos del módulo Facturas. Único punto que toca prisma
 * para Factura, OrdenTrabajo (en contexto de emisión), Producto/Movimiento
 * (stock restore/deduct), AuditCaja (hash chain helper interno).
 *
 * NCF: ESTRICTAMENTE NO se accede directo a prisma.configuracionNCF aquí.
 * Toda allocator NCF pasa por shared/services/ncf.service.js — el service
 * inyecta una función `nextNcfSequence` que retorna { prefijo, ncf, ...}.
 *
 * Factory: createFacturasRepo(prisma)
 */

function createFacturasRepo(prisma) {
  if (!prisma) throw new Error('createFacturasRepo: prisma required');

  // ─── Factura lookups ─────────────────────────────────────────────────────
  async function findFacturaWithLineasProducto(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: { lineas: { include: { producto: { select: { id: true, tipoItem: true } } } } },
    });
  }

  async function findFacturaForND(id) {
    return prisma.factura.findUnique({
      where:  { id },
      select: {
        id: true, noFactura: true, ncf: true, clienteId: true, ordenId: true,
        estado: true, esCotizacion: true, esNotaCredito: true, esNotaDebito: true,
      },
    });
  }

  async function findFacturaForResponse(id, tx) {
    return (tx ?? prisma).factura.findUnique({
      where:   { id },
      include: {
        cliente: { select: { email: true, razonSocial: true } },
        orden:   { include: { lineas: true } },
      },
    });
  }

  // ─── OT lookups para emisión ────────────────────────────────────────────
  async function findOTForCreditCheck(ordenId) {
    return prisma.ordenTrabajo.findUnique({
      where:   { id: ordenId },
      include: {
        lineas:  true,
        cliente: { select: { id: true, razonSocial: true, limiteCredito: true } },
      },
    });
  }

  async function findOTForEmissionTx(tx, ordenId) {
    return tx.ordenTrabajo.findUnique({
      where:   { id: ordenId },
      include: {
        cliente:  true,
        lineas:   true,
        facturas: { select: { id: true } },
      },
    });
  }

  async function aggregateDeudaActual(clienteId) {
    return prisma.factura.aggregate({
      _sum:  { total: true },
      where: {
        clienteId,
        deletedAt:    null,
        esCotizacion: false,
        estado:       { in: ['Emitida', 'Vencida'] },
      },
    });
  }

  // ─── Stock restore (revertir + NC) ───────────────────────────────────────
  async function restaurarStockTx(tx, productoId, cantidad) {
    return tx.producto.update({
      where: { id: productoId },
      data:  { stockActual: { increment: cantidad } },
    });
  }

  async function crearKardexEntradaTx(tx, productoId, cantidad) {
    return tx.movimientoInventario.create({
      data: { productoId, tipo: 'Entrada', cantidad },
    });
  }

  // ─── Factura mutations ───────────────────────────────────────────────────
  async function updateFacturaToBorradorTx(tx, id) {
    return tx.factura.update({
      where: { id },
      data:  { estado: 'Borrador', fechaPago: null, pdfUrl: null, pdfInvalidatedAt: new Date() },
    });
  }

  async function updateFacturaToAnuladaTx(tx, id) {
    return tx.factura.update({
      where: { id },
      data:  { estado: 'Anulada', pdfUrl: null, pdfInvalidatedAt: new Date() },
    });
  }

  async function crearNotaCreditoTx(tx, data) {
    return tx.factura.create({ data });
  }

  async function crearNotaDebitoTx(tx, data) {
    return tx.factura.create({ data });
  }

  async function crearFacturaEmisionTx(tx, data) {
    return tx.factura.create({ data });
  }

  async function marcarOTFacturadaTx(tx, ordenId) {
    return tx.ordenTrabajo.update({
      where: { id: ordenId },
      data:  { estado: 'Completada', completadaEn: new Date(), estaFacturada: true },
    });
  }

  async function patchCondicionesFactura(id, condiciones) {
    return prisma.factura.update({
      where: { id },
      data:  { condiciones, pdfUrl: null },
      select:{ id: true, condiciones: true },
    });
  }

  // ─── AuditCaja hash-chain (append-only) ──────────────────────────────────
  async function findLastAuditCajaHash() {
    return prisma.auditCaja.findFirst({
      where:   { hash: { not: null } },
      orderBy: { id: 'desc' },
      select:  { hash: true },
    });
  }

  async function crearAuditCaja(data) {
    return prisma.auditCaja.create({ data });
  }

  return {
    findFacturaWithLineasProducto,
    findFacturaForND,
    findFacturaForResponse,
    findOTForCreditCheck,
    findOTForEmissionTx,
    aggregateDeudaActual,
    restaurarStockTx,
    crearKardexEntradaTx,
    updateFacturaToBorradorTx,
    updateFacturaToAnuladaTx,
    crearNotaCreditoTx,
    crearNotaDebitoTx,
    crearFacturaEmisionTx,
    marcarOTFacturadaTx,
    patchCondicionesFactura,
    findLastAuditCajaHash,
    crearAuditCaja,
  };
}

module.exports = createFacturasRepo;
