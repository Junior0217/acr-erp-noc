-- Migration: add nomenclature codes + seed ConfiguracionNCF counters

ALTER TABLE "Servicio" ADD COLUMN IF NOT EXISTS "noServicio" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Servicio_noServicio_key" ON "Servicio"("noServicio");

ALTER TABLE "OrdenTrabajo" ADD COLUMN IF NOT EXISTS "noOT" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "OrdenTrabajo_noOT_key" ON "OrdenTrabajo"("noOT");

-- Seed nomenclature counters (idempotent)
INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
VALUES
  ('SV-', 'SV',  'Servicios',          0, 99999, true, NOW(), NOW()),
  ('OT-', 'OT',  'Ordenes de Trabajo',  0, 99999, true, NOW(), NOW()),
  ('COT-','COT', 'Cotizaciones',         0, 99999, true, NOW(), NOW())
ON CONFLICT ("tipoNcf") DO NOTHING;
