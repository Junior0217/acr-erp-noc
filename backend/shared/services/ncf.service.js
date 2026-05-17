/**
 * backend/shared/services/ncf.service.js
 *
 * Allocator atómico de secuencias NCF DGII. Único punto donde se incrementa
 * `ConfiguracionNCF.secuenciaActual`. Centralizar acá garantiza:
 *   1. Lock a nivel de fila Postgres (UPDATE-RETURNING). Dos requests
 *      concurrentes con el mismo `tipoNcf` serializan en el write-lock —
 *      jamás colisión de NCF.
 *   2. Validación de actividad + vencimiento + límite ANTES de incrementar
 *      (la UPDATE incluye los predicados; secuencias agotadas / vencidas
 *      devuelven 0 rows sin consumir).
 *   3. Auto-bootstrap idempotente: si la fila `tipoNcf` no existe, la
 *      crea via INSERT...ON CONFLICT DO NOTHING antes de UPDATE.
 *
 * SOLO el service expone estas operaciones. Cualquier endpoint que necesite
 * un NCF DGII (facturación, NC B04, ND B03) DEBE pasar por aquí — está
 * prohibido bypass via prisma.configuracionNCF.update inline en routers.
 *
 * Factory: createNcfService({ prisma })
 *   .nextNcfSequence({ tipoNcf, tx, padding=8, defaults? })
 *      → { prefijo, secuenciaActual, ncf } | throws NcfError
 *   .listConfiguraciones()
 *   .upsertConfiguracion(data)
 */

class NcfError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

// Defaults DGII para los 4 tipos canónicos. ON CONFLICT DO NOTHING los
// usa si la fila aún no existe (primera vez que se emite ese tipo).
const NCF_DEFAULTS = {
  'Fiscal':            { prefijo: 'B01', tipoDescripcion: 'Crédito Fiscal (B01)',      limite: 99_999_999 },
  'Consumidor Final':  { prefijo: 'B02', tipoDescripcion: 'Consumo Final (B02)',       limite: 99_999_999 },
  'Nota de Débito':    { prefijo: 'B03', tipoDescripcion: 'Notas de Débito (B03)',     limite: 99_999_999 },
  'Nota de Crédito':   { prefijo: 'B04', tipoDescripcion: 'Notas de Crédito (B04)',    limite: 99_999_999 },
};

function createNcfService(deps) {
  const { prisma } = deps;
  if (!prisma) throw new Error('createNcfService: prisma required');

  /**
   * Atomic NCF increment. Si `tx` viene, opera dentro de la transacción
   * (recomendado para emisión de factura — NCF y row factura deben commitear
   * juntos). Sin tx, opera con el prisma raíz.
   *
   * `defaults` permite override de prefijo/limite por tipo no listado en
   * NCF_DEFAULTS (futuros tipos DGII como E-CF cuando aplique).
   */
  async function nextNcfSequence({ tipoNcf, tx, padding = 8, defaults } = {}) {
    if (!tipoNcf || typeof tipoNcf !== 'string') {
      throw new NcfError(400, 'NCF_TIPO_REQUIRED', 'tipoNcf requerido.');
    }
    const db = tx ?? prisma;
    const def = defaults ?? NCF_DEFAULTS[tipoNcf];

    // Bootstrap: crea fila ConfiguracionNCF si no existe. ON CONFLICT noop.
    if (def) {
      await db.$executeRaw`
        INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
        VALUES (${def.prefijo}, ${tipoNcf}, ${def.tipoDescripcion}, 0, ${def.limite}, true, NOW(), NOW())
        ON CONFLICT ("tipoNcf") DO NOTHING
      `;
    }

    // UPDATE-RETURNING con predicados de actividad/limite/vencimiento.
    // Postgres adquiere row-lock al UPDATE, las concurrentes serializan.
    const rows = await db.$queryRaw`
      UPDATE "ConfiguracionNCF"
      SET    "secuenciaActual" = "secuenciaActual" + 1
      WHERE  "tipoNcf"         = ${tipoNcf}
        AND  "activo"          = true
        AND  "secuenciaActual" < "limite"
        AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
      RETURNING *
    `;
    if (!rows || rows.length === 0) {
      throw new NcfError(422, 'NCF_DEPLETED',
        `Sin secuencia NCF disponible para "${tipoNcf}". Verifica configuración (activo, vencimiento, límite).`);
    }
    const row = rows[0];
    const seq = String(row.secuenciaActual).padStart(padding, '0');
    return {
      prefijo:         row.prefijo,
      secuenciaActual: row.secuenciaActual,
      ncf:             `${row.prefijo}${seq}`,
    };
  }

  async function listConfiguraciones() {
    return prisma.configuracionNCF.findMany({ orderBy: { tipoNcf: 'asc' } });
  }

  /**
   * Upsert público para el endpoint admin /ncf-config. Permite que el owner
   * cree/edite configuraciones (prefijo, limite, vencimiento, activo) sin
   * tocar el contador `secuenciaActual` directamente — el contador SOLO se
   * mueve via nextNcfSequence.
   */
  async function upsertConfiguracion(data) {
    return prisma.configuracionNCF.upsert({
      where:  { tipoNcf: data.tipoNcf },
      create: { ...data, vencimiento: data.vencimiento ? new Date(data.vencimiento) : null },
      update: {
        prefijo:         data.prefijo,
        tipoDescripcion: data.tipoDescripcion,
        limite:          data.limite,
        vencimiento:     data.vencimiento ? new Date(data.vencimiento) : null,
        activo:          data.activo,
        // NOTA: NO actualizamos secuenciaActual desde aquí. El contador es
        // append-only via nextNcfSequence. Permitir manipulación expone a
        // saltos / duplicados que rompen compliance DGII.
      },
    });
  }

  return {
    NcfError,
    NCF_DEFAULTS,
    nextNcfSequence,
    listConfiguraciones,
    upsertConfiguracion,
  };
}

module.exports = createNcfService;
module.exports.NcfError = NcfError;
module.exports.NCF_DEFAULTS = NCF_DEFAULTS;
