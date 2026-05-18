-- Mejora #2 — Historial de Inventario Inmutable (Hash-Chain).
--
-- Cada entrada/salida en MovimientoInventario se firma con HMAC-SHA256
-- anclada al hash de la fila ANTERIOR del MISMO producto (ordenada por id
-- asc). Si alguien adultera, borra o reordena filas, la cadena se rompe
-- y `verifyChain(productoId)` lo detecta.
--
-- Diseño:
--   - prevHash = hash de la fila previa para el mismo productoId. NULL en
--     la primera fila del producto.
--   - hash = HMAC-SHA256(AUDIT_SECRET, canonical({prev, snapshot})).
--   - snapshot incluye: tipo, cantidad, ordenInstalacionId, fecha ISO.
--   - El stock derivable se vuelve `sum(entradas) - sum(salidas)` y se
--     reconcilia contra Producto.stockActual via job nocturno.
--
-- Cyber Neo:
--   - Columnas nullable inicialmente — filas legacy preexistentes quedan
--     SIN hash y se ignoran al verificar (con flag `legacy=true`).
--   - Cada inserción nueva DEBE traer hash (enforced en el service, no en
--     la BD: la BD permite NULL para tolerar legacy).
--   - Índice por hash para verifyChain rápido.

ALTER TABLE "MovimientoInventario"
  ADD COLUMN "prevHash" TEXT,
  ADD COLUMN "hash"     TEXT;

CREATE INDEX "MovimientoInventario_hash_idx"     ON "MovimientoInventario"("hash");
CREATE INDEX "MovimientoInventario_prevHash_idx" ON "MovimientoInventario"("prevHash");
CREATE INDEX "MovimientoInventario_productoId_id_idx"
  ON "MovimientoInventario"("productoId", "id");
