const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  // stockMinimo en Producto
  `ALTER TABLE "Producto" ADD COLUMN IF NOT EXISTS "stockMinimo" INTEGER NOT NULL DEFAULT 5`,

  // ActivoTimeline
  `CREATE TABLE IF NOT EXISTS "ActivoTimeline" (
     "id"             SERIAL PRIMARY KEY,
     "activoId"       TEXT NOT NULL,
     "evento"         TEXT NOT NULL,
     "tecnicoId"      INTEGER,
     "ordenTrabajoId" TEXT,
     "fecha"          TIMESTAMPTZ NOT NULL DEFAULT now(),
     "notas"          TEXT,
     "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS "ActivoTimeline_activoId_idx"  ON "ActivoTimeline"("activoId")`,
  `CREATE INDEX IF NOT EXISTS "ActivoTimeline_tecnicoId_idx" ON "ActivoTimeline"("tecnicoId")`,
  `CREATE INDEX IF NOT EXISTS "ActivoTimeline_fecha_idx"     ON "ActivoTimeline"("fecha")`,
  `DO $$ BEGIN
     ALTER TABLE "ActivoTimeline" ADD CONSTRAINT "ActivoTimeline_activoId_fkey"
       FOREIGN KEY ("activoId") REFERENCES "ActivoCliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "ActivoTimeline" ADD CONSTRAINT "ActivoTimeline_tecnicoId_fkey"
       FOREIGN KEY ("tecnicoId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "ActivoTimeline" ADD CONSTRAINT "ActivoTimeline_ordenTrabajoId_fkey"
       FOREIGN KEY ("ordenTrabajoId") REFERENCES "OrdenTrabajo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
]

;(async () => {
  let ok = 0, fail = 0
  for (let i = 0; i < STEPS.length; i++) {
    try { await p.$executeRawUnsafe(STEPS[i]); console.log(`[OK]  step ${i + 1}/${STEPS.length}`); ok++ }
    catch (e) { console.error(`[ERR] step ${i + 1}/${STEPS.length}: ${e.message}`); fail++ }
  }
  console.log(`\nDone. OK=${ok}  FAIL=${fail}`)
  await p.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
})()
