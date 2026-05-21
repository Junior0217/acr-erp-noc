-- ════════════════════════════════════════════════════════════════════════════
-- Cotizador Libre Pro — borradores persistentes (ciclo 12 ADK v3).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Crea la tabla `CotizacionLibreDraft` para que usuarios con permiso
-- `cotizador_libre_manual` puedan guardar borradores de cotizaciones de
-- proyectos de infraestructura/CCTV con auto-save (debounced 3s desde el
-- frontend). La tabla es independiente del pipeline NCF/Factura:
--   - NO consume secuencias NCF.
--   - NO descuenta stock (movimientoInventario).
--   - NO genera AuditCaja.
--   - NO RLS aún — el permiso server-side cubre el acceso por usuario; si más
--     adelante se exige owner-match estricto, añadir policy similar a Factura
--     (empleadoId IS NULL OR = current_employee_id).
--
-- Constraint clave: UNIQUE(empleadoId, numeroDocumento). Permite upsert
-- idempotente desde el auto-save sin riesgo de duplicar bajo contención.
-- Índice secundario (empleadoId, updatedAt DESC) para listado "mis drafts
-- recientes" en futuros paneles admin.

CREATE TABLE "CotizacionLibreDraft" (
  "id"              TEXT        NOT NULL,
  "empleadoId"      INTEGER     NOT NULL,
  "numeroDocumento" TEXT        NOT NULL,
  "cliente"         JSONB       NOT NULL,
  "items"           JSONB       NOT NULL,
  "condiciones"     JSONB       NOT NULL,
  "meta"            JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CotizacionLibreDraft_pkey" PRIMARY KEY ("id")
);

-- FK a Empleado con cascade — si se hard-deletea un empleado, sus drafts
-- desaparecen automáticamente (consistencia referencial). Soft-delete del
-- empleado deja los drafts intactos; el runAudit cross-tabla los flagea
-- como huérfanos para purga manual del operador.
ALTER TABLE "CotizacionLibreDraft"
  ADD CONSTRAINT "CotizacionLibreDraft_empleadoId_fkey"
  FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CotizacionLibreDraft_empleadoId_numeroDocumento_key"
  ON "CotizacionLibreDraft" ("empleadoId", "numeroDocumento");

-- Índice compuesto para "mis drafts ordenados por reciente":
-- SELECT ... WHERE empleadoId=$1 ORDER BY updatedAt DESC LIMIT N.
CREATE INDEX "CotizacionLibreDraft_empleadoId_updatedAt_idx"
  ON "CotizacionLibreDraft" ("empleadoId", "updatedAt" DESC);

-- Índice plano sobre updatedAt para GC futuro (purgar drafts inactivos > 90d).
CREATE INDEX "CotizacionLibreDraft_updatedAt_idx"
  ON "CotizacionLibreDraft" ("updatedAt");

COMMENT ON TABLE "CotizacionLibreDraft"
  IS 'Borradores editables del Cotizador Libre Pro. Independiente del pipeline NCF/Factura.';
