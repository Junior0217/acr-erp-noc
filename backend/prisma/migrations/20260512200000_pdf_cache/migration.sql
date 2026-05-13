-- Cache de PDFs generados por Puppeteer + URL pública en Supabase Storage.
-- Idempotente — la columna también se asegura en runtime via ensureSchemaColumns().

ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "pdfUrl" TEXT;
