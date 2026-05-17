/**
 * backend/modules/ventas/taller/schema.js
 */

const { z } = require('zod');

const ticketTallerSchema = z.object({
  clienteId:     z.string().uuid(),
  tecnicoId:     z.number().int().optional().nullable(),
  equipo:        z.string().min(1).max(150),
  marca:         z.string().max(80).optional().nullable(),
  modelo:        z.string().max(80).optional().nullable(),
  numeroSerie:   z.string().max(80).optional().nullable(),
  falla:         z.string().min(1).max(1000),
  notas:         z.string().max(1000).optional().nullable(),
  costoEstimado: z.coerce.number().nonnegative().optional().nullable(),
});

const ticketEstadoSchema = z.object({
  estado:        z.enum(['Recibido', 'Diagnostico', 'EsperandoPieza', 'Listo', 'Entregado', 'Cancelado']),
  diagnostico:   z.string().max(2000).optional().nullable(),
  costoEstimado: z.coerce.number().nonnegative().optional().nullable(),
  notas:         z.string().max(1000).optional().nullable(),
});

const listTallerQuerySchema = z.object({
  estado: z.string().optional(),
  search: z.string().optional(),
});

module.exports = {
  ticketTallerSchema,
  ticketEstadoSchema,
  listTallerQuerySchema,
  ticketTallerUpdateSchema: ticketTallerSchema.partial(),
};
