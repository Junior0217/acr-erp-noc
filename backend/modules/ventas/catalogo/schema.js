/**
 * backend/modules/ventas/catalogo/schema.js
 *
 * Zod DTOs del módulo Catálogo + Planes + Búsqueda unificada + Bundles +
 * portal/catalog (variantes pública/privada/portal).
 *
 * descripcionFlexSchema viene de modules/inventario/schema.js (single source
 * of truth) — el catálogo lo reusa porque comparte el mismo shape de
 * descripción estructurada.
 */

const { z } = require('zod');
const { descripcionFlexSchema } = require('../../inventario/schema');

const TIPOS_ITEM     = ['Recurrente', 'VentaUnica', 'Servicio'];
const CATEGORIAS     = ['WISP', 'CCTV', 'Redes', 'CercoElectrico', 'VentaDirecta', 'Mixto', 'SoporteTecnico', 'Reparacion', 'ProyectoCCTV'];
const TIPOS_PLAN     = ['WISP','CCTV','Redes','CercoElectrico','VentaDirecta','Mixto','SoporteTecnico','Reparacion','ProyectoCCTV'];

// Prefijo por tipo para codigo legible.
const CODIGO_PREFIJO = { Recurrente: 'REC', VentaUnica: 'ART', Servicio: 'SRV' };

const itemCatalogoSchema = z.object({
  nombre:      z.string().min(1).max(120),
  descripcion: descripcionFlexSchema,
  imagenUrl:   z.string().max(500).url().optional().nullable().or(z.literal('').transform(() => null)),
  tipo:        z.enum(TIPOS_ITEM),
  categoria:   z.enum(CATEGORIAS),
  precio:      z.number().min(0),
  costo:       z.number().min(0).optional().default(0),
  stock:       z.number().int().optional().nullable(),
  productoId:  z.number().int().positive().optional().nullable(),
  tipoItem:    z.enum(['ARTICULO', 'SERVICIO']).optional().default('SERVICIO'),
  esBundle:    z.boolean().optional().default(false),
  activo:      z.boolean().default(true),
});

const catalogoBuscarQuerySchema = z.object({
  q:       z.string().optional(),
  limit:   z.string().optional().default('20'),
  incluir: z.string().optional().default('item,producto,plan'),
  activo:  z.string().optional(),
});

const listCatalogoQuerySchema = z.object({
  tipo:      z.string().optional(),
  categoria: z.string().optional(),
  activo:    z.string().optional(),
  search:    z.string().optional(),
});

const plantillaEquipoShape = z.object({
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().positive(),
});

const planSchema = z.object({
  nombre:            z.string().min(2).max(100),
  tipo:              z.enum(TIPOS_PLAN),
  precioMensualBase: z.coerce.number().nonnegative().default(0),
  precioInstalBase:  z.coerce.number().nonnegative().default(0),
  activo:            z.boolean().default(true),
  plantillaEquipos:  z.array(plantillaEquipoShape).default([]),
});

const planUpdateSchema = planSchema.partial();

const listPlanesQuerySchema = z.object({
  search: z.string().optional(),
  activo: z.string().optional(),
  page:   z.string().optional().default('1'),
  limit:  z.string().optional().default('50'),
});

module.exports = {
  TIPOS_ITEM, CATEGORIAS, TIPOS_PLAN, CODIGO_PREFIJO,
  itemCatalogoSchema,
  catalogoBuscarQuerySchema,
  listCatalogoQuerySchema,
  planSchema,
  planUpdateSchema,
  listPlanesQuerySchema,
};
