-- Device fingerprint + 2FA backup codes.
-- Idempotente — ensureSchemaColumns también las asegura runtime.

ALTER TABLE "Empleado"
  ADD COLUMN IF NOT EXISTS "backupCodes" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "SessionToken"
  ADD COLUMN IF NOT EXISTS "deviceHash" TEXT;
CREATE INDEX IF NOT EXISTS "SessionToken_deviceHash_idx" ON "SessionToken"("deviceHash");

CREATE TABLE IF NOT EXISTS "DeviceFingerprint" (
  "id"          SERIAL PRIMARY KEY,
  "empleadoId"  INTEGER NOT NULL REFERENCES "Empleado"("id") ON DELETE CASCADE,
  "hash"        TEXT NOT NULL,
  "label"       TEXT,
  "ip"          TEXT,
  "userAgent"   TEXT,
  "primerLogin" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ultimoLogin" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceFingerprint_empleadoId_hash_key"
  ON "DeviceFingerprint"("empleadoId","hash");
CREATE INDEX IF NOT EXISTS "DeviceFingerprint_empleadoId_idx" ON "DeviceFingerprint"("empleadoId");
CREATE INDEX IF NOT EXISTS "DeviceFingerprint_ultimoLogin_idx" ON "DeviceFingerprint"("ultimoLogin");
