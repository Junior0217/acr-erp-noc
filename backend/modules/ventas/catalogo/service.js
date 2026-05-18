/**
 * backend/modules/ventas/catalogo/service.js
 *
 * Lógica del módulo Catálogo. Reglas:
 *   - Costo solo visible para owner / catalogo:ver_costos. Update sin
 *     permiso lo preserva del DB (anti privilege escalation).
 *   - Stock efectivo = stockActual - SUM(reservas activas).
 *   - Código auto-generado por tipo con UNIQUE index protection.
 *   - Item con LineaOrdenTrabajo existentes NO se elimina (409).
 */

const { descripcionToRaw } = require('../../../shared/helpers');

class CatalogoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createCatalogoService(deps) {
  const { repo, auditReq, generarSiguienteCodigo, CODIGO_PREFIJO, prisma } = deps;
  if (!repo)                                          throw new Error('createCatalogoService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createCatalogoService: auditReq required');
  if (typeof generarSiguienteCodigo !== 'function')   throw new Error('createCatalogoService: generarSiguienteCodigo required');
  // prisma opcional — solo necesario para auto-link de ItemCatalogo → Producto
  // por SKU. Si no está, se omite el lookup (no rompe).

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

  // ─── Búsqueda unificada ─────────────────────────────────────────────────
  async function buscarUnificado(query) {
    const q       = String(query.q ?? '').trim();
    const limit   = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
    const incluir = String(query.incluir ?? 'item,producto,plan').split(',').map(s => s.trim()).filter(Boolean);
    const onlyActivos = query.activo !== 'false';

    const tasks = [];
    if (incluir.includes('item')) {
      tasks.push(repo.buscarItemCatalogos({ q, onlyActivos, limit }).then(rows => rows.map(it => ({
        kind:        'item',
        id:          it.id,
        codigo:      it.codigo ?? `ITM-${String(it.id).slice(0, 6).toUpperCase()}`,
        nombre:      it.nombre ?? 'Sin nombre',
        descripcion: it.descripcion ?? null,
        imagenUrl:   it.imagenUrl ?? it.producto?.imagenUrl ?? null,
        tipo:        it.tipo ?? 'Servicio',
        categoria:   it.categoria ?? null,
        tipoItem:    it.tipoItem ?? 'SERVICIO',
        esBundle:    !!it.esBundle,
        precio:      Number(it.precio ?? 0),
        productoId:  it.productoId ?? null,
        stockActual: it.producto?.stockActual ?? null,
        sku:         it.producto?.sku ?? null,
        activo:      it.activo !== false,
      }))));
    }
    if (incluir.includes('producto')) {
      tasks.push(repo.buscarProductos({ q, onlyActivos, limit }).then(rows => rows.map(p => ({
        kind:        'producto',
        id:          p.id,
        codigo:      p.sku ?? `P-${p.id}`,
        nombre:      p.nombre ?? 'Sin nombre',
        descripcion: p.descripcion ?? null,
        imagenUrl:   p.imagenUrl ?? null,
        tipo:        'VentaUnica',
        tipoItem:    p.tipoItem ?? 'ARTICULO',
        precio:      Number(p.precio ?? 0),
        productoId:  p.id,
        stockActual: p.stockActual ?? 0,
        sku:         p.sku ?? null,
        activo:      true,
      }))));
    }
    if (incluir.includes('plan')) {
      tasks.push(repo.buscarPlanes({ q, onlyActivos, limit }).then(rows => rows.map(pl => ({
        kind:        'plan',
        id:          pl.id,
        codigo:      pl.sku ?? `PLN-${String(pl.id).slice(0, 6).toUpperCase()}`,
        nombre:      pl.nombre ?? 'Sin nombre',
        descripcion: null,
        imagenUrl:   null,
        tipo:        'Recurrente',
        categoria:   pl.tipo ?? 'Mixto',
        tipoItem:    'SERVICIO',
        precio:      Number(pl.precioMensualBase ?? 0),
        stockActual: null,
        activo:      pl.activo !== false,
      }))));
    }
    const buckets = await Promise.all(tasks);
    const unificado = buckets.flat().slice(0, limit * 3);
    return { status: 200, body: { data: unificado, total: unificado.length, fuentes: incluir } };
  }

