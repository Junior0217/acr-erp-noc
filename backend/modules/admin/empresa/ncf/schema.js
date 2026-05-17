/**
 * backend/modules/admin/empresa/ncf/schema.js
 *
 * Zod DTO del sub-módulo NCF (config administrativa). El allocator atómico
 * vive en shared/services/ncf.service.js. Acá solo validamos el input del
 * endpoint de configuración (owner-facing).
 *
 * REGLA: el cliente NUNCA puede setear `secuenciaActual` arbitrariamente
 * desde este endpoint. El contador es append-only via nextNcfSequence en
 * shared service. El schema lo acepta solo para bootstrap inicial (default
 * 0); el service.upsertConfiguracion del shared lo IGNORA en updates.
 */

const { z } = require('zod');

const ncfConfigSchema = z.object({
  prefijo:         z.string().min(1).max(3),
  tipoNcf:         z.string().min(1),
  tipoDescripcion: z.string().min(1),
  secuenciaActual: z.number().int().min(0).default(0),
  limite:          z.number().int().min(1).default(9_999_999),
  vencimiento:     z.string().datetime().optional().nullable(),
  activo:          z.boolean().default(true),
});

module.exports = { ncfConfigSchema };
