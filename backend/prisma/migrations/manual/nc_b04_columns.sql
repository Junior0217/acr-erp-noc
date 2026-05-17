-- Adds Nota de Crédito (DGII B04) columns to Factura.
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-running is safe.

ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "facturaOrigenId"    TEXT,
  ADD COLUMN IF NOT EXISTS "esNotaCredito"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "motivoNotaCredito"  TEXT;

-- FK self-reference. Drop+add para idempotencia entre re-runs.
ALTER TABLE "Factura"
  DROP CONSTRAINT IF EXISTS "Factura_facturaOrigenId_fkey";

ALTER TABLE "Factura"
  ADD CONSTRAINT "Factura_facturaOrigenId_fkey"
  FOREIGN KEY ("facturaOrigenId") REFERENCES "Factura"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Factura_facturaOrigenId_idx" ON "Factura"("facturaOrigenId");
CREATE INDEX IF NOT EXISTS "Factura_esNotaCredito_idx"   ON "Factura"("esNotaCredito");

-- Semilla idempotente del NCF B04 (Nota de Crédito DGII).
INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
VALUES ('B04', 'Nota de Crédito', 'Notas de Crédito (DGII B04)', 0, 99999999, true, NOW(), NOW())
ON CONFLICT ("tipoNcf") DO NOTHING;
