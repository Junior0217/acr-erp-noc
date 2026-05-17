/**
 * backend/modules/crm/clientes/schema.js
 *
 * Zod DTOs locales. clienteSchema + clienteUpdateSchema viven en
 * shared/schemas.js (compartidos con POS, facturas, ordenes). Acá solo
 * declaramos los schemas específicos del CRUD del módulo.
 */

const { z } = require('zod');

const listClientesQuerySchema = z.object({
  search: z.string().optional(),
  activo: z.enum(['true', 'false']).optional(),
  page:   z.string().optional().default('1'),
  limit:  z.string().optional().default('50'),
});

// Body de POST permite acompañar prospectoOrigenId para marcar conversión.
// Los campos del cliente se validan luego con clienteSchema (shared).
const crearClienteExtrasSchema = z.object({
  prospectoOrigenId: z.string().uuid().optional(),
});

module.exports = {
  listClientesQuerySchema,
  crearClienteExtrasSchema,
};
