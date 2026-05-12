ALTER TABLE "OrdenTrabajo" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "OrdenTrabajo_deletedAt_idx" ON "OrdenTrabajo"("deletedAt");
