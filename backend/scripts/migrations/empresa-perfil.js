const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  `CREATE TABLE IF NOT EXISTS "EmpresaPerfil" (
     "id"                    INTEGER PRIMARY KEY DEFAULT 1,
     "rnc"                   TEXT NOT NULL,
     "razonSocial"           TEXT NOT NULL,
     "nombreComercial"       TEXT,
     "registroMercantil"     TEXT,
     "representanteNombre"   TEXT,
     "representanteApellido" TEXT,
     "representanteCedula"   TEXT,
     "representanteCargo"    TEXT,
     "direccion"             TEXT,
     "sector"                TEXT,
     "provincia"             TEXT,
     "pais"                  TEXT NOT NULL DEFAULT 'República Dominicana',
     "tipoEmpresa"           TEXT,
     "fechaInicio"           TIMESTAMPTZ,
     "telefono"              TEXT,
     "fax"                   TEXT,
     "email"                 TEXT,
     "website"               TEXT,
     "logoUrl"               TEXT,
     "eslogan"               TEXT,
     "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
     "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Guard: solo permitir ID=1 (Singleton)
  `DO $$ BEGIN
     ALTER TABLE "EmpresaPerfil" ADD CONSTRAINT "EmpresaPerfil_singleton_chk" CHECK ("id" = 1);
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // Inserción inicial con datos reales de ACR
  `INSERT INTO "EmpresaPerfil" (
     "id", "rnc", "razonSocial", "nombreComercial", "registroMercantil",
     "representanteNombre", "representanteApellido", "representanteCedula", "representanteCargo",
     "direccion", "sector", "provincia", "pais", "tipoEmpresa", "fechaInicio",
     "telefono", "email", "website", "eslogan"
   ) VALUES (
     1,
     '133-69267-8',
     'ACR Networks & Solutions, S.R.L.',
     'ACR Networks',
     '161830SD',
     'Carmelo Junior', 'Rosario Lopez',
     NULL, 'Gerente',
     'Calle Feliz Evaristo Mejía No. 406',
     'Cristo Rey',
     'Distrito Nacional',
     'República Dominicana',
     'SRL',
     '2018-01-01',
     '849-458-9955',
     'ranetworkssolutions@gmail.com',
     'https://acrnetworks.do',
     'Soluciones en Seguridad Electrónica, Redes y Soporte IT Corporativo'
   ) ON CONFLICT ("id") DO NOTHING`,
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
