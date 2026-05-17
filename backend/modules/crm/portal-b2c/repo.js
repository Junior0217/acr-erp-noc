/**
 * backend/modules/crm/portal-b2c/repo.js
 *
 * Capa de datos del módulo Portal B2C. CERO PII en logs (Cyber Neo).
 */

function createPortalRepo(prisma) {
  if (!prisma) throw new Error('createPortalRepo: prisma required');

  // ─── Usuarios Portal ─────────────────────────────────────────────────────
  async function findUsuarioByEmail(email) {
    return prisma.usuarioPortal.findFirst({ where: { email } });
  }

  async function findUsuarioByEmailLight(email) {
    return prisma.usuarioPortal.findFirst({ where: { email }, select: { id: true, nombre: true } });
  }

  async function countUsuarios() {
    return prisma.usuarioPortal.count();
  }

  async function crearUsuario(data) {
    return prisma.usuarioPortal.create({ data });
  }

  async function findUsuarioMe(id) {
    return prisma.usuarioPortal.findUnique({
      where:  { id },
      select: {
        id: true, noUsuario: true, nombre: true, email: true, telefono: true, activo: true, clienteId: true,
        cliente: { select: { id: true, noCliente: true, razonSocial: true, telefonoPrincipal: true, direccion: true, tipoCliente: true } },
      },
    });
  }

  async function updateUsuarioPasswordHash(id, hash) {
    return prisma.usuarioPortal.update({ where: { id }, data: { passwordHash: hash } });
  }

  // ─── Portal Settings ─────────────────────────────────────────────────────
  async function getOrCreatePortalSettings() {
    return prisma.portalSettings.upsert({
      where:  { id: 1 },
      update: {},
      create: { id: 1 },
    });
  }

  async function upsertPortalSettings(data) {
    return prisma.portalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  }

  // ─── Catalogo del portal ────────────────────────────────────────────────
  async function listCatalogoPortal(where) {
    return prisma.itemCatalogo.findMany({
      where,
      orderBy: [{ categoria: 'asc' }, { nombre: 'asc' }],
      select:  { id: true, nombre: true, descripcion: true, tipo: true, categoria: true, precio: true, tipoItem: true },
    });
  }

  // ─── SOS / OT ───────────────────────────────────────────────────────────
  async function countOTsRecientes(clienteId, desde) {
    return prisma.ordenTrabajo.count({
      where: { clienteId, tipoOT: 'SoporteTecnico', createdAt: { gte: desde }, estado: { in: ['Pendiente', 'EnProceso'] }, deletedAt: null },
    });
  }

  async function crearOTSos(data) {
    return prisma.ordenTrabajo.create({ data });
  }

  // ─── Cotización + Checkout factura ──────────────────────────────────────
  async function crearFactura(data) {
    return prisma.factura.create({ data, include: { lineas: true } });
  }

  async function listCotizacionesPortal(clienteId) {
    return prisma.factura.findMany({
      where:   { clienteId, esCotizacion: true, deletedAt: null },
      select:  { id: true, noFactura: true, total: true, estado: true, fechaEmision: true, fechaVence: true, notas: true },
      orderBy: { createdAt: 'desc' },
      take:    10,
    });
  }

  async function findDashboardData(clienteId) {
    return Promise.all([
      prisma.servicio.findMany({
        where:   { clienteId },
        include: { plan: { select: { nombre: true, tipo: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.factura.findMany({
        where:   { clienteId, deletedAt: null, esCotizacion: false },
        select:  { id: true, noFactura: true, total: true, estado: true, fechaEmision: true, fechaVence: true },
        orderBy: { fechaEmision: 'desc' },
        take:    20,
      }),
      prisma.ordenTrabajo.findMany({
        where:   { clienteId, deletedAt: null },
        select:  { id: true, noOT: true, tipoOT: true, estado: true, createdAt: true, notasTecnicas: true },
        orderBy: { createdAt: 'desc' },
        take:    10,
      }),
    ]);
  }

  async function findFacturaForPdf(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: {
        cliente: true,
        lineas:  true,
        orden:   { include: { lineas: { include: { itemCatalogo: { select: { nombre: true } } } } } },
      },
    });
  }

  async function findItemsCatalogoActivos(ids) {
    return prisma.itemCatalogo.findMany({ where: { id: { in: ids }, activo: true } });
  }

  // ─── Webhook Azul ───────────────────────────────────────────────────────
  async function findFacturaConLineasItem(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: { lineas: { include: { itemCatalogo: true } }, cliente: true },
    });
  }

  async function updateFacturaPago(id, data) {
    return prisma.factura.update({ where: { id }, data });
  }

  async function updateFacturaAnulada(id, notas) {
    return prisma.factura.update({ where: { id }, data: { estado: 'Anulada', notas } });
  }

  async function crearOrdenTrabajoTx(tx, data) {
    return tx.ordenTrabajo.create({ data });
  }

  async function updateFacturaPagadaTx(tx, id, data) {
    return tx.factura.update({ where: { id }, data });
  }

  async function updateFacturaNotasTx(tx, id, notas) {
    return tx.factura.update({ where: { id }, data: { notas } });
  }

  return {
    findUsuarioByEmail, findUsuarioByEmailLight, countUsuarios, crearUsuario, findUsuarioMe, updateUsuarioPasswordHash,
    getOrCreatePortalSettings, upsertPortalSettings,
    listCatalogoPortal,
    countOTsRecientes, crearOTSos,
    crearFactura, listCotizacionesPortal, findDashboardData, findFacturaForPdf, findItemsCatalogoActivos,
    findFacturaConLineasItem, updateFacturaPago, updateFacturaAnulada,
    crearOrdenTrabajoTx, updateFacturaPagadaTx, updateFacturaNotasTx,
  };
}

module.exports = createPortalRepo;
