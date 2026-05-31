-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 RLS — CotizacionLibreDraft (cierra el gap de la tabla de borradores).
-- ════════════════════════════════════════════════════════════════════════════
--
-- La migración 20260522000000_cotizaciones_libres_draft creó la tabla SIN RLS
-- ("NO RLS aún — si más adelante se exige owner-match estricto, añadir policy
-- similar a Factura"). Esta migración añade esa policy.
--
-- Política IDÉNTICA a `rls_owner_match` de Factura (20260520000000_rls_owner_match):
--   USING/WITH CHECK:
--     bypass ('app.bypass_rls'='true')                                    -- escape hatch
--     ∨ empleadoId = NULLIF(current_setting('app.current_employee_id'),'')::int  -- owner
--
-- `empleadoId` es NOT NULL en esta tabla (a diferencia de Factura legacy), así
-- que se omite la rama `IS NULL`. `NULLIF(...,'')::int` evita el error de cast
-- cuando el setting está vacío/ausente (→ NULL → la comparación da NULL/false).
--
-- POR QUÉ ES SEGURO (no rompe nada hoy):
--   La BD corre con `app.bypass_rls='true'` por defecto (ALTER DATABASE en
--   20260519230000). El módulo cotizador-libre consulta con `prisma` plano (sin
--   withRlsContext), heredando ese bypass → la rama bypass de la policy SIEMPRE
--   pasa. Idéntico a Producto/Servicio/Factura, que ya tienen RLS habilitada y
--   el app funciona en producción. Cuando el módulo adopte `withRlsContext`
--   (bypass='false'), el enforce owner-match entra en vigor automáticamente.
--   El verify público (/api/publico/verify/:hash) y el modo global del Owner
--   siguen usando prisma plano (bypass) → no se ven afectados.
--
-- Idempotente: ENABLE + DROP POLICY IF EXISTS + CREATE dentro de DO-block.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'CotizacionLibreDraft') THEN
    EXECUTE 'ALTER TABLE "CotizacionLibreDraft" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "rls_owner_match" ON "CotizacionLibreDraft"';
    EXECUTE $POLICY$
      CREATE POLICY "rls_owner_match" ON "CotizacionLibreDraft"
        FOR ALL TO PUBLIC
        USING (
          current_setting('app.bypass_rls', true) = 'true'
          OR "empleadoId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'true'
          OR "empleadoId" = NULLIF(current_setting('app.current_employee_id', true), '')::int
        )
    $POLICY$;
    COMMENT ON POLICY "rls_owner_match" ON "CotizacionLibreDraft"
      IS 'L1.1 owner-match — bypass O empleadoId = current_employee_id. empleadoId NOT NULL (sin rama IS NULL legacy de Factura).';
  END IF;
END $$;