  // ─── Catálogo CRUD ──────────────────────────────────────────────────────
  async function listarCatalogo(query, user) {
    const where = {};
    if (query.tipo)      where.tipo      = query.tipo;
    if (query.categoria) where.categoria = query.categoria;
    if (query.activo !== undefined && query.activo !== '') where.activo = query.activo === 'true';
    if (query.search)    where.nombre = { contains: query.search, mode: 'insensitive' };

    const items = await repo.listItemCatalogos(where);
    const prodIds = items.map(it => it.producto?.id).filter(Boolean);
    const reservas = await repo.findReservasGrouped(prodIds);
    const reservMap = Object.fromEntries(reservas.map(r => [r.productoId, r._sum.cantidad ?? 0]));

    const enriched = items.map(it => {
      const pref = CODIGO_PREFIJO[it.tipo] ?? 'ITM';
      const codigoFallback = `${pref}-${String(it.id ?? '').replace(/-/g, '').slice(0, 6).toUpperCase()}`;
      const reservadas = it.producto ? (reservMap[it.producto.id] ?? 0) : 0;
      const stockBase  = it.producto ? it.producto.stockActual : it.stock;
      const stockEff   = stockBase != null ? Math.max(0, stockBase - reservadas) : null;
      return {
        ...it,
        codigo:         it.codigo ?? codigoFallback,
        imagenUrl:      it.imagenUrl ?? it.producto?.imagenUrl ?? null,
        stock:          stockEff,
        stockReservado: reservadas,
        stockFisico:    stockBase,
        stockSource:    it.producto ? 'inventario' : (it.stock != null ? 'catalogo' : null),
        sku:            it.producto?.sku ?? null,
      };
    });
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos');
    const data = canSeeCosts ? enriched : enriched.map(({ costo, ...rest }) => rest);
    return { status: 200, body: { data } };
  }

  /**
   * Genera codigo incremental por tipo (SRV-0001, ART-0001, REC-0001).
   * UNIQUE INDEX en BD protege contra race conditions; retentamos hasta 3.
   */
  async function _generarCodigoCatalogo(tipo) {
    const pref = CODIGO_PREFIJO[tipo] ?? 'ITM';
    for (let attempt = 0; attempt < 3; attempt++) {
      const ultimo = await repo.findLastCodigoForTipo(pref);
      let n = 1;
      if (ultimo?.codigo) {
        const m = ultimo.codigo.match(/^[A-Z]+-(\d+)$/);
        if (m) n = parseInt(m[1], 10) + 1;
      }
      return `${pref}-${String(n + attempt).padStart(4, '0')}`;
    }
  }

  async function crearItemCatalogo(dto, user, reqMeta) {
    if (dto.descripcion !== undefined) dto.descripcion = descripcionToRaw(dto.descripcion);
    const codigo = await _generarCodigoCatalogo(dto.tipo);
    // Mejora #14: auto-link ItemCatalogo → Producto cuando el `codigo`
    // generado coincide con un Producto.sku existente. Single source of
    // truth: el item hereda imagenUrl + stock del producto físico sin que
    // el user tenga que vincular manualmente.
    if (!dto.productoId && codigo && prisma?.producto?.findUnique) {
      try {
        const match = await prisma.producto.findUnique({
          where:  { sku: codigo },
          select: { id: true },
        });
        if (match) dto.productoId = match.id;
      } catch {}
    }
    const item = await repo.createItemCatalogo({ ...dto, codigo });
    auditReq('catalogo:crear', _fakeReqForAudit(reqMeta, user), {
      id: item.id, codigo, tipo: dto.tipo, tipoItem: dto.tipoItem,
      autoLinkedProductoId: dto.productoId ?? null,
    });
    return { status: 201, body: item };
  }

  async function actualizarItemCatalogo(id, dto, user, reqMeta) {
    if (dto.descripcion !== undefined) dto.descripcion = descripcionToRaw(dto.descripcion);
    const permisos = Array.isArray(user?.permisos) ? user.permisos : [];
    const canSeeCosts = permisos.includes('sistema:owner') || permisos.includes('catalogo:ver_costos');
    if (!canSeeCosts) {
      // Anti privilege escalation: si el usuario no puede ver costos, NO puede
      // setearlos. Preservamos el costo actual de DB.
      const existing = await repo.findItemCatalogoCosto(id);
      if (existing) dto.costo = Number(existing.costo);
    }
    const item = await repo.updateItemCatalogo(id, dto);
    auditReq('catalogo:editar', _fakeReqForAudit(reqMeta, user), { id: item.id, codigo: item.codigo });
    return { status: 200, body: item };
  }

