/**
 * backend/modules/ventas/carrito/schema.js
 */

const { z } = require('zod');

const patchCarritoSchema = z.object({
  clienteId:  z.string().uuid().nullable().optional(),
  applyItbis: z.boolean().optional(),
  diasVence:  z.number().int().min(0).max(365).optional(),
});

const addItemSchema = z.object({
  productoId:          z.number().int().positive(),
  cantidad:            z.number().int().positive().default(1),
  precioOverride:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
});

const patchItemSchema = z.object({
  cantidad:            z.number().int().min(1).optional(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional(),
  descuentoMonto:      z.number().min(0).optional(),
});

const _textoCond = z.object({
  incluir: z.boolean(),
  texto:   z.string().max(500).nullable().optional(),
}).optional();

const checkoutSchema = z.object({
  esCotizacion:         z.boolean().optional().default(false),
  tipoNcfOverride:      z.string().optional(),
  descuentoGlobalPct:   z.number().min(0).max(100).optional().default(0),
  descuentoGlobalMonto: z.number().min(0).optional().default(0),
  pinSupervisor:        z.string().max(20).optional(),
  condicionesOverride:  z.object({
    validez:  _textoCond,
    pago:     _textoCond,
    entrega:  _textoCond,
    garantia: _textoCond,
  }).optional(),
  notasOverride: z.string().max(2000).nullable().optional(),
});

module.exports = {
  patchCarritoSchema,
  addItemSchema,
  patchItemSchema,
  checkoutSchema,
};
