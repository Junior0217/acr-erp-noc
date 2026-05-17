/**
 * backend/modules/crm/prospectos/schema.js
 *
 * prospectoSchema + prospectoUpdateSchema viven en shared/schemas.js.
 */

const { z } = require('zod');

const listProspectosQuerySchema = z.object({
  search: z.string().optional(),
  estado: z.string().optional(),
  page:   z.string().optional().default('1'),
  limit:  z.string().optional().default('50'),
});

module.exports = { listProspectosQuerySchema };