  async function eliminarItemCatalogo(id) {
    const count = await repo.countLineasOTUsing(id);
    if (count > 0) throw new CatalogoError(409, 'IN_USE', 'Item en uso en órdenes. Desactívalo en su lugar.');
    await repo.deleteItemCatalogo(id);
    return { status: 204, body: null };
  }

  // ─── Planes ─────────────────────────────────────────────────────────────
  function _formatPlan(p) {
    return { ...p, precioMensualBase: Number(p.precioMensualBase), precioInstalBase: Number(p.precioInstalBase) };
  }

  async function listarPlanes(query) {
    const take = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;
    const where = {};
    if (query.activo !== undefined && query.activo !== '') where.activo = query.activo === 'true';
    if (query.search) where.OR = [
      { nombre: { contains: query.search, mode: 'insensitive' } },
      { tipo:   { contains: query.search, mode: 'insensitive' } },
    ];
    const [planes, total] = await repo.listPlanes({ where, skip, take });
    return {
      status: 200,
      body: { data: planes.map(_formatPlan), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } },
    };
  }

  async function getPlan(id) {
    const plan = await repo.findPlanById(id);
    if (!plan) throw new CatalogoError(404, 'PLAN_NOT_FOUND', 'Plan no encontrado.');
    return { status: 200, body: _formatPlan(plan) };
  }

  async function crearPlan(dto, deps) {
    const { prisma } = deps;
    const { plantillaEquipos, ...rest } = dto;
    const plan = await prisma.$transaction(async (tx) => {
      const sku = await generarSiguienteCodigo('plan', tx);
      return repo.createPlanTx(tx, { ...rest, sku, plantillaEquipos: { create: plantillaEquipos } });
    });
    return { status: 201, body: _formatPlan(plan) };
  }

  async function actualizarPlan(id, dto, deps) {
    const { prisma } = deps;
    const { plantillaEquipos, ...rest } = dto;
    try {
      const plan = await prisma.$transaction(async (tx) => repo.updatePlanTx(tx, id, rest, plantillaEquipos));
      return { status: 200, body: _formatPlan(plan) };
    } catch (e) {
      if (e.code === 'P2025') throw new CatalogoError(404, 'PLAN_NOT_FOUND', 'Plan no encontrado.');
      throw e;
    }
  }

  async function togglePlan(id) {
    const current = await repo.findPlanLight(id);
    if (!current) throw new CatalogoError(404, 'PLAN_NOT_FOUND', 'Plan no encontrado.');
    const updated = await repo.togglePlanActivo(id, !current.activo);
    return { status: 200, body: _formatPlan(updated) };
  }

  // ─── Catálogo público + portal ──────────────────────────────────────────
  async function listarCatalogoPublico() {
    const items = await repo.listCatalogoPublico();
    return { status: 200, body: { data: items } };
  }

  async function listarCatalogoPortal() {
    const items = await repo.listCatalogoPortal();
    return { status: 200, body: { data: items.map(i => ({ ...i, precio: Number(i.precio) })) } };
  }

  // ─── Bundles cross-sell ─────────────────────────────────────────────────
  function _formatBundle(b) {
    return { ...b.hijo, score: b.score, motivo: b.motivo };
  }

  async function getBundlesPorProducto(productoIdRaw) {
    const pid = parseInt(productoIdRaw, 10);
    if (!pid) return { status: 200, body: { data: [] } };
    const bundles = await repo.findBundlesPorProducto(pid);
    return { status: 200, body: { data: bundles.map(_formatBundle) } };
  }

  async function getBundlesPorItemCatalogo(id, helpers) {
    const { validUUID } = helpers;
    if (!validUUID(id)) return { status: 200, body: { data: [] } };
    const item = await repo.findItemCatalogoForBundles(id);
    if (!item?.productoId) return { status: 200, body: { data: [] } };
    const bundles = await repo.findBundlesPorProducto(item.productoId);
    return { status: 200, body: { data: bundles.map(_formatBundle) } };
  }

  return {
    CatalogoError,
    buscarUnificado, listarCatalogo, crearItemCatalogo, actualizarItemCatalogo, eliminarItemCatalogo,
    listarPlanes, getPlan, crearPlan, actualizarPlan, togglePlan,
    listarCatalogoPublico, listarCatalogoPortal,
    getBundlesPorProducto, getBundlesPorItemCatalogo,
  };
}

module.exports = createCatalogoService;
module.exports.CatalogoError = CatalogoError;
