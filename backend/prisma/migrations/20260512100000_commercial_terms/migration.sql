-- Condiciones comerciales dinámicas: defaults por empresa + override por documento.
-- Idempotente: IF NOT EXISTS por si la columna se agregó manualmente en algún entorno.

ALTER TABLE "EmpresaPerfil"
  ADD COLUMN IF NOT EXISTS "condicionesDefault" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "condiciones" JSONB;
