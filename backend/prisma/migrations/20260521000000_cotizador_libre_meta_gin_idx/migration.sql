-- ════════════════════════════════════════════════════════════════════════════
-- Cotizador Libre — índice GIN sobre meta (jsonb_path_ops).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Permite que `findByVerifyHash(hash)` use index scan (vs seq scan completo)
-- al buscar drafts por `meta.verifyHash`. Crítico cuando crezca la tabla a
-- >1k drafts: la consulta es del endpoint público /api/publico/verify/:hash
-- (cliente escanea QR del PDF) y debe responder en <50ms aún bajo carga.
--
-- `jsonb_path_ops` (más eficiente que default `jsonb_ops`) — soporta queries
-- de tipo `@>` y `path: ['verifyHash'], equals: hash` que es exactamente el
-- patrón usado por Prisma en `findFirst({ where: { meta: { path: ['verifyHash'],
-- equals: hash } } })`.
--
-- IF NOT EXISTS: idempotente. Reaplicar la migración no falla si el índice
-- ya existe (útil en ambientes mixtos).

CREATE INDEX IF NOT EXISTS "CotizacionLibreDraft_meta_gin_idx"
  ON "CotizacionLibreDraft"
  USING gin ("meta" jsonb_path_ops);

COMMENT ON INDEX "CotizacionLibreDraft_meta_gin_idx"
  IS 'GIN partial index for meta JSONB — accelerates verifyHash lookup from /api/publico/verify/:hash';
