/**
 * backend/modules/inventario/service.js
 *
 * Lógica de negocio del módulo Inventario. NO conoce req/res. Recibe DTOs
 * planos validados por controller. Hace cálculos (paginación, enriquecimiento
 * con flag `vencido`, formateo de precio) y orquesta transacciones del repo.
 *
 * Factory: createInventarioService({ repo, generarSiguienteCodigo, auditReq })
 *
 * Devuelve descriptors `{ status, body }` que controller serializa.
 */

const { descripcionToRaw } = require('./schema');

/** Error tipado del dominio Inventario; controller lo mapea a HTTP. */
class InventarioError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function formatProducto(p) {
  return { ...p, precio: Number(p.precio) };
}

function createInventarioService({ repo, generarSiguienteCodigo, auditReq }) {
  if (!repo)                                          throw new Error('createInventarioService: repo required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createInventarioService: generarSiguienteCodigo required');
  if (typeof auditReq !== 'function')                 throw new Error('createInventarioService: auditReq required');

  function _fakeReqForAudit(reqMeta, user) {
    return {
      headers: {
        'x-forwarded-for': reqMeta?.ip ?? null,
        'user-agent':      reqMeta?.ua ?? null,
      },
      socket: { remoteAddress: reqMeta?.ip ?? null },
      user:   user ?? null,
    };
  }

  // ─── Categorias ───────────────────────────────────────────────────────────
  async function listCategorias(query) {
    const data = await repo.listCategorias({ search: query.search });
    return { status: 200, body: { data } };
  }

  async function createCategoria(data) {
    try {
      const cat = await repo.createCategoria(data);
      return { status: 201, body: cat };
    } catch (e) {
      if (e.code === 'P2002') throw new InventarioError(409, 'CAT_DUPLICATE', 'Ya existe una categoría con ese nombre.');
      throw e;
    }
  }

  async function updateCategoria(id, data) {
    try {
      const cat = await repo.updateCategoria(id, data);
      return { status: 200, body: cat };
    } catch (e) {
      if (e.code === 'P2025') throw new InventarioError(404, 'CAT_NOT_FOUND', 'Categoría no encontrada.');
      if (e.code === 'P2002') throw new InventarioError(409, 'CAT_DUPLICATE', 'Ya existe una categoría con ese nombre.');
      throw e;
    }
  }

  async function deleteCategoria(id) {
    try {
      await repo.deleteCategoria(id);
      return { status: 204, body: null };
    } catch (e) {
      if (e.code === 'P2025') throw new InventarioError(404, 'CAT_NOT_FOUND', 'Categoría no encontrada.');
      if (e.code === 'P2003') throw new InventarioError(409, 'CAT_IN_USE', 'No se puede eliminar: la categoría tiene productos asociados.');
      throw e;
    }
  }

  // ─── Productos ────────────────────────────────────────────────────────────
  function _buildProductoWhere(query) {
    const where = {};
    if (query.categoriaId) {
      const cid = parseInt(query.categoriaId, 10);
      if (cid > 0) where.categoriaId = cid;
    }
    if (query.tipoItem && ['ARTICULO', 'SERVICIO'].includes(query.tipoItem)) where.tipoItem = query.tipoItem;
    if (query.canibalizados === 'true')  where.esCanibalizado = true;
    if (query.canibalizados === 'false') where.esCanibalizado = false;
    if (query.search) where.OR = [
      { nombre: { contains: query.search, mode: 'insensitive' } },
      { sku:    { contains: query.search, mode: 'insensitive' } },
    ];
    return where;
  }

  function _resolvePagination(query, max = 100) {
    const take    = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), max);
    const pageNum = Math.max(parseInt(query.page ?? '1', 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    return { take, pageNum, skip };
  }

  async function listProductos(query) {
    const where = _buildProductoWhere(query);
    const { take, pageNum, skip } = _resolvePagination(query);
    const { productos, total } = await repo.listProductos({ where, skip, take });
    return {
      status: 200,
      body: {
        data: productos.map(formatProducto),
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function createProducto(data) {
    if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion);
    try {
      const producto = await repo.createProductoTx(data, (tx) => generarSiguienteCodigo('producto', tx));
      return { status: 201, body: formatProducto(producto) };
    } catch (e) {
      if (e.code === 'P2002') throw new InventarioError(409, 'SKU_DUPLICATE', 'Ya existe un producto con ese SKU.');
      if (e.code === 'P2003') throw new InventarioError(400, 'CAT_INVALID',   'Categoría no válida.');
      throw e;
    }
  }

  async function updateProducto(id, data) {
    if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion);
    try {
      const producto = await repo.updateProducto(id, data);
      return { status: 200, body: formatProducto(producto) };
    } catch (e) {
      if (e.code === 'P2025') throw new InventarioError(404, 'PROD_NOT_FOUND', 'Producto no encontrado.');
      if (e.code === 'P2003') throw new InventarioError(400, 'CAT_INVALID',    'Categoría no válida.');
      throw e;
    }
  }

  async function deleteProducto(id) {
    try {
      await repo.deleteProducto(id);
      return { status: 204, body: null };
    } catch (e) {
      if (e.code === 'P2025') throw new InventarioError(404, 'PROD_NOT_FOUND', 'Producto no encontrado.');
      if (e.code === 'P2003') throw new InventarioError(409, 'PROD_IN_USE',    'No se puede eliminar: el producto está en uso en órdenes o plantillas.');
      throw e;
    }
  }

  // ─── Movimientos (Kardex) ─────────────────────────────────────────────────
  function _buildMovimientoWhere(query) {
    const where = {};
    if (query.productoId) {
      const pid = parseInt(query.productoId, 10);
      if (pid > 0) where.productoId = pid;
    }
    if (query.tipo === 'Entrada' || query.tipo === 'Salida') where.tipo = query.tipo;
    if (query.search) {
      where.producto = {
        OR: [
          { nombre: { contains: query.search, mode: 'insensitive' } },
          { sku:    { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }
    return where;
  }

  async function listMovimientos(query) {
    const where = _buildMovimientoWhere(query);
    const { take, pageNum, skip } = _resolvePagination(query);
    const { movimientos, total } = await repo.listMovimientos({ where, skip, take });
    return {
      status: 200,
      body: {
        data: movimientos,
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  // ─── Prestamos ────────────────────────────────────────────────────────────
  async function listPrestamos(query) {
    const data = await repo.listPrestamos({ activos: query.activos });
    const ahora = Date.now();
    const enriched = data.map(p => ({
      ...p,
      vencido: !p.fechaDevolucion && new Date(p.fechaLimite).getTime() < ahora,
    }));
    return { status: 200, body: { data: enriched } };
  }

  async function createPrestamo(data, user, reqMeta) {
    const fechaLimite = new Date(Date.now() + data.diasLimite * 86_400_000);
    try {
      const prestamo = await repo.createPrestamoTx({
        clienteId:  data.clienteId,
        productoId: data.productoId,
        cantidad:   data.cantidad,
        fechaLimite,
        notas:      data.notas,
      });
      auditReq('prestamo:crear', _fakeReqForAudit(reqMeta, user), {
        prestamoId: prestamo.id, clienteId: data.clienteId, productoId: data.productoId,
      });
      return { status: 201, body: prestamo };
    } catch (e) {
      if (e.code === 'P2003') throw new InventarioError(400, 'FK_INVALID', 'Cliente o producto inválido.');
      throw e;
    }
  }

  async function devolverPrestamo(id, user, reqMeta) {
    const prestamo = await repo.findPrestamo(id);
    if (!prestamo)              throw new InventarioError(404, 'PRESTAMO_NOT_FOUND', 'Préstamo no encontrado.');
    if (prestamo.fechaDevolucion) throw new InventarioError(409, 'PRESTAMO_DEVUELTO', 'Préstamo ya devuelto.');
    const result = await repo.devolverPrestamoTx(id, prestamo);
    auditReq('prestamo:devolver', _fakeReqForAudit(reqMeta, user), { prestamoId: id });
    return { status: 200, body: result };
  }

  return {
    InventarioError,
    formatProducto,
    listCategorias,
    createCategoria,
    updateCategoria,
    deleteCategoria,
    listProductos,
    createProducto,
    updateProducto,
    deleteProducto,
    listMovimientos,
    listPrestamos,
    createPrestamo,
    devolverPrestamo,
  };
}

module.exports = createInventarioService;
module.exports.InventarioError = InventarioError;
