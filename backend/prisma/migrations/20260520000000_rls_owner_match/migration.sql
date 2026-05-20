-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 RLS — Owner Match (5to ciclo ADK v2).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Refina las políticas `rls_strict` (4to ciclo) para que SÍ verifiquen propiedad
-- por fila usando la columna owner que cada tabla expone en el schema actual:
--
--   Factura              → empleadoId    (Int? — empleado emisor del documento)
--   AuditLog             → usuarioId     (Int? — actor que disparó el evento)
--   OrdenTrabajo         → tecnicoId     (Int? — técnico asignado, único employee FK)
--   Cliente              → (sin owner)   — usa fallback presencia-de-employee_id
--   MovimientoInventario → (sin owner)   — usa fallback presencia-de-employee_id
--
-- Cláusula USING/WITH CHECK de cada tabla:
--
--   bypass ('app.bypass_rls'='true')
--   ∨ owner_col = current_setting('app.current_employee_id')::int  -- enforce
--   ∨ owner_col IS NULL                                            -- legacy safe
--
-- El último OR (`owner_col IS NULL`) es defense-in-depth para no bloquear
-- filas legacy creadas antes del rollout owner-tracking. Cuando el negocio
-- valide que todas las filas tienen owner poblado, se elimina ese OR en
-- una migración futura para alcanzar enforce 100%.
--
-- Cliente y MovimientoInventario NO tienen columna owner en el schema (ver
-- backend/prisma/schema.prisma); enforcear owner-by-row requeriría primero
-- una migración Prisma que agregue `empleadoCreadorId Int?` a esas tablas
-- (con backfill). Esa migración queda explícitamente fuera de scope (la regla
-- "NO modificar schema sin orden explícita" del CLAUDE.md aplica). Por ahora,
-- su política mantiene la semántica de v1: bypass o presencia de employee_id.
--
-- ÍNDICE PARCIAL — Factura(empleadoId) WHERE estado != 'Anulada':
--   La política con `empleadoId = current_setting(...)` hace que las queries
--   filtren por owner. Para evitar seq scans en producción cuando hay 50k+
--   facturas activas, se crea un índice parcial. Excluye Anuladas porque la
--   gran mayoría de queries útiles ignoran ese estado y el índice queda más
--   compacto (menor working set en RAM, lookup más rápido).

-- ─── Drop políticas v1 ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "rls_strict" ON "Factura";
DROP POLICY IF EXISTS "rls_strict" ON "Cliente";
DROP POLICY IF EXISTS "rls_strict" ON "MovimientoInventario";
DROP POLICY IF EXISTS "rls_strict" ON "OrdenTrabajo";
DROP POLICY IF EXISTS "rls_strict" ON "AuditLog";

-- ─── Factura: owner = empleadoId ─────────────────────────────────────────────
CREATE POLICY "rls_owner_match" ON "Factura"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR "empleadoId" IS NULL
    OR "empleadoId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR "empleadoId" IS NULL
    OR "empleadoId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
  );

-- ─── AuditLog: owner = usuarioId ─────────────────────────────────────────────
CREATE POLICY "rls_owner_match" ON "AuditLog"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR "usuarioId" IS NULL
    OR "usuarioId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR "usuarioId" IS NULL
    OR "usuarioId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
  );

-- ─── OrdenTrabajo: owner = tecnicoId (técnico asignado) ──────────────────────
-- El schema no expone "createdById", pero `tecnicoId` es el único FK a Empleado.
-- Aceptable porque las OT se asignan al crearse y rara vez reasignan; cuando
-- el modelo agregue `creadoPorId` explícito, esta política se ajusta.
CREATE POLICY "rls_owner_match" ON "OrdenTrabajo"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR "tecnicoId" IS NULL
    OR "tecnicoId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR "tecnicoId" IS NULL
    OR "tecnicoId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
  );

-- ─── Cliente: sin owner column — fallback semántica v1 ───────────────────────
CREATE POLICY "rls_owner_match" ON "Cliente"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

-- ─── MovimientoInventario: sin owner column — fallback v1 ────────────────────
CREATE POLICY "rls_owner_match" ON "MovimientoInventario"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

-- ─── Comentarios doc ─────────────────────────────────────────────────────────
COMMENT ON POLICY "rls_owner_match" ON "Factura"
  IS 'L1.1 owner-match — empleadoId = current_employee_id (NULL legacy safe).';
COMMENT ON POLICY "rls_owner_match" ON "AuditLog"
  IS 'L1.1 owner-match — usuarioId = current_employee_id (NULL legacy safe).';
COMMENT ON POLICY "rls_owner_match" ON "OrdenTrabajo"
  IS 'L1.1 owner-match — tecnicoId = current_employee_id (NULL legacy safe).';
COMMENT ON POLICY "rls_owner_match" ON "Cliente"
  IS 'L1.1 owner-match — sin owner col; fallback presencia employee_id.';
COMMENT ON POLICY "rls_owner_match" ON "MovimientoInventario"
  IS 'L1.1 owner-match — sin owner col; fallback presencia employee_id.';

-- ─── Índice parcial Factura(empleadoId) WHERE estado != 'Anulada' ────────────
-- Optimiza scans del path crítico (lista facturas del cajero en POS Kanban).
-- `IF NOT EXISTS` lo hace idempotente — re-run de la migración no falla.
CREATE INDEX IF NOT EXISTS "factura_owner_active_idx"
  ON "Factura" ("empleadoId")
  WHERE "estado" != 'Anulada';

COMMENT ON INDEX "factura_owner_active_idx"
  IS 'L1.1 owner-match — acelera filter por empleadoId en facturas activas (excluye Anulada).';
