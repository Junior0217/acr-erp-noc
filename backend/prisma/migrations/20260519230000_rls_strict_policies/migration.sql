-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 RLS — Refinamiento estricto (4to ciclo ADK v2).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Sustituye las políticas scaffold "default_all" (que usaban `COALESCE(..., 'true')`
-- y por tanto eran efectivamente abiertas) por políticas ESTRICTAS:
--
--   Acceso permitido SOLO si:
--     1. La sesión declara explícitamente bypass:
--          current_setting('app.bypass_rls', true) = 'true'
--        (típico para cron, scripts admin, migraciones, conexiones bootstrap)
--     2. O la sesión declara un employee_id (no NULL):
--          current_setting('app.current_employee_id', true) IS NOT NULL
--        (típico para requests HTTP autenticados — el middleware Prisma
--        ejecuta `SET LOCAL app.current_employee_id = $userId` por transacción).
--
-- Sin COALESCE laxo: si una sesión no setea NI bypass NI employee_id, la
-- política bloquea por completo SELECT/INSERT/UPDATE/DELETE. Eso es enforce
-- real, no scaffold.
--
-- Backward-compat de producción:
--   Para no romper queries existentes que aún no adoptaron el wrapper Prisma
--   `prisma.withRlsContext(userId, fn)`, seteamos en la BASE DE DATOS el
--   parámetro `app.bypass_rls = 'true'` como default. Toda nueva conexión
--   hereda bypass; las queries que quieran enforce REAL hacen
--   `SET LOCAL app.bypass_rls = 'false'; SET LOCAL app.current_employee_id = $1;`
--   dentro de una transacción (lo que hace el extension Prisma en server.js).
--
-- Path de migración progresiva:
--   Fase 1 (este lote)  → políticas estrictas + default bypass + extension lista
--   Fase 2 (próximo)    → migrar endpoints críticos a `withRlsContext` opt-in
--   Fase 3 (futuro)     → quitar `ALTER DATABASE … SET app.bypass_rls = 'true'`
--                          → enforce universal, requiere 100% endpoints migrados
--
-- Si el rol de migración carece de perms para `ALTER DATABASE`, el DO-block
-- captura el error y emite NOTICE — la migración no se aborta. En ese caso,
-- aplicar manualmente: `ALTER ROLE <app_role> SET app.bypass_rls = 'true';`.

-- ─── Bypass por default a nivel de base de datos (tolerante a falta de perms)
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET app.bypass_rls = %L',
    current_database(),
    'true'
  );
EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
  RAISE NOTICE 'No se pudo ALTER DATABASE SET app.bypass_rls (perm denied): %', SQLERRM;
END $$;

-- ─── Drop políticas viejas (idempotente) ─────────────────────────────────────
DROP POLICY IF EXISTS "default_all" ON "Factura";
DROP POLICY IF EXISTS "default_all" ON "Cliente";
DROP POLICY IF EXISTS "default_all" ON "MovimientoInventario";
DROP POLICY IF EXISTS "default_all" ON "OrdenTrabajo";
DROP POLICY IF EXISTS "default_all" ON "AuditLog";

-- ─── Políticas estrictas (4to ciclo ADK v2) ──────────────────────────────────
-- Patrón unificado: requiere bypass explícito O employee_id explícito. Sin
-- COALESCE laxo. Cualquier sesión sin setting queda BLOQUEADA por la política.

CREATE POLICY "rls_strict" ON "Factura"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "rls_strict" ON "Cliente"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "rls_strict" ON "MovimientoInventario"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "rls_strict" ON "OrdenTrabajo"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "rls_strict" ON "AuditLog"
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

-- ─── Comentarios doc (descubrible vía psql \d+) ──────────────────────────────
COMMENT ON POLICY "rls_strict" ON "Factura"
  IS 'L1.1 strict — bypass explicito O employee_id seteado. Wrapper: prisma.withRlsContext';
COMMENT ON POLICY "rls_strict" ON "Cliente"
  IS 'L1.1 strict — bypass explicito O employee_id seteado. Wrapper: prisma.withRlsContext';
COMMENT ON POLICY "rls_strict" ON "MovimientoInventario"
  IS 'L1.1 strict — bypass explicito O employee_id seteado. Wrapper: prisma.withRlsContext';
COMMENT ON POLICY "rls_strict" ON "OrdenTrabajo"
  IS 'L1.1 strict — bypass explicito O employee_id seteado. Wrapper: prisma.withRlsContext';
COMMENT ON POLICY "rls_strict" ON "AuditLog"
  IS 'L1.1 strict — bypass explicito O employee_id seteado. Wrapper: prisma.withRlsContext';
