/**
 * backend/modules/admin/empresa/ncf/schema.js
 *
 * Zod DTO del sub-módulo NCF (config administrativa). El allocator atómico
 * vive en shared/services/ncf.service.js. Acá solo validamos el input del
 * endpoint de configuración (owner-facing).
 *
 * REGLAS DURAS (Cyber Neo / Defense-in-Depth):
 *
 *   1) `prefijo` DEBE pertenecer al catálogo cerrado DGII Norma 06-2018:
 *      B01, B02, B03, B04, B14, B15. Cualquier intento de guardar otro
 *      prefijo (ej. COT, FAC, OT, B99) → 400 PREFIJO_FISCAL_INVALIDO.
 *      Esto previene que prefijos internos contaminen la tabla
 *      ConfiguracionNCF y que el reporte fiscal incluya nomenclaturas
 *      no autorizadas.
 *
 *   2) `tipoNcf` debe ser uno de los nombres canónicos del catálogo. Mapea
 *      1:1 con `prefijo` — discrepancia → 400 NCF_TIPO_MISMATCH.
 *
 *   3) `secuenciaActual` NUNCA se setea arbitrariamente desde este endpoint.
 *      El contador es append-only via nextNcfSequence (shared service). El
 *      schema lo acepta solo para bootstrap inicial (default 0); el service
 *      lo IGNORA en updates.
 */

const { z } = require('zod');

// Catálogo cerrado DGII (Norma General 06-2018 + 05-2019). Cualquier inserción
// con prefijo fuera de esta whitelist es rechazada antes de tocar la BD.
//
// NCF físicos (preimpresos):
//   B01 — Crédito Fiscal     (factura a empresa con RNC, deducible ITBIS)
//   B02 — Consumidor Final   (factura a persona, NO deducible)
//   B03 — Nota de Débito     (cargo adicional contra factura emitida)
//   B04 — Nota de Crédito    (anulación parcial/total de factura)
//   B11 — Comprobantes Compras (proveedor informal sin RNC)
//   B12 — Registro Único de Ingresos (otros ingresos no facturables)
//   B13 — Gastos Menores     (gastos sin comprobante del proveedor)
//   B14 — Régimen Especial   (exonerados — Zonas Francas / diplomáticos)
//   B15 — Gubernamental      (ventas al Estado dominicano)
//   B16 — Exportaciones      (ventas al exterior, exentas de ITBIS)
//   B17 — Pagos al Exterior  (retención ISR a no-residentes)
const NCF_CATALOGO_DGII = {
  B01: 'Crédito Fiscal',
  B02: 'Consumidor Final',
  B03: 'Nota de Débito',
  B04: 'Nota de Crédito',
  B11: 'Comprobantes Compras',
  B12: 'Registro Único de Ingresos',
  B13: 'Gastos Menores',
  B14: 'Régimen Especial',
  B15: 'Gubernamental',
  B16: 'Exportaciones',
  B17: 'Pagos al Exterior',
};
const NCF_PREFIJOS_VALIDOS = Object.keys(NCF_CATALOGO_DGII);
const NCF_TIPOS_VALIDOS    = Object.values(NCF_CATALOGO_DGII);

const ncfConfigSchema = z.object({
  prefijo:         z.string().min(1).max(3).transform(s => s.toUpperCase()),
  tipoNcf:         z.string().min(1),
  tipoDescripcion: z.string().min(1),
  secuenciaActual: z.number().int().min(0).default(0),
  limite:          z.number().int().min(1).default(9_999_999),
  vencimiento:     z.string().datetime().optional().nullable(),
  activo:          z.boolean().default(true),
}).superRefine((val, ctx) => {
  if (!NCF_PREFIJOS_VALIDOS.includes(val.prefijo)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prefijo'],
      message: `Prefijo "${val.prefijo}" no es un NCF fiscal DGII válido. Permitidos: ${NCF_PREFIJOS_VALIDOS.join(', ')}.`,
      params: { fiscalCode: 'PREFIJO_FISCAL_INVALIDO' },
    });
    return;
  }
  // Coherencia prefijo ↔ tipoNcf: el cliente DEBE mandar el par correcto
  // para evitar drift posterior (ej. prefijo=B04 con tipoNcf="Fiscal").
  const tipoEsperado = NCF_CATALOGO_DGII[val.prefijo];
  if (val.tipoNcf !== tipoEsperado) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tipoNcf'],
      message: `tipoNcf "${val.tipoNcf}" no coincide con prefijo ${val.prefijo} (esperado: "${tipoEsperado}").`,
      params: { fiscalCode: 'NCF_TIPO_MISMATCH' },
    });
  }
});

module.exports = {
  ncfConfigSchema,
  NCF_CATALOGO_DGII,
  NCF_PREFIJOS_VALIDOS,
  NCF_TIPOS_VALIDOS,
};
