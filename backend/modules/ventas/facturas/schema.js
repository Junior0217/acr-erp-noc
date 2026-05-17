/**
 * backend/modules/ventas/facturas/schema.js
 *
 * Zod DTOs del módulo Facturas. Cubre el flujo fiscal completo:
 *   - Emisión normal desde OT (POST /facturas)
 *   - Reversión God Mode (Pagada/Anulada → Borrador)
 *   - Nota de Crédito DGII B04 (anula factura + restaura stock)
 *   - Nota de Débito DGII B03 (carga adicional, no anula)
 *   - Edición de condiciones comerciales por documento
 *
 * REGLAS DE SEGURIDAD (Cyber Neo):
 *   - motivo en revertir/NC/ND: mínimo 10 chars (audit trail no trivial).
 *   - pinSupervisor en NC/ND: 4-8 dígitos exactos (regex). Validación
 *     real timing-safe vive en el service.
 *   - max monto ND: 99,999,999.00 (cap defensivo anti overflow/error tipo).
 */

const { z } = require('zod');

const emitirFacturaSchema = z.object({
  ordenId:        z.string().uuid('ordenId debe ser UUID válido.'),
  forzarCredito:  z.boolean().optional().default(false),
});

const revertirSchema = z.object({
  motivo: z.string().min(10, 'Motivo requerido (mínimo 10 caracteres) para reversión.').max(500),
});

const notaCreditoSchema = z.object({
  motivo:        z.string().min(10, 'Motivo de mínimo 10 caracteres.').max(500),
  pinSupervisor: z.string().min(4).max(8).regex(/^\d+$/, 'PIN solo dígitos.'),
});

const notaDebitoSchema = z.object({
  motivo:        z.string().min(10, 'Motivo de mínimo 10 caracteres.').max(500),
  pinSupervisor: z.string().min(4).max(8).regex(/^\d+$/, 'PIN solo dígitos.'),
  monto:         z.number().positive('El monto debe ser positivo.').max(99_999_999),
  aplicarItbis:  z.boolean().optional().default(false),
});

// ─── Condiciones comerciales editables (fast-edit per documento) ───────────
const condFieldSchema = z.union([
  z.string().max(280).nullable(),
  z.object({
    incluir: z.boolean().default(true),
    texto:   z.string().max(280).optional().nullable().transform(v => v ?? ''),
  }),
]).optional().nullable();

const condicionesSchema = z.object({
  validez:  condFieldSchema,
  pago:     condFieldSchema,
  entrega:  condFieldSchema,
  garantia: condFieldSchema,
}).partial();

module.exports = {
  emitirFacturaSchema,
  revertirSchema,
  notaCreditoSchema,
  notaDebitoSchema,
  condicionesSchema,
  condFieldSchema,
};
