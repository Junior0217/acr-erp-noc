-- Adds Nota de Débito (DGII B03) support to Factura + renames motivo column
-- to one shared by NC/ND. Idempotent: safe to re-run.

-- 1. Renombrar motivoNotaCredito → motivoNotaModificatoria si aún existe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Factura' AND column_name = 'motivoNotaCredito'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Factura' AND column_name = 'motivoNotaModificatoria'
  ) THEN
    ALTER TABLE "Factura" RENAME COLUMN "motivoNotaCredito" TO "motivoNotaModificatoria";
  END IF;
END $$;

-- 2. ADD COLUMN esNotaDebito (idempotente).
ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "esNotaDebito" BOOLEAN NOT NULL DEFAULT false;

-- 3. Si el RENAME no aplicó porque ambas columnas existen (corner case),
--    crea motivoNotaModificatoria vacía y descarta la legacy.
ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "motivoNotaModificatoria" TEXT;

-- 4. Indexes.
CREATE INDEX IF NOT EXISTS "Factura_esNotaDebito_idx" ON "Factura"("esNotaDebito");

-- 5. Seed idempotente NCF B03 (Nota de Débito DGII).
INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
VALUES ('B03', 'Nota de Débito', 'Notas de Débito (DGII B03)', 0, 99999999, true, NOW(), NOW())
ON CONFLICT ("tipoNcf") DO NOTHING;

-- 6. Asegura que B04 también esté sembrado (idempotente — coexiste con seedNomenclaturas).
INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
VALUES ('B04', 'Nota de Crédito', 'Notas de Crédito (DGII B04)', 0, 99999999, true, NOW(), NOW())
ON CONFLICT ("tipoNcf") DO NOTHING;
