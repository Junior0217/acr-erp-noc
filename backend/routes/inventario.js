/**
 * backend/routes/inventario.js
 *
 * Inventario router: categorías, productos, movimientos (kardex). Más rutas
 * (prestamos, upload imágenes) se migrarán por fases.
 */

const express = require('express');
const { z } = require('zod');

function createInventarioRouter(deps) {
  const router = express.Router();
  const {
    prisma, middlewares, auditReq, generarSiguienteCodigo,
  } = deps;
  const { verificarJWT, requerirPermiso } = middlewares;

  const stripTags = v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;

  const descripcionEstructuradaSchema = z.object({
    v:         z.literal(1),
    titulo:    z.string().min(1).max(200),
    bullets:   z.array(z.string().min(1).max(200)).max(30).default([]),
    imagenUrl: z.string().max(500).nullable().optional(),
  });
  const descripcionFlexSchema = z.union([
    z.string().max(2000),
    descripcionEstructuradaSchema,
  ]).nullable().optional();

  function descripcionToRaw(value) {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      if (value.v === 1) {
        const limpio = {
          v: 1,
          titulo:    String(value.titulo ?? '').slice(0, 200),
          bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
          imagenUrl: value.imagenUrl ? String(value.imagenUrl).slice(0, 500) : null,
        };
        return JSON.stringify(limpio);
      }
    }
    return null;
  }

  const categoriaSchema = z.object({
    nombre: z.string().min(2).max(100).transform(stripTags),
  });

  const productoSchema = z.object({
    sku:            z.string().min(1).max(50).transform(stripTags).optional(),
    nombre:         z.string().min(2).max(200).transform(stripTags),
    precio:         z.coerce.number().nonnegative(),
    categoriaId:    z.number().int().positive(),
    tipoItem:       z.enum(['ARTICULO', 'SERVICIO']).optional(),
    esCanibalizado: z.boolean().optional(),
    descripcion:    descripcionFlexSchema,
    imagenUrl:      z.string().max(500).url().optional().nullable().or(z.literal('').transform(() => null)),
  });

  const productoUpdateSchema = productoSchema.omit({ sku: true }).partial();

  function formatProducto(p) { return { ...p, precio: Number(p.precio) }; }

  // ─── Categorías ───────────────────────────────────────────────────────────
  router.get('/categorias', async (req, res) => {
    try {
      const { search } = req.query;
      const where = search ? { nombre: { contains: search, mode: 'insensitive' } } : {};
      const categorias = await prisma.categoria.findMany({
        where, orderBy: { nombre: 'asc' },
        include: { _count: { select: { productos: true } } },
      });
      res.json({ data: categorias });
    } catch {
      res.status(500).json({ error: 'Error al obtener categorías.' });
    }
  });

  router.post('/categorias', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    try {
      const data = categoriaSchema.parse(req.body);
      const cat = await prisma.categoria.create({ data, include: { _count: { select: { productos: true } } } });
      res.status(201).json(cat);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  router.put('/categorias/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      const data = categoriaSchema.parse(req.body);
      const cat = await prisma.categoria.update({ where: { id }, data, include: { _count: { select: { productos: true } } } });
      res.json(cat);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Categoría no encontrada.' });
      if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  router.delete('/categorias/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      await prisma.categoria.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Categoría no encontrada.' });
      if (e.code === 'P2003') return res.status(409).json({ error: 'No se puede eliminar: la categoría tiene productos asociados.' });
      res.status(500).json({ error: 'Error al eliminar categoría.' });
    }
  });

  // ─── Productos ────────────────────────────────────────────────────────────
  router.get('/productos', async (req, res) => {
    try {
      const { search, categoriaId, tipoItem, canibalizados, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = {};
      if (categoriaId) { const cid = parseInt(categoriaId); if (cid > 0) where.categoriaId = cid; }
      if (tipoItem && ['ARTICULO', 'SERVICIO'].includes(tipoItem)) where.tipoItem = tipoItem;
      if (canibalizados === 'true')  where.esCanibalizado = true;
      if (canibalizados === 'false') where.esCanibalizado = false;
      if (search) where.OR = [
        { nombre: { contains: search, mode: 'insensitive' } },
        { sku:    { contains: search, mode: 'insensitive' } },
      ];
      const [productos, total] = await Promise.all([
        prisma.producto.findMany({
          where, orderBy: { nombre: 'asc' }, skip, take,
          include: { categoria: { select: { id: true, nombre: true } } },
        }),
        prisma.producto.count({ where }),
      ]);
      res.json({ data: productos.map(formatProducto), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch (e) {
      console.error('[GET /api/productos]', e.message, e.stack);
      res.status(500).json({ error: 'Error al obtener productos.' });
    }
  });

  router.post('/productos', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    try {
      const data = productoSchema.parse(req.body);
      if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion);
      const producto = await prisma.$transaction(async (tx) => {
        if (!data.sku) data.sku = await generarSiguienteCodigo('producto', tx);
        return tx.producto.create({
          data, include: { categoria: { select: { id: true, nombre: true } } },
        });
      });
      res.status(201).json(formatProducto(producto));
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'Ya existe un producto con ese SKU.' });
      if (e.code === 'P2003') return res.status(400).json({ error: 'Categoría no válida.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  router.put('/productos/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      const data = productoUpdateSchema.parse(req.body);
      if (data.descripcion !== undefined) data.descripcion = descripcionToRaw(data.descripcion);
      const producto = await prisma.producto.update({
        where: { id }, data,
        include: { categoria: { select: { id: true, nombre: true } } },
      });
      res.json(formatProducto(producto));
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Producto no encontrado.' });
      if (e.code === 'P2003') return res.status(400).json({ error: 'Categoría no válida.' });
      res.status(400).json({ error: 'Datos inválidos.' });
    }
  });

  router.delete('/productos/:id', verificarJWT, requerirPermiso('catalogo:editar'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido.' });
    try {
      await prisma.producto.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Producto no encontrado.' });
      if (e.code === 'P2003') return res.status(409).json({ error: 'No se puede eliminar: el producto está en uso en órdenes o plantillas.' });
      res.status(500).json({ error: 'Error al eliminar producto.' });
    }
  });

  // ─── Movimientos (Kardex) ─────────────────────────────────────────────────
  router.get('/movimientos', async (req, res) => {
    try {
      const { productoId, tipo, search, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = {};
      if (productoId) { const pid = parseInt(productoId); if (pid > 0) where.productoId = pid; }
      if (tipo === 'Entrada' || tipo === 'Salida') where.tipo = tipo;
      if (search) where.producto = { OR: [
        { nombre: { contains: search, mode: 'insensitive' } },
        { sku:    { contains: search, mode: 'insensitive' } },
      ]};
      const [movimientos, total] = await Promise.all([
        prisma.movimientoInventario.findMany({
          where, orderBy: { fecha: 'desc' }, skip, take,
          include: {
            producto: { select: { id: true, nombre: true, sku: true } },
            orden:    { select: { id: true, tipo: true, servicio: { select: { cliente: { select: { razonSocial: true } } } } } },
          },
        }),
        prisma.movimientoInventario.count({ where }),
      ]);
      res.json({ data: movimientos, meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener movimientos.' });
    }
  });

  return router;
}

module.exports = createInventarioRouter;
