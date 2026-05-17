/**
 * backend/modules/crm/suplidores/schema.js
 *
 * suplidorSchema + suplidorUpdateSchema viven en shared/schemas.js.
 */

const { z } = require('zod');

const listSuplidoresQuerySchema = z.object({
  search: z.string().optional(),
  activo: z.enum(['true', 'false']).optional(),
  page:   z.string().optional().default('1'),
  limit:  z.string().optional().default('50'),
});

module.exports = { listSuplidoresQuerySchema };
