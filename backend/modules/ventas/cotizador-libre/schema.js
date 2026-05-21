/**
 * backend/modules/ventas/cotizador-libre/schema.js
 *
 * Validadores Zod del módulo Cotizador Libre. NO toca BD: el payload viaja
 * crudo desde el frontend (texto editable libre) y solo viaja al render
 * PDF en memoria. La validación aquí es la única barrera contra payloads
 * malformados o explosivos.
 *
 * Ciclo 13: añade `lugarInstalacion` y `fotos[]` por ítem para anexos
 * técnicos del proyecto CCTV. Las fotos viajan como data URI base64
 * (image/jpeg|png|webp). El frontend pre-comprime a ≤1280px / quality 0.7
 * antes de codificar — el cap server-side es defensa-en-profundidad.
 */

const { z } = require('zod');

const MAX_LINEAS        = 200;
const MAX_TEXT          = 2000;
const MAX_FOTOS_X_ITEM  = 5;
const MAX_FOTO_BYTES    = 320 * 1024;   // 320 KB por foto (≈240KB JPEG real tras base64)
const MAX_LUGAR_LEN     = 300;
const MAX_MODELO_LEN    = 120;

// Helper: tolera "0" / "" / null en cantidades/precios y normaliza a número.
const numero = z.preprocess(
  (v) => (v === '' || v == null ? 0 : v),
  z.coerce.number().finite().min(0),
);

// Foto individual: data URI base64. Validamos:
//   - prefix `data:image/(jpeg|png|webp);base64,`
//   - tamaño bruto ≤ MAX_FOTO_BYTES (la string base64 sin contar el prefix)
// El frontend ya comprime — esto es el guardrail server-side. Si alguien intenta
// inyectar 10MB de base64, Zod lo rechaza antes de tocar BD/PDF.
const DATA_URI_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const fotoSchema = z.object({
  dataUri: z.string().refine((s) => {
    const m = DATA_URI_RE.exec(s);
    if (!m) return false;
    // Tamaño aproximado del binario original = base64.length * 3 / 4 (sin padding).
    return m[2].length <= MAX_FOTO_BYTES;
  }, `Foto inválida: debe ser data URI image/jpeg|png|webp y pesar ≤${Math.floor(MAX_FOTO_BYTES / 1024)}KB.`),
  nombre: z.string().max(160).optional().nullable(),
  modelo: z.string().max(MAX_MODELO_LEN).optional().nullable(),
});

// Categorías canónicas — usadas para el resumen ejecutivo agrupado. El
// frontend sugiere via dropdown; el server las normaliza (lowercase).
const CATEGORIAS_VALIDAS = [
  'Equipos', 'Cableado', 'Servicios', 'Capacitación', 'Software',
  'Mantenimiento', 'Garantía Extendida', 'Otros',
];

const itemSchema = z.object({
  codigo:           z.string().max(120).optional().nullable(),
  descripcion:      z.string().min(1).max(MAX_TEXT),
  cantidad:         z.coerce.number().int().min(0).max(99999).default(1),
  precioUnit:       numero,
  aplicaItbis:      z.boolean().optional().default(true),
  lugarInstalacion: z.string().max(MAX_LUGAR_LEN).optional().nullable(),
  fotos:            z.array(fotoSchema).max(MAX_FOTOS_X_ITEM).optional().default([]),
  categoria:        z.string().max(40).optional().nullable(),
  // GPS auto-tag (browser geolocation al adjuntar foto). Lat/lng como floats.
  // Opcional — falla silenciosa si el usuario denegó permisos.
  gps:              z.object({
    lat: z.coerce.number().gte(-90).lte(90),
    lng: z.coerce.number().gte(-180).lte(180),
  }).partial().optional().nullable(),
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

// Bloques opcionales del PDF — toggleable + texto editable. Mantienen la
// filosofía "siempre puedes escribir; el toggle solo controla aparición".
const bloqueOpcionalSchema = z.object({
  activa: z.boolean().optional().default(false),
  texto:  z.string().max(8000).optional().default(''),
}).optional();

const ESTADOS_VALIDOS = ['Borrador', 'Enviada', 'Aprobada', 'Convertida', 'Perdida'];

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

  // ── Bloques opcionales del PDF (ciclo 16) ────────────────────────────────
  // Carta de presentación: página 1 dedicada antes del documento principal.
  portada:              bloqueOpcionalSchema,
  // Sección "Sobre RA Networks": eslogan + bullets + datos. Aparece entre
  // cliente y items table cuando se activa.
  sobreEmpresa:         bloqueOpcionalSchema,
  // Resumen ejecutivo: tabla agrupada por categoría pre-tabla principal.
  mostrarResumen:       z.boolean().optional().default(false),
  // Estado del documento (cambia badge + watermark en el PDF).
  estado:               z.enum(ESTADOS_VALIDOS).optional().default('Borrador'),
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
    portada:              bloqueOpcionalSchema,
    sobreEmpresa:         bloqueOpcionalSchema,
    mostrarResumen:       z.boolean().optional(),
    estado:               z.enum(ESTADOS_VALIDOS).optional(),
  }).partial().optional().nullable(),
  // Solo usuarios con `ventas:cotizador_libre_global` / `sistema:owner` pueden
  // pasar este campo. El controller valida y lo ignora si el caller no tiene
  // permiso global — fail-closed por defecto.
  targetEmpleadoId: z.coerce.number().int().positive().optional().nullable(),
});

const numeroParamSchema = z.string().min(1).max(40);

// Query schema para list/get cuando un usuario global filtra por empleado.
const targetEmpleadoQuerySchema = z.object({
  empleadoId: z.coerce.number().int().positive().optional(),
  limit:      z.coerce.number().int().positive().max(100).optional(),
}).partial();

module.exports = {
  cotizadorLibreSchema,
  draftPayloadSchema,
  numeroParamSchema,
  targetEmpleadoQuerySchema,
  MAX_LINEAS,
  MAX_FOTOS_X_ITEM,
  MAX_FOTO_BYTES,
  CATEGORIAS_VALIDAS,
  ESTADOS_VALIDOS,
};
