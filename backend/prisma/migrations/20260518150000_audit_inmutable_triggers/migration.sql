-- Mejora #3 — Restricción de borrado/alteración a nivel base de datos.
--
-- AuditLog y AuditCaja son tablas append-only POR CONTRATO en código, pero
-- si un atacante roba un JWT y logra ejecución arbitraria de SQL (ej. via
-- $queryRawUnsafe, ORM bypass, SQL injection futura), podría borrar las
-- huellas de su propio fraude. La defensa: triggers BEFORE DELETE/UPDATE
-- que RAISE EXCEPTION rechazando cualquier cambio.
--
-- Implementación:
--   - Función `_audit_block_mutation()` que siempre lanza excepción.
--   - Trigger BEFORE UPDATE OR DELETE en AuditLog y AuditCaja → bloquea
--     mutaciones row-level.
--   - Trigger BEFORE TRUNCATE (statement-level) → bloquea TRUNCATE TABLE.
--
-- Owner legítimo si necesita inspeccionar o purgar (compliance, retention):
--   psql> SET session_replication_role = 'replica'; -- disables triggers
--   ... do work ...
--   psql> SET session_replication_role = 'origin';
-- Pero esto requiere acceso DIRECTO a la BD (no via la app), lo cual
-- exige SSH/credenciales de DBA — atacante con solo JWT no llega.
--
-- Cyber Neo:
--   - El trigger se ejecuta ANTES del cambio, en TODOS los roles
--     (incluyendo owner role de la tabla via conexión normal).
--   - SECURITY DEFINER NO usado — la función corre con privilegios del
--     caller, no escalan.
--   - Mensaje incluye `txid_current()` para correlación forense en logs.

-- Función bloqueante reutilizable.
CREATE OR REPLACE FUNCTION _audit_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Tabla % es append-only por seguridad (mejora #3). Operación % bloqueada. txid=%',
    TG_TABLE_NAME, TG_OP, txid_current()
    USING ERRCODE = '23514'; -- check_violation
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION _audit_block_mutation() IS
  'Bloquea DELETE/UPDATE/TRUNCATE en tablas de auditoría. Atacante con JWT y SQL injection no puede borrar huellas.';

-- ─── AuditLog ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS auditlog_block_update_delete ON "AuditLog";
CREATE TRIGGER auditlog_block_update_delete
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION _audit_block_mutation();

DROP TRIGGER IF EXISTS auditlog_block_truncate ON "AuditLog";
CREATE TRIGGER auditlog_block_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT
  EXECUTE FUNCTION _audit_block_mutation();

-- ─── AuditCaja ───────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS auditcaja_block_update_delete ON "AuditCaja";
CREATE TRIGGER auditcaja_block_update_delete
  BEFORE UPDATE OR DELETE ON "AuditCaja"
  FOR EACH ROW
  EXECUTE FUNCTION _audit_block_mutation();

DROP TRIGGER IF EXISTS auditcaja_block_truncate ON "AuditCaja";
CREATE TRIGGER auditcaja_block_truncate
  BEFORE TRUNCATE ON "AuditCaja"
  FOR EACH STATEMENT
  EXECUTE FUNCTION _audit_block_mutation();

-- ─── CotizacionEvento (también es hash-chain append-only) ───────────────────
DROP TRIGGER IF EXISTS cotevento_block_update_delete ON "CotizacionEvento";
CREATE TRIGGER cotevento_block_update_delete
  BEFORE UPDATE OR DELETE ON "CotizacionEvento"
  FOR EACH ROW
  EXECUTE FUNCTION _audit_block_mutation();

DROP TRIGGER IF EXISTS cotevento_block_truncate ON "CotizacionEvento";
CREATE TRIGGER cotevento_block_truncate
  BEFORE TRUNCATE ON "CotizacionEvento"
  FOR EACH STATEMENT
  EXECUTE FUNCTION _audit_block_mutation();
