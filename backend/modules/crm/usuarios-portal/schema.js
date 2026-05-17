/**
 * backend/modules/crm/usuarios-portal/schema.js
 *
 * Cyber Neo silent fix: body POST /:id/vincular ahora pasa por Zod estricto
 * (anti prototype pollution + tipo seguro de clienteId nullable).
 */

const { z } = require('zod');

const listUsuariosPortalQuerySchema = z.object({
  search: z.string().optional(),
  page:   z.string().optional().default('1'),
  limit:  z.string().optional().default('50'),
});

const vincularUsuarioSchema = z.object({
  clienteId: z.string().uuid().nullable(),
});

module.exports = {
  listUsuariosPortalQuerySchema,
  vincularUsuarioSchema,
};
