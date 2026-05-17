/**
 * backend/modules/inventario/controller.js
 *
 * Capa HTTP del módulo Inventario. Extrae req, valida via schemas locales,
 * delega al service, aplica descriptor a res. Sin lógica.
 *
 * Factory: createInventarioController({ service, schemas })
 */

const { z } = require('zod');
const { InventarioError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _applyDescriptor(res, d) {
  const status = d?.status ?? 200;
  if (d?.body == null && (status === 204 || status === 205)) return res.status(status).end();
  return res.status(status).json(d?.body ?? {});
}

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const d = await fn(req, res);
      if (!res.headersSent) _applyDescriptor(res, d);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      }
      if (err instanceof InventarioError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('[INVENTARIO CTRL]', err.message, err.stack);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function _parseIntId(raw) {
  const id = parseInt(raw, 10);
  if (!id || id < 1) throw new InventarioError(400, 'BAD_ID', 'ID inválido.');
  return id;
}

function createInventarioController({ service, schemas }) {
  if (!service) throw new Error('createInventarioController: service required');
  if (!schemas) throw new Error('createInventarioController: schemas required');
  const {
    categoriaSchema, productoSchema, productoUpdateSchema,
    categoriaListQuerySchema, productoListQuerySchema, movimientoListQuerySchema,
    prestamoListQuerySchema,
  } = schemas;
  const { prestamoSchema } = schemas; // viene desde shared/schemas vía deps merge

  // ─── Categorias ───────────────────────────────────────────────────────────
  const listCategorias = _wrap(async (req) => {
    const q = categoriaListQuerySchema.parse(req.query);
    return service.listCategorias(q);
  });

  const createCategoria = _wrap(async (req) => {
    const data = categoriaSchema.parse(req.body);
    return service.createCategoria(data);
  });

  const updateCategoria = _wrap(async (req) => {
    const id   = _parseIntId(req.params.id);
    const data = categoriaSchema.parse(req.body);
    return service.updateCategoria(id, data);
  });

  const deleteCategoria = _wrap(async (req) => {
    const id = _parseIntId(req.params.id);
    return service.deleteCategoria(id);
  });

  // ─── Productos ────────────────────────────────────────────────────────────
  const listProductos = _wrap(async (req) => {
    const q = productoListQuerySchema.parse(req.query);
    return service.listProductos(q);
  });

  const createProducto = _wrap(async (req) => {
    const data = productoSchema.parse(req.body);
    return service.createProducto(data);
  });

  const updateProducto = _wrap(async (req) => {
    const id   = _parseIntId(req.params.id);
    const data = productoUpdateSchema.parse(req.body);
    return service.updateProducto(id, data);
  });

  const deleteProducto = _wrap(async (req) => {
    const id = _parseIntId(req.params.id);
    return service.deleteProducto(id);
  });

  const listSeries = _wrap(async (req) => service.listSeriesDisponibles(req.params.id));

  // ─── Movimientos ──────────────────────────────────────────────────────────
  const listMovimientos = _wrap(async (req) => {
    const q = movimientoListQuerySchema.parse(req.query);
    return service.listMovimientos(q);
  });

  // ─── Prestamos ────────────────────────────────────────────────────────────
  const listPrestamos = _wrap(async (req) => {
    const q = prestamoListQuerySchema.parse(req.query);
    return service.listPrestamos(q);
  });

  const createPrestamo = _wrap(async (req) => {
    const data    = prestamoSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.createPrestamo(data, req.user, reqMeta);
  });

  const devolverPrestamo = _wrap(async (req) => {
    if (typeof req.params.id !== 'string' || req.params.id.length < 1) {
      throw new InventarioError(400, 'BAD_ID', 'ID inválido.');
    }
    const reqMeta = _extractReqMeta(req);
    return service.devolverPrestamo(req.params.id, req.user, reqMeta);
  });

  return {
    listCategorias,
    createCategoria,
    updateCategoria,
    deleteCategoria,
    listProductos,
    createProducto,
    updateProducto,
    deleteProducto,
    listSeries,
    listMovimientos,
    listPrestamos,
    createPrestamo,
    devolverPrestamo,
  };
}

module.exports = createInventarioController;
