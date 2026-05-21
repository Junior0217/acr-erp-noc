/**
 * backend/modules/ventas/cotizador-libre/schema.js
 *
 * Validadores Zod del módulo Cotizador Libre. NO toca BD: el payload viaja
 * crudo desde el frontend (texto editable libre) y solo viaja al render
 * PDF en memoria. La validación aquí es la única barrera contra payloads
 * malformados o explosivos.
 */

const { z } = require('zod');

const MAX_LINEAS = 200;
const MAX_TEXT   = 2000;

// Helper: tolera "0" / "" / null en cantidades/precios y normaliza a número.
const numero = z.preprocess(
  (v) => (v === '' || v == null ? 0 : v),
  z.coerce.number().finite().min(0),
);

const itemSchema = z.object({
  codigo:        z.string().max(120).optional().nullable(),
  descripcion:   z.string().min(1).max(MAX_TEXT),
  cantidad:      z.coerce.number().int().min(0).max(99999).default(1),
  precioUnit:    numero,
  aplicaItbis:   z.boolean().optional().default(true),
});

const clienteSchema = z.object({
  razonSocial:   z.string().min(1).max(300),
  direccion:     z.string().max(500).optional().nullable(),
  telefono:      z.string().max(60).optional().nullable(),
  contacto:      z.string().max(200).optional().nullable(),
  rnc:           z.string().max(40).optional().nullable(),
});

const condicionFieldSchema = z.union([
  z.string().max(MAX_TEXT),
  z.object({
    incluir: z.boolean().optional().default(false),
    texto:   z.string().max(MAX_TEXT).optional().default(''),
  }),
  z.null(),
]).optional();

const condicionesSchema = z.object({
  validez:  condicionFieldSchema,
  pago:     condicionFieldSchema,
  entrega:  condicionFieldSchema,
  garantia: condicionFieldSchema,
  notas:    condicionFieldSchema,
}).default({});

const cotizadorLibreSchema = z.object({
  // Encabezado del documento (no es la entidad Empresa de la BD — el frontend
  // lo pasa hardcoded; un cliente malicioso podría intentar inyectar otros
  // valores, pero como NO persistimos NADA, el peor caso es un PDF con label
  // distinto que el usuario imprimió a propósito).
  numeroDocumento: z.string().max(40).optional().default(''),
  titulo:          z.string().max(120).optional().default('COTIZACIÓN'),
  cliente:         clienteSchema,
  items:           z.array(itemSchema).min(1).max(MAX_LINEAS),
  aplicaItbisGlobal:    z.boolean().optional().default(true),
  porcentajeItbis:      z.coerce.number().min(0).max(40).optional().default(18),
  descuentoGlobalPct:   z.coerce.number().min(0).max(100).optional().default(0),
  descuentoGlobalMonto: z.coerce.number().min(0).optional().default(0),
  condiciones:          condicionesSchema,
  // Override del nombre comercial que va al header del PDF. Si está vacío,
  // service usa 'RA Networks & Solutions' como default.
  empresaNombre:        z.string().max(120).optional().nullable(),
  empresaWebsite:       z.string().max(200).optional().nullable(),
  empresaTagline:       z.string().max(200).optional().nullable(),
});

// Schema del PUT draft. Reutiliza la estructura del PDF schema pero relaja
// items (permite cantidad 0 / precio 0 — el cajero puede guardar borradores
// incompletos). El render PDF sí exige descripcion no-vacía + min 1 línea.
const draftPayloadSchema = z.object({
  numeroDocumento: z.string().min(1).max(40),
  cliente:         clienteSchema,
  items:           z.array(itemSchema).max(MAX_LINEAS),
  condiciones:     condicionesSchema,
  meta:            z.object({
    aplicaItbisGlobal:    z.boolean().optional(),
    porcentajeItbis:      z.coerce.number().min(0).max(40).optional(),
    descuentoGlobalPct:   z.coerce.number().min(0).max(100).optional(),
    descuentoGlobalMonto: z.coerce.number().min(0).optional(),
  }).partial().optional().nullable(),
});

const numeroParamSchema = z.string().min(1).max(40);

module.exports = {
  cotizadorLibreSchema,
  draftPayloadSchema,
  numeroParamSchema,
  MAX_LINEAS,
};
