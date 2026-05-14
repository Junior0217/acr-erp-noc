const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const STEPS = [
  // 1. Añade assets JSON (default {})
  `ALTER TABLE "EmpresaPerfil" ADD COLUMN IF NOT EXISTS "assets" JSONB NOT NULL DEFAULT '{}'::jsonb`,
  // 2. Migra el viejo logoUrl al nuevo assets.logoClaro (preserva data antes de drop)
  `UPDATE "EmpresaPerfil"
     SET "assets" = COALESCE("assets",'{}'::jsonb) || jsonb_build_object('logoClaro', "logoUrl")
     WHERE "logoUrl" IS NOT NULL AND "logoUrl" != ''`,
  // 3. Drop logoUrl
  `ALTER TABLE "EmpresaPerfil" DROP COLUMN IF EXISTS "logoUrl"`,
  // 4. Update con datos EXACTOS de ACR (cédula 40234276141 validada Mod-10)
  `UPDATE "EmpresaPerfil" SET
     "rnc"                   = '133692678',
     "razonSocial"           = 'ACR NETWORKS & SOLUTIONS, S.R.L.',
     "nombreComercial"       = 'ACR Networks',
     "registroMercantil"     = '220982SD',
     "representanteNombre"   = 'CARMELO JUNIOR',
     "representanteApellido" = 'ROSARIO LOPEZ',
     "representanteCedula"   = '40234276141',
     "representanteCargo"    = 'Gerente',
     "direccion"             = 'Calle Feliz Evaristo Mejía, No. 406',
     "sector"                = 'Cristo Rey',
     "provincia"             = 'Santo Domingo, Distrito Nacional',
     "pais"                  = 'República Dominicana',
     "telefono"              = '849-458-9955 / 809-670-9956',
     "email"                 = 'ranetworkssolutions@gmail.com',
     "eslogan"               = 'Soluciones en Seguridad Electrónica, Redes y Soporte IT Corporativo',
     "assets"                = COALESCE("assets",'{}'::jsonb) || jsonb_build_object(
                                 'logoClaro',    COALESCE("assets"->>'logoClaro', '/logo-acr.png'),
                                 'logoOscuro',   COALESCE("assets"->>'logoOscuro', '/logo-acr.png'),
                                 'selloFisico',  COALESCE("assets"->>'selloFisico', ''),
                                 'firmaGerente', COALESCE("assets"->>'firmaGerente', '')
                               ),
     "updatedAt"             = now()
   WHERE "id" = 1`,
]

;(async () => {
  let ok = 0, fail = 0
  for (let i = 0; i < STEPS.length; i++) {
    try { await p.$executeRawUnsafe(STEPS[i]); console.log(`[OK]  step ${i + 1}/${STEPS.length}`); ok++ }
    catch (e) { console.error(`[ERR] step ${i + 1}/${STEPS.length}: ${e.message}`); fail++ }
  }

  // Propagar permisos a roles
  try {
    const roles = await p.rol.findMany({ where: { activo: true } })
    for (const r of roles) {
      const perms = Array.isArray(r.permisos) ? r.permisos : []
      const isOwner = (r.nivel ?? 0) >= 100 || perms.includes('sistema:owner')
      const isAdmin = perms.includes('sistema:admin')
      const next = [...perms]
      if (isOwner) {
        if (!next.includes('empresa:ver'))    next.push('empresa:ver')
        if (!next.includes('empresa:editar')) next.push('empresa:editar')
      } else if (isAdmin) {
        if (!next.includes('empresa:ver'))    next.push('empresa:ver')
      }
      if (next.length !== perms.length) {
        await p.rol.update({ where: { id: r.id }, data: { permisos: next } })
        console.log(`  ✓ ${r.nombre} (nivel ${r.nivel}): += ${[...new Set(next)].filter(x => !perms.includes(x)).join(', ')}`)
      }
    }
  } catch (e) { console.error('[ROLES UPDATE]', e.message) }

  console.log(`\nDone. OK=${ok}  FAIL=${fail}`)
  await p.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
})()
