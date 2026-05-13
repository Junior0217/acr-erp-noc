-- PIN supervisor + cobro mixto + código catálogo.
-- Idempotente — runtime también lo asegura en ensureSchemaColumns().

ALTER TABLE "EmpresaPerfil"
  ADD COLUMN IF NOT EXISTS "pinSupervisor" TEXT NOT NULL DEFAULT '1234';

ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "pagos" JSONB;

ALTER TABLE "ItemCatalogo"
  ADD COLUMN IF NOT EXISTS "codigo" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ItemCatalogo_codigo_key" ON "ItemCatalogo"("codigo");
