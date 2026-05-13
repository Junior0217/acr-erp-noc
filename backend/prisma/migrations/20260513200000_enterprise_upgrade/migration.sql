-- ENTERPRISE UPGRADE: discount config, audit caja, pipeline, series, reservas, bundles, costo promedio.
-- Idempotente. Runtime también lo asegura en ensureSchemaColumns().

-- ─── Empresa: descuento máximo por cajero ──────────────────────────────────
ALTER TABLE "EmpresaPerfil"
  ADD COLUMN IF NOT EXISTS "maxDescuentoCajero" INTEGER NOT NULL DEFAULT 15;

-- ─── Producto: costo promedio ponderado ────────────────────────────────────
ALTER TABLE "Producto"
  ADD COLUMN IF NOT EXISTS "costoPromedio" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- ─── Factura: etapa del pipeline (Kanban cotizaciones) ─────────────────────
ALTER TABLE "Factura"
  ADD COLUMN IF NOT EXISTS "etapaPipeline" TEXT NOT NULL DEFAULT 'Borrador';
CREATE INDEX IF NOT EXISTS "Factura_etapaPipeline_idx" ON "Factura"("etapaPipeline");

-- ─── AuditCaja ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AuditCaja" (
  "id"         SERIAL PRIMARY KEY,
  "tipo"       TEXT NOT NULL,
  "empleadoId" INTEGER,
  "facturaId"  TEXT,
  "monto"      DECIMAL(12,2),
  "descPct"    DECIMAL(5,2),
  "detalle"    TEXT,
  "ip"         TEXT,
  "ua"         TEXT,
  "createdAt"  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AuditCaja_tipo_idx"       ON "AuditCaja"("tipo");
CREATE INDEX IF NOT EXISTS "AuditCaja_empleadoId_idx" ON "AuditCaja"("empleadoId");
CREATE INDEX IF NOT EXISTS "AuditCaja_facturaId_idx"  ON "AuditCaja"("facturaId");
CREATE INDEX IF NOT EXISTS "AuditCaja_createdAt_idx"  ON "AuditCaja"("createdAt");

-- ─── ProductoSerial ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductoSerial" (
  "id"             SERIAL PRIMARY KEY,
  "productoId"     INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
  "serie"          TEXT NOT NULL,
  "estado"         TEXT NOT NULL DEFAULT 'Disponible',
  "ubicacion"     TEXT,
  "facturaId"      TEXT,
  "garantiaHasta"  TIMESTAMP,
  "notas"          TEXT,
  "createdAt"      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductoSerial_productoId_serie_key" ON "ProductoSerial"("productoId","serie");
CREATE INDEX IF NOT EXISTS "ProductoSerial_estado_idx"     ON "ProductoSerial"("estado");
CREATE INDEX IF NOT EXISTS "ProductoSerial_facturaId_idx"  ON "ProductoSerial"("facturaId");

-- ─── ReservaInventario ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReservaInventario" (
  "id"          SERIAL PRIMARY KEY,
  "productoId"  INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
  "facturaId"   TEXT,
  "cantidad"    INTEGER NOT NULL,
  "expiraEn"    TIMESTAMP NOT NULL,
  "liberada"    BOOLEAN NOT NULL DEFAULT false,
  "motivo"      TEXT,
  "createdAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ReservaInventario_productoId_idx" ON "ReservaInventario"("productoId");
CREATE INDEX IF NOT EXISTS "ReservaInventario_facturaId_idx"  ON "ReservaInventario"("facturaId");
CREATE INDEX IF NOT EXISTS "ReservaInventario_expiraEn_idx"   ON "ReservaInventario"("expiraEn");
CREATE INDEX IF NOT EXISTS "ReservaInventario_liberada_idx"   ON "ReservaInventario"("liberada");

-- ─── ProductoBundle (cross-sell) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProductoBundle" (
  "id"         SERIAL PRIMARY KEY,
  "padreId"    INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
  "hijoId"     INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
  "score"      INTEGER NOT NULL DEFAULT 1,
  "motivo"     TEXT,
  "createdAt"  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductoBundle_padreId_hijoId_key" ON "ProductoBundle"("padreId","hijoId");
CREATE INDEX IF NOT EXISTS "ProductoBundle_padreId_idx" ON "ProductoBundle"("padreId");
