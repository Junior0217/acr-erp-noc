/**
 * backend/modules/admin/preferencias-pos/schema.js
 *
 * Zod DTO de las preferencias visuales del POS por cajero. Solo controla
 * RENDERIZADO de switches (Validez / Forma de Pago / Entrega / Garantía /
 * Notas) — NO afecta contenido legal del documento.
 */

const { z } = require('zod');

const preferenciasPosSchema = z.object({
  mostrarValidez:   z.boolean().optional(),
  mostrarFormaPago: z.boolean().optional(),
  mostrarEntrega:   z.boolean().optional(),
  mostrarGarantia:  z.boolean().optional(),
  mostrarNotas:     z.boolean().optional(),
}).strict();

module.exports = { preferenciasPosSchema };
