/**
 * backend/modules/ventas/pos/schema.js
 *
 * Zod DTOs del módulo POS. Único punto donde se declara validación de input
 * para los 3 endpoints (verificar-pin, venta, factura manual).
 *
 * Notas de seguridad/diseño:
 * - clienteId SIEMPRE obligatorio (cero walk-in / nombre libre).
 * - pagos array capped a 20 (anti-DoS).
 * - monto pago min 0.01 (1 centavo) — bloquea pagos basura.
 * - linea POS catálogo: exactly-one-of itemCatalogoId | productoId.
 */

const { z } = require('zod');

// ─── Pagos mixtos ──────────────────────────────────────────────────────────
const pagoMetodoSchema = z.object({
  metodo: z.enum(['Efectivo', 'Transferencia', 'Tarjeta', 'Cheque', 'Otro']),
  // Tope mínimo defensivo: 0.01 (1 centavo) — positive() acepta 1e-12.
  monto:  z.number().min(0.01, 'Monto debe ser ≥ RD$0.01.').max(10_000_000, 'Monto excesivo.'),
  refer:  z.string().max(60).optional().nullable(),
});

// ─── Línea POS desde catálogo (acepta itemCatalogoId XOR productoId) ──────
const lineaPOSCatalogoSchema = z.object({
  itemCatalogoId:      z.string().uuid().optional(),
  productoId:          z.number().int().positive().optional(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
}).refine(
  l => (l.itemCatalogoId && !l.productoId) || (!l.itemCatalogoId && l.productoId),
  { message: 'Cada línea debe traer itemCatalogoId (UUID) o productoId (Int), no ambos.' },
);

// ─── /pos/venta payload ───────────────────────────────────────────────────
const posVentaSchema = z.object({
  clienteId:           z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente).' }),
  tipoNcf:             z.string().optional(),
  applyItbis:          z.boolean().optional().default(true),
  diasVence:           z.number().int().min(0).max(365).optional().default(30),
  esCotizacion:        z.boolean().optional().default(false),
  descuentoGlobalPct:  z.number().min(0).max(100).optional().default(0),
  descuentoGlobalMonto:z.number().min(0).optional().default(0),
  pinSupervisor:       z.string().max(20).optional(),
  pagos:               z.array(pagoMetodoSchema).max(20, 'Máximo 20 métodos de pago por factura.').optional(),
  lineas:              z.array(lineaPOSCatalogoSchema).min(1),
  condicionesOverride: z.object({
    validez:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    pago:     z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    entrega:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    garantia: z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
  }).optional(),
  notasOverride: z.string().max(2000).nullable().optional(),
});

// ─── Línea simple para factura manual (siempre productoId) ────────────────
const lineaPOSSchema = z.object({
  productoId:          z.number().int().positive(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
});

const facturaManualSchema = z.object({
  clienteId:    z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente en CRM).' }),
  itbis:        z.boolean().optional().default(true),
  diasVence:    z.number().int().min(0).max(365).optional().default(30),
  esCotizacion: z.boolean().optional().default(false),
  lineas:       z.array(lineaPOSSchema).min(1, 'Se requiere al menos una línea.'),
});

// ─── /pos/verificar-pin ───────────────────────────────────────────────────
// PIN: 4-12 dígitos numéricos. La comparación timing-safe vive en el service.
const verifyPinSchema = z.object({
  pin: z.string().regex(/^\d{4,12}$/, 'PIN debe contener 4-12 dígitos.'),
});

module.exports = {
  pagoMetodoSchema,
  lineaPOSCatalogoSchema,
  posVentaSchema,
  lineaPOSSchema,
  facturaManualSchema,
  verifyPinSchema,
};
