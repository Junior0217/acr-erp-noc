/**
 * backend/modules/servicios/ordenes/repo.js
 *
 * Único punto que toca prisma para el módulo Órdenes de Servicio Técnico.
 * Reutiliza el modelo OrdenTrabajo (tipoOT = 'ServicioTecnico') + el JSON
 * `metadatos` para los campos extendidos (tipoEquipo, marca, modelo, serial,
 * diagnostico inicial, reporte técnico, piezas, presupuesto).
 */

const TIPO_OT = 'ServicioTecnico';

function createServiciosOrdenesRepo(prisma) {
  if (!prisma) throw new Error('createServiciosOrdenesRepo: prisma required');

  function _whereFromQuery(query) {
    const where = { tipoOT: TIPO_OT, deletedAt: null };
    if (query.clienteId)  where.clienteId = query.clienteId;
    if (query.estado)     where.estado    = query.estado;
    if (query.desde || query.hasta) {
      where.createdAt = {};
      if (query.desde) where.createdAt.gte = new Date(query.desde);
      if (query.hasta) where.createdAt.lte = new Date(query.hasta);
    }
    if (query.search) {
      where.OR = [
        { noOT:           { contains: query.search, mode: 'insensitive' } },
        { notasTecnicas:  { contains: query.search, mode: 'insensitive' } },
        { cliente:        { razonSocial: { contains: query.search, mode: 'insensitive' } } },
        { cliente:        { noCliente:   { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  function _filtroExtra(rows, query) {
    if (!query.tipoEquipo) return rows;
    return rows.filter((r) => {
      const meta = r.metadatos || {};
      return meta.tipoEquipo === query.tipoEquipo;
    });
  }

  async function listar(query) {
    const where = _whereFromQuery(query);
    const [total, rows] = await prisma.$transaction([
      prisma.ordenTrabajo.count({ where }),
      prisma.ordenTrabajo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    query.limit,
        skip:    query.offset,
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true, tipoEmpresa: true, tipoNcf: true } },
          tecnico: { select: { id: true, nombre: true, apellido: true } },
        },
      }),
    ]);
    const filtradas = _filtroExtra(rows, query);
    return { total, rows: filtradas };
  }

  async function obtenerPorId(id) {
    return prisma.ordenTrabajo.findFirst({
      where: { id, tipoOT: TIPO_OT, deletedAt: null },
      include: {
        cliente: true,
        tecnico: { select: { id: true, nombre: true, apellido: true, telefono: true } },
        lineas:  true,
        facturas: { select: { id: true, noFactura: true, ncf: true, total: true, estado: true, createdAt: true } },
      },
    });
  }

  async function crear(data) {
    return prisma.ordenTrabajo.create({
      data: {
        ...data,
        tipoOT: TIPO_OT,
      },
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, tipoEmpresa: true, tipoNcf: true } },
      },
    });
  }

  async function actualizar(id, data) {
    return prisma.ordenTrabajo.update({
      where: { id },
      data,
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, tipoEmpresa: true, tipoNcf: true } },
        tecnico: { select: { id: true, nombre: true, apellido: true } },
      },
    });
  }

  async function marcarFacturada(id) {
    return prisma.ordenTrabajo.update({
      where: { id },
      data:  { estaFacturada: true, completadaEn: new Date() },
    });
  }

  async function contarParaSecuencia() {
    return prisma.ordenTrabajo.count({ where: { tipoOT: TIPO_OT } });
  }

  async function findClienteById(clienteId) {
    return prisma.cliente.findUnique({
      where:  { id: clienteId },
      select: { id: true, razonSocial: true, noCliente: true, tipoEmpresa: true, tipoNcf: true, rnc: true, direccion: true, deletedAt: true },
    });
  }

  return {
    TIPO_OT,
    listar,
    obtenerPorId,
    crear,
    actualizar,
    marcarFacturada,
    contarParaSecuencia,
    findClienteById,
  };
}

module.exports = createServiciosOrdenesRepo;
