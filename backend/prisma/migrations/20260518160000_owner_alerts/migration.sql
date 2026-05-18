-- Mejora #5 — Owner God-Mode Alerts.
--
-- Tabla append-only de notificaciones críticas para el owner. Se llena
-- desde el servicio shared/services/owner-alerts.service.js. El owner las
-- consume via SSE en tiempo real + endpoint de listado paginado.

CREATE TABLE "OwnerAlert" (
  "id"             SERIAL NOT NULL,
  "tipo"           TEXT   NOT NULL,
  "severity"       TEXT   NOT NULL DEFAULT 'warn',
  "empleadoId"     INTEGER,
  "empleadoNombre" TEXT,
  "resourceType"   TEXT,
  "resourceId"     TEXT,
  "payload"        JSONB  NOT NULL,
  "ip"             TEXT,
  "ua"             TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ackBy"          INTEGER,
  "ackAt"          TIMESTAMP(3),

  CONSTRAINT "OwnerAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OwnerAlert_tipo_idx"            ON "OwnerAlert"("tipo");
CREATE INDEX "OwnerAlert_severity_idx"        ON "OwnerAlert"("severity");
CREATE INDEX "OwnerAlert_createdAt_idx"       ON "OwnerAlert"("createdAt");
CREATE INDEX "OwnerAlert_ackAt_idx"           ON "OwnerAlert"("ackAt");
CREATE INDEX "OwnerAlert_tipo_createdAt_idx"  ON "OwnerAlert"("tipo", "createdAt");

-- Append-only: bloquear DELETE/TRUNCATE/UPDATE-de-payload via trigger.
-- Permitir UPDATE solo de columnas de ack (ackBy/ackAt).
CREATE OR REPLACE FUNCTION _owner_alert_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OwnerAlert es append-only (mejora #5). DELETE bloqueado. txid=%', txid_current()
      USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' THEN
    -- Solo permitir cambio de ackBy/ackAt. Cualquier otro update = tampering.
    IF NEW."tipo"           IS DISTINCT FROM OLD."tipo"           OR
       NEW."severity"       IS DISTINCT FROM OLD."severity"       OR
       NEW."empleadoId"     IS DISTINCT FROM OLD."empleadoId"     OR
       NEW."empleadoNombre" IS DISTINCT FROM OLD."empleadoNombre" OR
       NEW."resourceType"   IS DISTINCT FROM OLD."resourceType"   OR
       NEW."resourceId"     IS DISTINCT FROM OLD."resourceId"     OR
       NEW."payload"        IS DISTINCT FROM OLD."payload"        OR
       NEW."ip"             IS DISTINCT FROM OLD."ip"             OR
       NEW."ua"             IS DISTINCT FROM OLD."ua"             OR
       NEW."createdAt"      IS DISTINCT FROM OLD."createdAt"      THEN
      RAISE EXCEPTION 'OwnerAlert payload es inmutable. Solo ackBy/ackAt pueden cambiar. txid=%', txid_current()
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS owner_alert_block_mutation ON "OwnerAlert";
CREATE TRIGGER owner_alert_block_mutation
  BEFORE UPDATE OR DELETE ON "OwnerAlert"
  FOR EACH ROW
  EXECUTE FUNCTION _owner_alert_block_mutation();

DROP TRIGGER IF EXISTS owner_alert_block_truncate ON "OwnerAlert";
CREATE TRIGGER owner_alert_block_truncate
  BEFORE TRUNCATE ON "OwnerAlert"
  FOR EACH STATEMENT
  EXECUTE FUNCTION _audit_block_mutation();
