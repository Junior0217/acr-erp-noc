/**
 * backend/modules/inventario/uploads/schema.js
 *
 * Zod schemas para los endpoints de upload del inventario:
 *   POST /api/inventario/upload-image  (multipart/form-data)
 *   POST /api/inventario/upload-url    (JSON con URL externa)
 *
 * urlUploadSchema valida URL + kind. kindFromBody acepta string suelto del
 * body multipart (kind viene como form field tras multer.single('file')).
 */

const { z } = require('zod');

/**
 * Factory que recibe el set de `kinds` válidos desde shared/infra/supabase
 * via deps, para que el schema valide contra la fuente única de verdad.
 */
function buildSchemas(KINDS_INVENTARIO) {
  if (!Array.isArray(KINDS_INVENTARIO) || KINDS_INVENTARIO.length === 0) {
    throw new Error('buildSchemas: KINDS_INVENTARIO debe ser array no vacío.');
  }
  const kindEnum = z.enum(KINDS_INVENTARIO);

  const urlUploadSchema = z.object({
    url:  z.string().url().max(2048),
    kind: kindEnum.default('producto'),
  });

  const fileKindSchema = z.object({
    kind: z.union([kindEnum, z.literal('')]).optional().transform(v => (v === '' || v == null ? 'producto' : v)),
  });

  return { urlUploadSchema, fileKindSchema };
}

module.exports = { buildSchemas };
