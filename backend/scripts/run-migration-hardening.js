/**
 * Security hardening migration: IpBlock table for anti brute-force.
 * Runs via pooler (port 6543) — bypasses direct connection block.
 */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  `CREATE TABLE IF NOT EXISTS "IpBlock" (
     "id"          SERIAL PRIMARY KEY,
     "ip"          TEXT NOT NULL,
     "motivo"      TEXT NOT NULL DEFAULT 'Brute force tracking',
     "intentos"    INTEGER NOT NULL DEFAULT 0,
     "bloqueadoEn" TIMESTAMPTZ NOT NULL DEFAULT now(),
     "expiraEn"    TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS "IpBlock_ip_idx"       ON "IpBlock"("ip")`,
  `CREATE INDEX IF NOT EXISTS "IpBlock_expiraEn_idx" ON "IpBlock"("expiraEn")`,
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
