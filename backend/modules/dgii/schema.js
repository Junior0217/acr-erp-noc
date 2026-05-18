/**
 * backend/modules/dgii/schema.js
 *
 * Zod DTOs del módulo DGII (Fase 3).
 * F1 scope: CRUD Compras (feed del reporte 606).
 *
 * Catálogos cerrados via z.enum — anti SQLi + anti datos basura DGII.
 *   tipoBienServicio: 01-11 (Norma 06-2018 §2.1)
 *   formaPago:        01-07 (Norma 06-2018 §2.2)
 *   tipoRetencionIsr: 01-07 (Norma 06-2018 §2.3)
 */

const { z } = require('zod');

// ── Catálogos DGII (constantes — no van a BD, son enum literales) ──────────────
const TIPO_BIEN_SERVICIO = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'];
const FORMA_PAGO         = ['01', '02', '03', '04', '05', '06', '07'];
const TIPO_RETENCION_ISR = ['01', '02', '03', '04', '05', '06', '07'];

// Periodo "YYYYMM" — usado por endpoints de reportes (F2/F3) y futuros filtros.
const periodoSchema = z.string().regex(/^\d{6}$/, 'Periodo debe ser YYYYMM.');

// NCF físico (B##########) o e-CF (E##########) — 11 chars exactos.
const ncfSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[BE]\d{10}$/, 'NCF debe ser B/E + 10 dígitos.');

// ── Compra DTOs ──────────────────────────────────────────────────────────────
//
// Reglas condicionales (superRefine):
//   esGastoInformal=false (default) -> suplidorId y ncfProveedor son OBLIGATORIOS.
//   esGastoInformal=true            -> suplidorId y ncfProveedor opcionales/nullables.
// El servicio re-valida y filtra fuera del 606 cualquier row con
// esGastoInformal=true (regla DGII: solo gastos con NCF van al fiscal).
const compraBaseShape = {
  suplidorId:              z.string().uuid('suplidorId debe ser UUID válido.').optional().nullable(),
  ncfProveedor:            ncfSchema.optional().nullable(),
  ncfModificado:           ncfSchema.optional().nullable(),
  esGastoInformal:         z.boolean().optional().default(false),
  tipoBienServicio:        z.enum(TIPO_BIEN_SERVICIO),
  fechaComprobante:        z.coerce.date(),
  fechaPago:               z.coerce.date().optional().nullable(),
  formaPago:               z.enum(FORMA_PAGO),
  montoServicios:          z.coerce.number().nonnegative().default(0),
  montoBienes:             z.coerce.number().nonnegative().default(0),
  itbisFacturado:          z.coerce.number().nonnegative().default(0),
  itbisRetenido:           z.coerce.number().nonnegative().default(0),
  itbisProporcionalidad:   z.coerce.number().nonnegative().default(0),
  itbisLlevadoCosto:       z.coerce.number().nonnegative().default(0),
  itbisPorAdelantar:       z.coerce.number().nonnegative().default(0),
  itbisPercibido:          z.coerce.number().nonnegative().default(0),
  tipoRetencionIsr:        z.enum(TIPO_RETENCION_ISR).optional().nullable(),
  montoRetencionRenta:     z.coerce.number().nonnegative().default(0),
  isrPercibido:            z.coerce.number().nonnegative().default(0),
  impuestoSelectivoConsumo: z.coerce.number().nonnegative().default(0),
  otrosImpuestos:          z.coerce.number().nonnegative().default(0),
  propinaLegal:            z.coerce.number().nonnegative().default(0),
  notas:                   z.string().max(1000).optional().nullable(),
};

// superRefine fuerza la regla "fiscal vs informal":
//   - Si esGastoInformal=false -> exige suplidorId + ncfProveedor.
//   - Si esGastoInformal=true  -> los acepta null/undefined.
function _refineCompra(val, ctx) {
  if (val.esGastoInformal) return;
  if (!val.suplidorId) {
    ctx.addIssue({ path: ['suplidorId'], code: z.ZodIssueCode.custom,
      message: 'suplidorId es obligatorio cuando esGastoInformal=false.' });
  }
  if (!val.ncfProveedor) {
    ctx.addIssue({ path: ['ncfProveedor'], code: z.ZodIssueCode.custom,
      message: 'ncfProveedor es obligatorio cuando esGastoInformal=false.' });
  }
}

const compraSchema       = z.object(compraBaseShape).superRefine(_refineCompra);
const compraUpdateSchema = z.object(compraBaseShape).partial();

const listComprasQuerySchema = z.object({
  search:     z.string().optional(),
  suplidorId: z.string().uuid().optional(),
  desde:      z.string().optional(),
  hasta:      z.string().optional(),
  page:       z.string().optional().default('1'),
  limit:      z.string().optional().default('50'),
});

module.exports = {
  TIPO_BIEN_SERVICIO,
  FORMA_PAGO,
  TIPO_RETENCION_ISR,
  periodoSchema,
  ncfSchema,
  compraSchema,
  compraUpdateSchema,
  listComprasQuerySchema,
};
