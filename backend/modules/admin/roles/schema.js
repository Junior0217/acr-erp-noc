/**
 * backend/modules/admin/roles/schema.js
 *
 * passwordSchema vive en shared/schemas.js — re-uso aquí vía sharedSchemas.
 */

const { z } = require('zod');

const rolSchema = z.object({
  nombre:      z.string().min(2).max(100),
  descripcion: z.string().max(200).optional().nullable(),
  permisos:    z.array(z.string().max(100)).max(200).default([]),
  activo:      z.boolean().default(true),
  nivel:       z.number().int().min(0).max(100).optional().default(0),
  require2FA:  z.boolean().optional().default(false),
});

const rolUpdateSchema = rolSchema.partial();

const bloquearSchema = z.object({
  bloqueado: z.boolean(),
});

module.exports = {
  rolSchema,
  rolUpdateSchema,
  bloquearSchema,
};
