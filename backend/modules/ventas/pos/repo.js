/**
 * backend/modules/ventas/pos/repo.js
 *
 * Capa de acceso a datos del módulo POS. Único punto donde se llama a
 * prisma.<model> para entidades del flujo de venta directa: ConfigEmpresa
 * (PIN supervisor + maxDescuentoCajero), ItemCatalogo (con bundles),
 * Producto (stock atómico), Cliente, ConfiguracionNCF, Factura, AuditCaja,
 * ReservaInventario, MovimientoInventario.
 *
 * Factory: createPosRepo(prisma)
 *
 * CRÍTICO — Cyber Neo: la deducción de stock es atómica vía
 *   UPDATE Producto SET stockActual = stockActual - cant
 *   WHERE id = ? AND stockActual >= cant
 *   RETURNING ...
 * En una sola query Postgres verifica disponibilidad Y decrementa. Dos
 * compras concurrentes para el mismo producto NUNCA pueden sobrevender —
 * la segunda devuelve 0 rows si no alcanza, y el service lanza
 * STOCK_INSUFICIENTE sin escribir nada. Mantener intacto.
 */

function createPosRepo(prisma) {
  if (!prisma) throw new Error('createPosRepo: prisma required');

  // ─── Empresa config ──────────────────────────────────────────────────────
  async function findEmpresaPinOnly() {
    return prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { pinSupervisor: true },
    });
  }

  async function findEmpresaPosConfig() {
    return prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { pinSupervisor: true, maxDescuentoCajero: true },
    });
  }

  async function findEmpresaPerfilFull(tx) {
    return (tx ?? prisma).empresaPerfil.findUnique({ where: { id: 1 } });
  }

  // ─── Gate lookups (read-only, fuera de transacción) ──────────────────────
  async function findProductosForGate(ids) {
    if (!ids?.length) return [];
    return prisma.producto.findMany({
      where:  { id: { in: ids } },
      select: { id: true, nombre: true, precio: true, stockActual: true, tipoItem: true },
    });
  }

  async function findItemCatalogosForGate(ids) {
    if (!ids?.length) return [];
    return prisma.itemCatalogo.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, nombre: true, precio: true, productoId: true, esBundle: true,
        producto:    { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
        componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
      },
    });
  }

  async function findStockActualForProductos(ids) {
    if (!ids?.length) return [];
    return prisma.producto.findMany({
      where:  { id: { in: ids } },
      select: { id: true, nombre: true, stockActual: true },
    });
  }

  // ─── Item catalogo full (para expandirLineaAComponentes) ────────────────
  async function findItemCatalogoFullForExpansion(itemCatalogoId, tx) {
    return (tx ?? prisma).itemCatalogo.findUnique({
      where:   { id: itemCatalogoId },
      include: {
        componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
        producto:    { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
      },
    });
  }

  // ─── Transacción: lookups dentro del tx ──────────────────────────────────
  async function findClienteByIdTx(tx, id) {
    return tx.cliente.findUnique({ where: { id } });
  }

  async function findItemCatalogosForCreateTx(tx, ids) {
    if (!ids?.length) return [];
    return tx.itemCatalogo.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, nombre: true, descripcion: true, precio: true, tipoItem: true,
        stock: true, productoId: true,
        producto: { select: { sku: true } },
      },
    });
  }

  async function findProductosForCreateTx(tx, ids) {
    if (!ids?.length) return [];
    return tx.producto.findMany({
      where:  { id: { in: ids } },
      select: { id: true, sku: true, nombre: true, descripcion: true, precio: true, stockActual: true },
    });
  }

  async function findProductosForManualTx(tx, ids) {
    if (!ids?.length) return [];
    return tx.producto.findMany({
      where:  { id: { in: ids } },
      select: { id: true, nombre: true, sku: true, stockActual: true, precio: true, tipoItem: true },
    });
  }

  /**
   * Atomic NCF allocator. UPDATE-RETURNING dentro de la transacción: dos
   * facturas concurrentes con mismo tipoNcf serializan en write-lock y
   * obtienen secuencias distintas.
   */
  async function nextNcfSeqTx(tx, tipoNcf) {
    const rows = await tx.$queryRaw`
      UPDATE "ConfiguracionNCF"
      SET    "secuenciaActual" = "secuenciaActual" + 1
      WHERE  "tipoNcf"         = ${tipoNcf}
        AND  "activo"          = true
        AND  "secuenciaActual" < "limite"
        AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
      RETURNING *
    `;
    return rows && rows.length ? rows[0] : null;
  }

  async function crearFacturaPos(tx, data) {
    return tx.factura.create({
      data,
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
        lineas:  true,
      },
    });
  }

  async function crearFacturaManual(tx, data) {
    return tx.factura.create({
      data,
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
        lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true, tipoItem: true } } } },
      },
    });
  }

  // ─── Stock atómico (CRÍTICO anti-sobreventa) ─────────────────────────────
  /**
   * Decremento atómico de stock. Devuelve `null` si no había suficiente
   * (el WHERE stockActual >= cant falla y RETURNING vacío). El service
   * decide cómo reaccionar (drift en POS catálogo, error 400 en manual).
   *
   * Acepta `tx` opcional para correr dentro de una $transaction. Para POS
   * catálogo donde la deducción ocurre POST-commit (lineas catálogo no
   * declaran productoId siempre), aceptamos también el prisma raíz.
   */
  async function deducirStockAtomico(productoId, cantidad, tx) {
    const db = tx ?? prisma;
    const rows = await db.$queryRaw`
      UPDATE "Producto"
      SET    "stockActual" = "stockActual" - ${cantidad}
      WHERE  id = ${Number(productoId)} AND "stockActual" >= ${cantidad}
      RETURNING id, nombre, "stockActual"
    `;
    return rows && rows.length ? rows[0] : null;
  }

  async function crearKardexSalida(productoId, cantidad, tx) {
    return (tx ?? prisma).movimientoInventario.create({
      data: { productoId: Number(productoId), tipo: 'Salida', cantidad },
    });
  }

  // ─── AuditCaja (fraud trail) ─────────────────────────────────────────────
  async function crearAuditCaja(payload, tx) {
    return (tx ?? prisma).auditCaja.create({ data: payload });
  }

  // ─── Reservas de inventario (cotizaciones, TTL 72h) ──────────────────────
  async function findItemCatalogoLinkMap(catIds) {
    if (!catIds?.length) return {};
    const itemsLink = await prisma.itemCatalogo.findMany({
      where:  { id: { in: catIds } },
      select: { id: true, productoId: true },
    });
    return Object.fromEntries(itemsLink.map(i => [i.id, i.productoId]));
  }

  async function crearReservasInventario(reservas) {
    if (!reservas?.length) return { count: 0 };
    return prisma.reservaInventario.createMany({ data: reservas });
  }

  return {
    findEmpresaPinOnly,
    findEmpresaPosConfig,
    findEmpresaPerfilFull,
    findProductosForGate,
    findItemCatalogosForGate,
    findStockActualForProductos,
    findItemCatalogoFullForExpansion,
    findClienteByIdTx,
    findItemCatalogosForCreateTx,
    findProductosForCreateTx,
    findProductosForManualTx,
    nextNcfSeqTx,
    crearFacturaPos,
    crearFacturaManual,
    deducirStockAtomico,
    crearKardexSalida,
    crearAuditCaja,
    findItemCatalogoLinkMap,
    crearReservasInventario,
  };
}

module.exports = createPosRepo;
