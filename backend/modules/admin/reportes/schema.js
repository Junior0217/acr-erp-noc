/**
 * backend/modules/admin/reportes/schema.js
 */

const { z } = require('zod');

const comisionesQuerySchema = z.object({
  mes:  z.string().optional(),
  anio: z.string().optional(),
});

module.exports = { comisionesQuerySchema };
