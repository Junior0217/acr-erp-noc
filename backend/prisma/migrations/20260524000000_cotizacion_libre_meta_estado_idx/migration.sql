-- ════════════════════════════════════════════════════════════════════════════
-- Cotizador Libre — índice de expresión sobre meta->>'estado'.
-- ════════════════════════════════════════════════════════════════════════════
--
-- `getStats` (panel admin del Owner) agrupa los drafts por estado. Antes hacía
-- findMany de TODAS las filas + agrupación en JS (O(n) memoria). Ahora usa
-- `GROUP BY "meta"->>'estado'` en Postgres; este índice de expresión permite
-- que la agregación y el filtro por estado sean index scans en vez de seq scan
-- completo cuando la tabla crezca.
--
-- IF NOT EXISTS: idempotente (reaplicar no falla).

CREATE INDEX IF NOT EXISTS "CotizacionLibreDraft_meta_estado_idx"
  ON "CotizacionLibreDraft" (("meta"->>'estado'));

COMMENT ON INDEX "CotizacionLibreDraft_meta_estado_idx"
  IS 'Expression index sobre meta->>estado — acelera GROUP BY estado de getStats.';
