/**
 * backend/modules/inventario/schema.js
 *
 * Zod schemas + helpers de descripción para el módulo Inventario (categorias,
 * productos, movimientos kardex). prestamoSchema vive en shared/schemas.js
 * porque es transversal (también lo usan otros routers vía deps.schemas).
 *
 * Helpers descripcionToRaw + stripTags se exportan acá porque son específicos
 * al esquema de producto (campo `descripcion` flex: string|estructurada).
 */

const { z } = require('zod');

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

/**
 * Normaliza el campo descripcion a string (legacy) o JSON serializado del
 * objeto estructurado. Aplica límites consistentes con el schema.
 */
function descripcionToRaw(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.v === 1) {
    return JSON.stringify({
      v: 1,
      titulo:    String(value.titulo ?? '').slice(0, 200),
      bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
      imagenUrl: value.imagenUrl ? String(value.imagenUrl).slice(0, 500) : null,
    });
  }
  return null;
}

const categoriaSchema = z.object({
  nombre: z.string().min(2).max(100).transform(stripTags),
});

const productoSchema = z.object({
  // sku ahora es OPCIONAL — backend autogenera via generarSiguienteCodigo
  // si no viene. Si viene, se respeta para permitir importación de SKUs externos.
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

const productoListQuerySchema = z.object({
  search:        z.string().optional(),
  categoriaId:   z.string().optional(),
  tipoItem:      z.enum(['ARTICULO', 'SERVICIO']).optional(),
  canibalizados: z.enum(['true', 'false']).optional(),
  page:          z.string().optional().default('1'),
  limit:         z.string().optional().default('50'),
});

const movimientoListQuerySchema = z.object({
  productoId: z.string().optional(),
  tipo:       z.enum(['Entrada', 'Salida']).optional(),
  search:     z.string().optional(),
  page:       z.string().optional().default('1'),
  limit:      z.string().optional().default('50'),
});

const categoriaListQuerySchema = z.object({
  search: z.string().optional(),
});

const prestamoListQuerySchema = z.object({
  activos: z.enum(['true', 'false']).optional(),
});

module.exports = {
  stripTags,
  descripcionEstructuradaSchema,
  descripcionFlexSchema,
  descripcionToRaw,
  categoriaSchema,
  productoSchema,
  productoUpdateSchema,
  productoListQuerySchema,
  movimientoListQuerySchema,
  categoriaListQuerySchema,
  prestamoListQuerySchema,
};
