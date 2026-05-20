-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 RLS — Enforced Forward (6to ciclo ADK v3).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Sube el listón del owner-match a "enforce hacia adelante" sin romper filas
-- legacy:
--
--   1) CHECK CONSTRAINT (NOT VALID) sobre Factura.empleadoId — exige NOT NULL
--      solo para filas NUEVAS (INSERT/UPDATE). Las filas pre-rollout con NULL
--      siguen visibles (no se invalidan retroactivamente). Cuando el equipo
--      complete el backfill, puede correr `VALIDATE CONSTRAINT` para alcanzar
--      enforcement 100% sin re-emitir la migración.
--
--   2) ÍNDICE COMPUESTO PARCIAL — Factura(empleadoId, fechaEmision DESC)
--      WHERE estado != 'Anulada'. Acelera el query crítico del POS Kanban:
--      "lista mis últimas facturas activas". El owner_match policy filtra por
--      empleadoId; el ORDER BY fechaEmision DESC LIMIT 50 lo cubre el índice
--      sin sort step adicional.
--
--   3) RLS estricta para Producto y Servicio — eran tablas con datos
--      maestros que el front carga via SELECT sin owner. Mantienen la
--      semántica laxa (bypass O presencia de employee_id) — no exigen owner
--      match porque el catálogo es transversal por diseño. Las tablas que
--      contienen historial transaccional (Factura, OrdenTrabajo, AuditLog)
--      siguen con rls_owner_match.
--
-- Path de adopción:
--   Fase A (este lote)  → constraint NOT VALID + índice compuesto + Producto/Servicio RLS lax
--   Fase B (futuro)     → backfill empleadoId NULL en Factura legacy
--   Fase C (futuro)     → ALTER TABLE … VALIDATE CONSTRAINT factura_empleado_required_forward
--   Fase D (futuro)     → quitar OR "empleadoId IS NULL" de la policy rls_owner_match
--   Fase E (futuro)     → ALTER DATABASE … RESET app.bypass_rls (enforce universal)

-- ─── Constraint forward-only sobre Factura.empleadoId ────────────────────────
-- NOT VALID = se aplica solo a filas INSERT/UPDATE después de esta migración;
-- las filas existentes con NULL no son afectadas hasta que se valide.
-- IF NOT EXISTS no es soportado en ADD CONSTRAINT — usamos DO-block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'factura_empleado_required_forward'
      AND conrelid = '"Factura"'::regclass
  ) THEN
    ALTER TABLE "Factura"
      ADD CONSTRAINT "factura_empleado_required_forward"
      CHECK ("empleadoId" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT "factura_empleado_required_forward" ON "Factura"
  IS 'L1.1 enforce forward — INSERT/UPDATE deben setear empleadoId. NOT VALID hasta backfill.';

-- ─── Índice compuesto parcial — POS Kanban hot path ──────────────────────────
-- Cubre: SELECT * FROM "Factura" WHERE "empleadoId" = $1 AND "estado" != 'Anulada'
--        ORDER BY "fechaEmision" DESC LIMIT 50;
-- Postgres puede satisfacer el ORDER BY desde el índice (sin sort), y el WHERE
-- partial evita indexar filas anuladas (working set más compacto).
CREATE INDEX IF NOT EXISTS "factura_owner_fecha_active_idx"
  ON "Factura" ("empleadoId", "fechaEmision" DESC)
  WHERE "estado" != 'Anulada';

COMMENT ON INDEX "factura_owner_fecha_active_idx"
  IS 'L1.1 enforce — owner + fecha desc parcial para listado POS Kanban (excluye Anulada).';

-- ─── RLS lax para Producto y Servicio (catálogo transversal) ─────────────────
-- Los catálogos NO tienen owner — todos los empleados deben listar todos los
-- productos/servicios al hacer una venta. Pero RLS sigue siendo útil para
-- bloquear sesiones que NO han declarado employee_id (anti-bypass general).
-- Política simétrica a v1: bypass explícito O presencia de employee_id.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Producto') THEN
    EXECUTE 'ALTER TABLE "Producto" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "rls_catalogo_lax" ON "Producto"';
    EXECUTE $POLICY$
      CREATE POLICY "rls_catalogo_lax" ON "Producto"
        FOR ALL TO PUBLIC
        USING (
          current_setting('app.bypass_rls', true) = 'true'
          OR current_setting('app.current_employee_id', true) IS NOT NULL
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'true'
          OR current_setting('app.current_employee_id', true) IS NOT NULL
        )
    $POLICY$;
    COMMENT ON POLICY "rls_catalogo_lax" ON "Producto"
      IS 'L1.1 lax — catálogo transversal: bypass O employee_id presente.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Servicio') THEN
    EXECUTE 'ALTER TABLE "Servicio" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "rls_catalogo_lax" ON "Servicio"';
    EXECUTE $POLICY$
      CREATE POLICY "rls_catalogo_lax" ON "Servicio"
        FOR ALL TO PUBLIC
        USING (
          current_setting('app.bypass_rls', true) = 'true'
          OR current_setting('app.current_employee_id', true) IS NOT NULL
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'true'
          OR current_setting('app.current_employee_id', true) IS NOT NULL
        )
    $POLICY$;
    COMMENT ON POLICY "rls_catalogo_lax" ON "Servicio"
      IS 'L1.1 lax — catálogo transversal: bypass O employee_id presente.';
  END IF;
END $$;
