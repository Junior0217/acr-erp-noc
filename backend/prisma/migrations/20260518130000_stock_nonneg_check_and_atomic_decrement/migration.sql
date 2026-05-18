-- Mejora #1 — Candado Pesimista de Inventario a nivel base de datos.
--
-- Garantiza que `Producto.stockActual` nunca quede negativo, sin importar
-- cuántos cajeros / procesos concurrentes intenten decrementar al mismo
-- tiempo. PostgreSQL aborta la transacción con CHECK violation antes de
-- aceptar el UPDATE. Defense-in-depth además del UPDATE-RETURNING atómico
-- del POS.
--
-- Cyber Neo:
--   - Si el código sube vulnerable (DAO mal hecho, query manual con string
--     concat, decremento sin WHERE), la BD igual rechaza. Cero ventana.
--   - Limpia primero cualquier valor negativo legacy (sano: cero filas
--     deberían tener stockActual<0 en este proyecto, pero blindamos).
--   - Constraint NOT VALID + VALIDATE en pasos separados para evitar
--     bloquear toda la tabla durante un LONG validate en producción.

-- Paso 1: Sanitiza filas legacy (si las hay) — set a 0 cualquier negativo.
-- Esto NO debería disparar en este proyecto; es safety net.
UPDATE "Producto" SET "stockActual" = 0 WHERE "stockActual" < 0;

-- Paso 2: Crea constraint sin validar filas existentes (rápido — solo DDL).
ALTER TABLE "Producto"
  ADD CONSTRAINT "Producto_stockActual_nonneg_chk"
  CHECK ("stockActual" >= 0) NOT VALID;

-- Paso 3: Valida ahora — escanea la tabla. Como Paso 1 ya garantizó que
-- todas las filas cumplen, esto pasa rápido y deja el constraint VALID.
ALTER TABLE "Producto"
  VALIDATE CONSTRAINT "Producto_stockActual_nonneg_chk";

-- (Opcional, paralelo) Mismo blindaje para ItemCatalogo.stock (legacy
-- manual). Si el valor es NULL queda permitido — solo bloqueamos negativos.
UPDATE "ItemCatalogo" SET "stock" = 0 WHERE "stock" IS NOT NULL AND "stock" < 0;

ALTER TABLE "ItemCatalogo"
  ADD CONSTRAINT "ItemCatalogo_stock_nonneg_chk"
  CHECK ("stock" IS NULL OR "stock" >= 0) NOT VALID;

ALTER TABLE "ItemCatalogo"
  VALIDATE CONSTRAINT "ItemCatalogo_stock_nonneg_chk";
