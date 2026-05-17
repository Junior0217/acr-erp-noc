/**
 * backend/modules/admin/ops/repo.js
 *
 * Capa de datos de admin/ops. CERO acceso a tablas fuera de su dominio.
 * IpBlock + AuditCaja + AuditLog + Factura (lookup verify) + Cliente
 * (razonSocial para response público — ya impresa en PDF) + EmpresaPerfil.
 */

function createOpsRepo(prisma) {
  if (!prisma) throw new Error('createOpsRepo: prisma required');

  // ─── Mapa NOC ──────────────────────────────────────────────────────────
  async function findClientesGeo() {
    return prisma.cliente.findMany({
      select: {
        id: true, razonSocial: true, latitud: true, longitud: true, activo: true,
        telefonoPrincipal: true,
        servicios: { select: { plan: { select: { tipo: true } } }, where: { estado: 'Activo' }, take: 1 },
      },
      where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
    });
  }

  async function findSuplidoresGeo() {
    return prisma.suplidor.findMany({
      select: { id: true, razonSocial: true, latitud: true, longitud: true, activo: true, actividad: true, telefonoPrincipal: true },
      where:  { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
    });
  }

  async function findProspectosGeo() {
    return prisma.prospecto.findMany({
      select: { id: true, nombre: true, latitud: true, longitud: true, estado: true, servicioInteresado: true, telefono: true },
      where:  { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
    });
  }

  async function countClientes()    { return prisma.cliente.count(); }
  async function countSuplidores()  { return prisma.suplidor.count(); }
  async function countProspectos()  { return prisma.prospecto.count(); }

  // ─── Incidencias ───────────────────────────────────────────────────────
  async function listIncidencias(where) {
    return prisma.incidenciaReconciliacion.findMany({
      where,
      orderBy: [{ resueltoEn: 'asc' }, { createdAt: 'desc' }],
      take:    200,
      include: { empleado: { select: { id: true, nombre: true } } },
    });
  }

  async function resolverIncidencia(id, data) {
    return prisma.incidenciaReconciliacion.update({ where: { id }, data });
  }

  // ─── Track (anti-brute-force) ──────────────────────────────────────────
  async function findActiveIpBlocks(now) {
    return prisma.ipBlock.findMany({ where: { expiraEn: { gt: now } } });
  }

  async function crearIpBlock(data) {
    return prisma.ipBlock.create({ data });
  }

  async function findTicketByPin(codigoPin) {
    return prisma.ticketTaller.findUnique({
      where:  { codigoPin },
      select: {
        noTicket: true, equipo: true, marca: true, modelo: true, estado: true,
        recibidoEn: true, diagnosticadoEn: true, listoEn: true, entregadoEn: true,
        diagnostico: true, costoEstimado: true,
        cliente: { select: { razonSocial: true } },
      },
    });
  }

  // ─── UsuarioPortal ─────────────────────────────────────────────────────
  async function setUsuarioPortalPasswordHash(id, hash) {
    return prisma.usuarioPortal.update({
      where:  { id },
      data:   { passwordHash: hash },
      select: { id: true, noUsuario: true, nombre: true, email: true },
    });
  }

  async function bloquearUsuarioPortal(id) {
    return prisma.usuarioPortal.update({
      where:  { id },
      data:   { activo: false },
      select: { id: true, activo: true },
    });
  }

  // ─── Verify público (factura) ──────────────────────────────────────────
  async function findFacturaByVerifyHash(hash) {
    return prisma.factura.findFirst({
      where:  { deletedAt: null, verifyHash: hash },
      select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
    });
  }

  async function listFacturasForVerifyFallback(hashExcluido, take = 20000) {
    return prisma.factura.findMany({
      where:  { deletedAt: null, OR: [{ verifyHash: null }, { verifyHash: { not: hashExcluido } }] },
      select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
      orderBy:{ fechaEmision: 'desc' },
      take,
    });
  }

  async function backfillFacturaVerifyHash(id, hash) {
    return prisma.factura.update({ where: { id }, data: { verifyHash: hash } });
  }

  async function findEmpresaIdentidad() {
    return prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { razonSocial: true, rnc: true } });
  }

  async function findClienteRazonSocial(id) {
    return prisma.cliente.findUnique({ where: { id }, select: { razonSocial: true } });
  }

  // ─── Portal PDF v2 ─────────────────────────────────────────────────────
  async function findFacturaForPdfV2(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: { cliente: true, lineas: { include: { producto: { select: { sku: true, nombre: true } } } } },
    });
  }

  // ─── AuditCaja ─────────────────────────────────────────────────────────
  async function listAuditCaja({ where, take }) {
    return prisma.auditCaja.findMany({ where, orderBy: { createdAt: 'desc' }, take });
  }

  async function listAuditCajaForVerify(take) {
    return prisma.auditCaja.findMany({ orderBy: { id: 'asc' }, take });
  }

  async function listAuditLogForVerify(take) {
    return prisma.auditLog.findMany({ orderBy: { id: 'asc' }, take });
  }

  return {
    findClientesGeo, findSuplidoresGeo, findProspectosGeo,
    countClientes, countSuplidores, countProspectos,
    listIncidencias, resolverIncidencia,
    findActiveIpBlocks, crearIpBlock, findTicketByPin,
    setUsuarioPortalPasswordHash, bloquearUsuarioPortal,
    findFacturaByVerifyHash, listFacturasForVerifyFallback, backfillFacturaVerifyHash,
    findEmpresaIdentidad, findClienteRazonSocial,
    findFacturaForPdfV2,
    listAuditCaja, listAuditCajaForVerify, listAuditLogForVerify,
  };
}

module.exports = createOpsRepo;
