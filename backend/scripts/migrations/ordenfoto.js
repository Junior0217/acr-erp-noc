const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  `CREATE TABLE IF NOT EXISTS "OrdenFoto" (
     "id"          TEXT NOT NULL,
     "ordenId"     TEXT NOT NULL,
     "url"         TEXT NOT NULL,
     "latitud"     TEXT,
     "longitud"    TEXT,
     "takenAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
     "subidoPor"   INTEGER,
     "descripcion" TEXT,
     "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT "OrdenFoto_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "OrdenFoto_ordenId_idx"   ON "OrdenFoto"("ordenId")`,
  `CREATE INDEX IF NOT EXISTS "OrdenFoto_subidoPor_idx" ON "OrdenFoto"("subidoPor")`,
  `CREATE INDEX IF NOT EXISTS "OrdenFoto_takenAt_idx"   ON "OrdenFoto"("takenAt")`,
  `DO $$ BEGIN
     ALTER TABLE "OrdenFoto" ADD CONSTRAINT "OrdenFoto_ordenId_fkey"
       FOREIGN KEY ("ordenId") REFERENCES "OrdenTrabajo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "OrdenFoto" ADD CONSTRAINT "OrdenFoto_subidoPor_fkey"
       FOREIGN KEY ("subidoPor") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
]

;(async () => {
  let ok = 0, fail = 0
  for (let i = 0; i < STEPS.length; i++) {
    try {
      await p.$executeRawUnsafe(STEPS[i])
      console.log(`[OK]  step ${i + 1}/${STEPS.length}`)
      ok++
    } catch (e) {
      console.error(`[ERR] step ${i + 1}/${STEPS.length}: ${e.message}`)
      fail++
    }
  }
  console.log(`\nDone. OK=${ok}  FAIL=${fail}`)
  await p.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
})()
