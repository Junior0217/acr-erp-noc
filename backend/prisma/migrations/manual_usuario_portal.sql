-- ================================================================
-- MANUAL MIGRATION: UsuarioPortal + Asistencia geo-fields
-- Run via Supabase SQL Editor after unpausing the project.
-- ================================================================

-- 1. UsuarioPortal table
CREATE TABLE IF NOT EXISTS "UsuarioPortal" (
    "id"           TEXT        NOT NULL,
    "noUsuario"    TEXT        NOT NULL,
    "nombre"       TEXT        NOT NULL,
    "email"        TEXT        NOT NULL,
    "passwordHash" TEXT        NOT NULL,
    "telefono"     TEXT,
    "activo"       BOOLEAN     NOT NULL DEFAULT true,
    "clienteId"    TEXT,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "UsuarioPortal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UsuarioPortal_noUsuario_key" ON "UsuarioPortal"("noUsuario");
CREATE UNIQUE INDEX IF NOT EXISTS "UsuarioPortal_email_key"     ON "UsuarioPortal"("email");
CREATE INDEX        IF NOT EXISTS "UsuarioPortal_email_idx"     ON "UsuarioPortal"("email");
CREATE INDEX        IF NOT EXISTS "UsuarioPortal_clienteId_idx" ON "UsuarioPortal"("clienteId");

ALTER TABLE "UsuarioPortal"
  ADD CONSTRAINT IF NOT EXISTS "UsuarioPortal_clienteId_fkey"
  FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Geo fields for Asistencia
ALTER TABLE "Asistencia" ADD COLUMN IF NOT EXISTS "latitud"  TEXT;
ALTER TABLE "Asistencia" ADD COLUMN IF NOT EXISTS "longitud" TEXT;

-- 3. Migrate existing PRT- portal users → UsuarioPortal
-- (run only once; adjust if emails conflict)
INSERT INTO "UsuarioPortal" ("id", "noUsuario", "nombre", "email", "passwordHash", "clienteId", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'USR-' || LPAD(ROW_NUMBER() OVER (ORDER BY "createdAt")::text, 4, '0'),
  "razonSocial",
  "email",
  COALESCE("passwordHash", ''),
  "id",   -- portal user's own client record becomes their linked client
  "createdAt",
  NOW()
FROM "Cliente"
WHERE "noCliente" LIKE 'PRT-%'
  AND "passwordHash" IS NOT NULL
  AND "passwordHash" != ''
ON CONFLICT ("email") DO NOTHING;

-- 4. Null-out passwordHash on PRT- Cliente rows (portal login now via UsuarioPortal)
UPDATE "Cliente" SET "passwordHash" = NULL WHERE "noCliente" LIKE 'PRT-%';
