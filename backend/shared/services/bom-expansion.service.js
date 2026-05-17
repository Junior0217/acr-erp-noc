/**
 * backend/shared/services/bom-expansion.service.js
 *
 * BOM (Bill of Materials) expansion centralizado. Expande una línea de venta
 * a su lista de componentes físicos {productoId, cantidad, source, ...}.
 *
 * Modos:
 *   - Producto directo (linea.productoId)         → 1 entry source='direct'
 *   - ItemCatalogo bundle (esBundle=true)         → N entries source='bundle'
 *                                                   (componente × line.qty)
 *   - ItemCatalogo simple vinculado a Producto    → 1 entry source='linked'
 *   - ItemCatalogo simple sin producto / Servicio → [] (no consume stock)
 *
 * Antes vivía duplicado en pos/service.js y ordenes/service.js — el monolito
 * original solo tenía la copia POS y ordenes la llamaba via ReferenceError
 * latente (Fase 2.2 lo hizo evidente). Esta centralización elimina el bug
 * para siempre.
 *
 * Factory: createBomExpansionService({ prisma })
 *   .expandirLineaAComponentes(linea, tx?) → componentes[]
 */

function createBomExpansionService(deps) {
  const { prisma } = deps;
  if (!prisma) throw new Error('createBomExpansionService: prisma required');

  /**
   * Resolve ItemCatalogo + componentes + producto vinculado. Acepta tx
   * opcional — para correr dentro de la transacción de la operación
   * llamadora (atomicidad reservas/stock consume).
   */
  async function _findItemCatalogoFull(itemCatalogoId, tx) {
    const db = tx ?? prisma;
    return db.itemCatalogo.findUnique({
      where:   { id: itemCatalogoId },
      include: {
        componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
        producto:    { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
      },
    });
  }

  /**
   * Devuelve `componentes[]` con shape { productoId, cantidad, nombre?,
   * source: 'direct'|'bundle'|'linked', bundleItemId? }. Servicios puros
   * se filtran (no consumen stock).
   *
   * Guards defensivos:
   *   - Línea null/no-objeto → []
   *   - cantidad <= 0 / NaN  → []
   *   - itemCatalogoId no encontrado → []
   *   - componente sin producto físico → skip
   */
  async function expandirLineaAComponentes(linea, tx) {
    if (!linea || typeof linea !== 'object') return [];
    const cantidad = Number(linea.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return [];

    if (linea.productoId) {
      return [{ productoId: linea.productoId, cantidad, source: 'direct' }];
    }

    if (linea.itemCatalogoId) {
      let it;
      try {
        it = await _findItemCatalogoFull(linea.itemCatalogoId, tx);
      } catch (e) {
        console.warn(`[BOM expandir] lookup falló id=${linea.itemCatalogoId}:`, e.message);
        return [];
      }
      if (!it) return [];

      // Bundle: explota a componentes (cantidades × line.qty).
      if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
        return it.componentes
          .filter(c => c?.producto && c.producto.tipoItem !== 'SERVICIO' && Number(c.cantidad) > 0)
          .map(c => ({
            productoId:   c.productoId,
            cantidad:     Number(c.cantidad) * cantidad,
            nombre:       c.producto.nombre ?? 'Componente',
            source:       'bundle',
            bundleItemId: it.id,
          }));
      }

      // Item simple vinculado a Producto físico (no bundle).
      if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
        return [{
          productoId: it.productoId,
          cantidad,
          nombre:     it.producto?.nombre ?? it.nombre ?? 'Producto',
          source:     'linked',
        }];
      }
    }

    return [];
  }

  return { expandirLineaAComponentes };
}

module.exports = createBomExpansionService;
