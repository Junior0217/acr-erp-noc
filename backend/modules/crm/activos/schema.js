/**
 * backend/modules/crm/activos/schema.js
 *
 * CMDB (ActivoCliente) + Timeline DTOs.
 */

const { z } = require('zod');

const activoSchema = z.object({
  clienteId:        z.string().uuid(),
  productoId:       z.number().int().positive(),
  cantidad:         z.number().int().min(1).default(1),
  fechaInstalacion: z.coerce.date().optional(),
  finGarantia:      z.coerce.date().optional().nullable(),
  numeroSerie:      z.string().max(80).optional().nullable(),
  ubicacion:        z.string().max(150).optional().nullable(),
  notas:            z.string().max(500).optional().nullable(),
});

const timelineEventoSchema = z.object({
  evento:         z.enum(['instalado', 'reparado', 'trasladado', 'retirado', 'garantia_reclamada', 'mantenimiento', 'inspeccion']),
  ordenTrabajoId: z.string().uuid().optional().nullable(),
  notas:          z.string().max(500).optional().nullable(),
});

const listActivosQuerySchema = z.object({
  clienteId: z.string().uuid().optional(),
});

module.exports = {
  activoSchema,
  timelineEventoSchema,
  listActivosQuerySchema,
};
