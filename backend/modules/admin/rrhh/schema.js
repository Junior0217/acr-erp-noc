/**
 * backend/modules/admin/rrhh/schema.js
 *
 * empleadoSchema + empleadoUpdateSchema + asistenciaSchema viven en
 * shared/schemas.js (transversales). Acá solo lo local del CRUD admin.
 */

const { z } = require('zod');

const listEmpleadosQuerySchema = z.object({
  search: z.string().optional(),
});

const listAsistenciaQuerySchema = z.object({
  empleadoId: z.string().optional(),
  mes:        z.string().optional(),
  anio:       z.string().optional(),
});

const rolesUpdateSchema = z.object({
  roleIds: z.array(z.number().int().positive()),
});

const permisosExtraSchema = z.object({
  permisosExtra: z.array(z.string().max(100)).max(200),
});

module.exports = {
  listEmpleadosQuerySchema,
  listAsistenciaQuerySchema,
  rolesUpdateSchema,
  permisosExtraSchema,
};
