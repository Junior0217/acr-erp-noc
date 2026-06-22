-- Cliente.tipoServicio: persiste el giro/servicio del cliente (dropdown
-- "Tipo Servicio" del formulario CRM, antes cosmético). Nullable para
-- clientes legacy. IF NOT EXISTS → idempotente con el bootstrap DDL de
-- server.js que también la asegura vía pooler (migrate deploy falla en
-- Render por IPv6 del DIRECT_URL).
ALTER TABLE "Cliente" ADD COLUMN IF NOT EXISTS "tipoServicio" TEXT;
