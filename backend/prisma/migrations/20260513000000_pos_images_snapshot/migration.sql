-- POS richer cards + inventory sync + fiscal snapshot.
-- Idempotente — el runtime también las asegura vía ensureSchemaColumns().

ALTER TABLE "Producto"
  ADD COLUMN IF NOT EXISTS "descripcion" TEXT,
  ADD COLUMN IF NOT EXISTS "imagenUrl"   TEXT;

ALTER TABLE "ItemCatalogo"
  ADD COLUMN IF NOT EXISTS "imagenUrl"   TEXT,
  ADD COLUMN IF NOT EXISTS "productoId"  INTEGER REFERENCES "Producto"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "ItemCatalogo_productoId_idx" ON "ItemCatalogo"("productoId");

ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "snapshot" JSONB;
