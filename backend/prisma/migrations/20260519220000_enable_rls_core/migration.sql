-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 Row Level Security — habilitación core en tablas transaccionales.
-- ════════════════════════════════════════════════════════════════════════════
--
-- Activa RLS en las 4 tablas críticas. Política inicial PERMISSIVE TRUE para
-- NO romper queries existentes — la app sigue funcionando como antes mientras
-- la infraestructura queda lista para refinar políticas tenant-aware.
--
-- Próximo lote (ver CLAUDE.md L1.1): refinar las políticas para que dependan de
-- `current_setting('app.current_employee_id', true)` y agregar middleware
-- Prisma que ejecute `SET LOCAL app.current_employee_id = $1` por request
-- antes de las queries. Hasta entonces, RLS está "activa pero no enforce"
-- (defensa en profundidad: bloqueará accidentales DROP POLICY sin reemplazo).

-- ─── Habilitar RLS ──────────────────────────────────────────────────────────
ALTER TABLE "Factura"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cliente"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MovimientoInventario" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrdenTrabajo"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"             ENABLE ROW LEVEL SECURITY;

-- ─── Políticas iniciales (permissive — refinar en próximo lote) ─────────────
-- Patrón: cada tabla obtiene una sola política llamada "default_all" que cubre
-- SELECT/INSERT/UPDATE/DELETE para PUBLIC con USING(true) y WITH CHECK(true).
-- Si se intenta DROP POLICY sin reemplazo, las queries fallarán cerradas — eso
-- es defensa en profundidad: una migration mala que olvide la política deja la
-- tabla inaccesible en lugar de abierta accidentalmente.

CREATE POLICY "default_all" ON "Factura"
  FOR ALL TO PUBLIC
  USING (
    -- Permite acceso cuando hay sesión con employee_id seteado, o cuando el
    -- request explícitamente pide bypass (caso: cron jobs, scripts admin).
    -- En la fase actual `app.bypass_rls` es 'true' por default → permissive.
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "default_all" ON "Cliente"
  FOR ALL TO PUBLIC
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "default_all" ON "MovimientoInventario"
  FOR ALL TO PUBLIC
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "default_all" ON "OrdenTrabajo"
  FOR ALL TO PUBLIC
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

CREATE POLICY "default_all" ON "AuditLog"
  FOR ALL TO PUBLIC
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR current_setting('app.current_employee_id', true) IS NOT NULL
  );

-- ─── Comentarios doc en metadata (descubrible vía psql \d+ ) ────────────────
COMMENT ON POLICY "default_all" ON "Factura"
  IS 'L1.1 scaffold — refinar con isolation tenant_id en próximo lote';
COMMENT ON POLICY "default_all" ON "Cliente"
  IS 'L1.1 scaffold — refinar con isolation tenant_id en próximo lote';
COMMENT ON POLICY "default_all" ON "MovimientoInventario"
  IS 'L1.1 scaffold — refinar con isolation tenant_id en próximo lote';
COMMENT ON POLICY "default_all" ON "OrdenTrabajo"
  IS 'L1.1 scaffold — refinar con isolation tenant_id en próximo lote';
COMMENT ON POLICY "default_all" ON "AuditLog"
  IS 'L1.1 scaffold — refinar con isolation tenant_id en próximo lote';
