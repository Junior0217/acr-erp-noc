const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  `CREATE TABLE IF NOT EXISTS "IncidenciaReconciliacion" (
     "id"          SERIAL PRIMARY KEY,
     "tipo"        TEXT NOT NULL,
     "severidad"   TEXT NOT NULL DEFAULT 'ALTA',
     "descripcion" TEXT NOT NULL,
     "datos"       JSONB NOT NULL DEFAULT '{}',
     "asignadoA"   INTEGER,
     "resueltoEn"  TIMESTAMPTZ,
     "resolucion"  TEXT,
     "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS "IncidenciaReconciliacion_tipo_idx"       ON "IncidenciaReconciliacion"("tipo")`,
  `CREATE INDEX IF NOT EXISTS "IncidenciaReconciliacion_severidad_idx"  ON "IncidenciaReconciliacion"("severidad")`,
  `CREATE INDEX IF NOT EXISTS "IncidenciaReconciliacion_resueltoEn_idx" ON "IncidenciaReconciliacion"("resueltoEn")`,
  `CREATE INDEX IF NOT EXISTS "IncidenciaReconciliacion_createdAt_idx"  ON "IncidenciaReconciliacion"("createdAt")`,
  `DO $$ BEGIN
     ALTER TABLE "IncidenciaReconciliacion" ADD CONSTRAINT "IncidenciaReconciliacion_asignadoA_fkey"
       FOREIGN KEY ("asignadoA") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
]

;(async () => {
  let ok = 0, fail = 0
  for (let i = 0; i < STEPS.length; i++) {
    try {
      await p.$executeRawUnsafe(STEPS[i]); console.log(`[OK]  step ${i + 1}/${STEPS.length}`); ok++
    } catch (e) { console.error(`[ERR] step ${i + 1}/${STEPS.length}: ${e.message}`); fail++ }
  }
  console.log(`\nDone. OK=${ok}  FAIL=${fail}`)
  await p.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
})()
