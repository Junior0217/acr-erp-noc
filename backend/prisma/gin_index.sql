CREATE INDEX IF NOT EXISTS ot_metadatos_gin ON "OrdenTrabajo" USING GIN (metadatos);
