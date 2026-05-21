-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 RLS — Índice parcial para histórico de Anuladas (7mo ciclo ADK v3).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Complementa `factura_owner_active_idx` (creado en 20260520010000_rls_enforced,
-- WHERE estado != 'Anulada') con su simétrico para histórico:
--
--   `factura_anulada_idx ON Factura(empleadoId, fechaEmision DESC)
--    WHERE estado = 'Anulada'`
--
-- Caso de uso:
--   El endpoint `listarMisFacturasRls` acepta `?includeAnuladas=true` para que
--   un cajero revise sus facturas anuladas históricas. Sin un índice dedicado,
--   esa query degrada a `Factura_empleadoId_idx` simple — para empleados con
--   50k+ filas históricas, eso es seq scan dentro del bucket del empleado.
--
-- Con este índice, ambos paths (activo y anulado) tienen partial-cover:
--   - activo  → factura_owner_active_idx (WHERE estado != 'Anulada')
--   - anulado → factura_anulada_idx       (WHERE estado = 'Anulada')
--
-- El planner de Postgres elige el índice correcto comparando el predicado de
-- la query (`estado = 'Anulada'` en el path histórico) con los predicados
-- declarados de cada índice parcial. Match exacto = index scan; sin match
-- exacto = degrada al índice general.
--
-- Costo de almacenamiento: si la tabla tiene N filas, en producción típica
-- ~5-10% están Anuladas. El índice crece ~5-10% del tamaño base — barato.
-- Las inserciones de Anulada (raras: reversiones, NC) pagan el O(log N) extra.
-- Las inserciones de filas NO-Anuladas (mayoría) no tocan este índice.

CREATE INDEX IF NOT EXISTS "factura_anulada_idx"
  ON "Factura" ("empleadoId", "fechaEmision" DESC)
  WHERE "estado" = 'Anulada';

COMMENT ON INDEX "factura_anulada_idx"
  IS 'L1.1 simetría — owner + fecha desc parcial para histórico Anulada. Pair de factura_owner_active_idx.';
