-- Factura.cotizacionOrigenId: self-relation para versiones derivadas de una
-- cotización (ej. la misma cotización con X% de descuento). Distinto de
-- facturaOrigenId, que es exclusivo de NC/ND fiscales. Idempotente: el
-- bootstrap DDL de server.js también la asegura vía pooler.
ALTER TABLE "Factura" ADD COLUMN IF NOT EXISTS "cotizacionOrigenId" TEXT;
CREATE INDEX IF NOT EXISTS "Factura_cotizacionOrigenId_idx" ON "Factura"("cotizacionOrigenId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Factura_cotizacionOrigenId_fkey') THEN
    ALTER TABLE "Factura" ADD CONSTRAINT "Factura_cotizacionOrigenId_fkey"
      FOREIGN KEY ("cotizacionOrigenId") REFERENCES "Factura"(id) ON DELETE SET NULL;
  END IF;
END $$;
