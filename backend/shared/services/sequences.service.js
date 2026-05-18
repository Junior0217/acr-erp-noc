/**
 * backend/shared/services/sequences.service.js
 *
 * Generador atómico de códigos secuenciales (facturas, cotizaciones, RMAs, etc.).
 * Usa jsonb_set CAS sobre EmpresaPerfil.secuenciasConfig en una sola query —
 * concurrencia segura sin SELECT ... FOR UPDATE.
 *
 * Factory: createSequencesService({ prisma }) -> { SECUENCIA_DEFAULTS, generarSiguienteCodigo }
 *
 * Si EmpresaPerfil(id=1) no existe, hace upsert idempotente y reintenta una vez.
 * Si la entidad no está en SECUENCIA_DEFAULTS, lanza error (cero defaults silenciosos).
 */

const SECUENCIA_DEFAULTS = {
  factura:      { prefijo: 'FAC', actual: 0, padding: 6 },
  cotizacion:   { prefijo: 'COT', actual: 0, padding: 6 },
  producto:     { prefijo: 'ART', actual: 0, padding: 6 },
  servicio:     { prefijo: 'SVC', actual: 0, padding: 6 },
  cliente:      { prefijo: 'CLI', actual: 0, padding: 6 },
  rma:          { prefijo: 'RMA', actual: 0, padding: 5 },
  plan:         { prefijo: 'PLN', actual: 0, padding: 6 },
  notaCredito:  { prefijo: 'NC',  actual: 0, padding: 6 },
  notaDebito:   { prefijo: 'ND',  actual: 0, padding: 6 },
  // OT — visitas técnicas / instalaciones / mantenimientos. Faltaba en defaults
  // así que el preview /api/configuracion/secuencias/preview/ordenTrabajo
  // devolvía 400 → frontend mostraba "?-000001" en MiEmpresa.
  ordenTrabajo: { prefijo: 'OT',  actual: 0, padding: 6 },
  compra:       { prefijo: 'CMP', actual: 0, padding: 6 },
};

function createSequencesService({ prisma }) {
  if (!prisma) throw new Error('createSequencesService: prisma is required');

  async function generarSiguienteCodigo(entidad, tx) {
    const def = SECUENCIA_DEFAULTS[entidad];
    if (!def) throw new Error(`Entidad de secuencia desconocida: "${entidad}".`);
    const db = tx ?? prisma;
    const seedPath   = `{${entidad}}`;
    const actualPath = `{${entidad},actual}`;
    const rows = await db.$queryRawUnsafe(`
      UPDATE "EmpresaPerfil"
      SET    "secuenciasConfig" =
        jsonb_set(
          jsonb_set(
            COALESCE("secuenciasConfig", '{}'::jsonb),
            '${seedPath}',
            COALESCE("secuenciasConfig"->'${entidad}', $1::jsonb),
            true
          ),
          '${actualPath}',
          to_jsonb(
            COALESCE(("secuenciasConfig"->'${entidad}'->>'actual')::int, $2::int) + 1
          ),
          true
        )
      WHERE id = 1
      RETURNING ("secuenciasConfig"->'${entidad}'->>'prefijo') AS prefijo,
                ("secuenciasConfig"->'${entidad}'->>'actual')::int AS actual,
                ("secuenciasConfig"->'${entidad}'->>'padding')::int AS padding
    `, JSON.stringify(def), def.actual);
    if (!rows || rows.length === 0) {
      await prisma.empresaPerfil.upsert({
        where:  { id: 1 },
        update: {},
        create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig: { [entidad]: def } },
      });
      return generarSiguienteCodigo(entidad, tx);
    }
    const r = rows[0];
    return `${r.prefijo}-${String(r.actual).padStart(r.padding ?? def.padding, '0')}`;
  }

  return { SECUENCIA_DEFAULTS, generarSiguienteCodigo };
}

module.exports = createSequencesService;
module.exports.SECUENCIA_DEFAULTS = SECUENCIA_DEFAULTS;
