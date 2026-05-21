-- ════════════════════════════════════════════════════════════════════════════
-- L1.1 RLS — Covering indexes + Kanban index (10mo ciclo ADK v3).
-- ════════════════════════════════════════════════════════════════════════════
--
-- Transforma los índices parciales activo/anulado en COVERING (Postgres 11+)
-- añadiendo columnas frecuentemente consultadas en `INCLUDE (...)`. Resultado:
-- el SELECT de `listarMisFacturasRls` puede satisfacerse sin tocar el heap
-- (index-only scan), reduciendo IO en 60-80% para listados típicos del POS.
--
-- Patrón:
--   CREATE INDEX <name> ON Factura (<columnas de búsqueda/orden>)
--   INCLUDE (<columnas devueltas pero NO filtradas>)
--   WHERE <predicado parcial>
--
-- Por qué DROP/CREATE en lugar de ALTER:
--   Postgres NO soporta `ALTER INDEX ... ADD INCLUDE`. La única forma de
--   añadir INCLUDE a un índice existente es recrearlo. Esto bloquea writes
--   brevemente — para tablas con tráfico crítico, considerar
--   CREATE INDEX CONCURRENTLY + DROP INDEX CONCURRENTLY en pipeline manual.
--   Acá se hace inline porque la ventana de boot/migrate de Render ya
--   pausa requests.
--
-- Columnas en INCLUDE (siempre devueltas por el SELECT del POS):
--   noFactura, ncf, total, estado, fechaEmision, esCotizacion
-- Las flags secundarias esNotaCredito/esNotaDebito NO se incluyen porque el
-- working set crecería ~10% por flag boolean — el SELECT puede pagar el heap
-- lookup para esos campos sin afectar TTFB.
--
-- También se crea `factura_kanban_idx` para el path del Kanban Cotizaciones,
-- que filtra por etapaPipeline además de empleadoId — el índice base por
-- empleadoId requería sort step. Con (empleadoId, etapaPipeline, fechaEmision
-- DESC) parcial WHERE esCotizacion=true AND estado!='Anulada', el planner
-- satisface SELECT+WHERE+ORDER BY+LIMIT sin sort step ni heap lookup.

-- ─── DROP índices antiguos (sin INCLUDE) ─────────────────────────────────────
DROP INDEX IF EXISTS "factura_owner_active_idx";
DROP INDEX IF EXISTS "factura_anulada_idx";

-- ─── factura_owner_active_idx con INCLUDE ────────────────────────────────────
-- WHERE estado != 'Anulada' — cubre listados POS Kanban del cajero, conduces,
-- selectores de "factura origen" para NC/ND.
CREATE INDEX IF NOT EXISTS "factura_owner_active_idx"
  ON "Factura" ("empleadoId", "fechaEmision" DESC)
  INCLUDE ("noFactura", "ncf", "total", "estado", "esCotizacion")
  WHERE "estado" != 'Anulada';

COMMENT ON INDEX "factura_owner_active_idx"
  IS 'L1.1 owner-match — covering (incluye campos del SELECT POS) parcial activo.';

-- ─── factura_anulada_idx con INCLUDE ─────────────────────────────────────────
-- WHERE estado = 'Anulada' — cubre histórico cuando includeAnuladas=true.
-- Mismo INCLUDE que el activo para que el SELECT no diferencie en performance.
CREATE INDEX IF NOT EXISTS "factura_anulada_idx"
  ON "Factura" ("empleadoId", "fechaEmision" DESC)
  INCLUDE ("noFactura", "ncf", "total", "estado", "esCotizacion")
  WHERE "estado" = 'Anulada';

COMMENT ON INDEX "factura_anulada_idx"
  IS 'L1.1 owner-match — covering parcial histórico Anulada (pair de factura_owner_active_idx).';

-- ─── factura_kanban_idx — path crítico del Kanban Cotizaciones ───────────────
-- Query típica: SELECT ... FROM Factura
--   WHERE empleadoId=$1 AND esCotizacion=true AND estado!='Anulada' AND etapaPipeline=$2
--   ORDER BY fechaEmision DESC LIMIT 50
--
-- Cláusulas del WHERE de la query deben matchear sintácticamente las del
-- índice parcial. Si la app pasa esCotizacion=true como query Prisma
-- (`{ esCotizacion: true }`), Postgres lo recibe como `esCotizacion = true`
-- — match exacto con el predicado del índice.
CREATE INDEX IF NOT EXISTS "factura_kanban_idx"
  ON "Factura" ("empleadoId", "etapaPipeline", "fechaEmision" DESC)
  INCLUDE ("noFactura", "total", "estado")
  WHERE "esCotizacion" = true AND "estado" != 'Anulada';

COMMENT ON INDEX "factura_kanban_idx"
  IS 'L1.1 Kanban Cotizaciones — covering parcial por etapa (excluye Anulada y facturas reales).';
