'use strict';
/**
 * hard-reset-db.js — ACR Networks ERP
 * Wipes sessions + roles, recreates master roles, reassigns by email.
 * Usage: node backend/scripts/hard-reset-db.js [--yes]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const readline         = require('readline');
const { PrismaClient } = require('@prisma/client');
const PERMISSIONS_MAP  = require('../../shared/permissions.map.js');

const prisma = new PrismaClient();

const ALL_PERMS   = PERMISSIONS_MAP.map(p => p.key);
const OWNER_PERMS = [...ALL_PERMS, 'sistema:owner'];
const BETA_PERMS  = [
  'dashboard:ver',
  'inventario:ver', 'inventario:editar', 'inventario:kardex',
  'catalogo:ver', 'catalogo:editar',
  'factura:ver', 'factura:emitir',
  'crm:ver', 'crm:crear',
  'ot:ver', 'ot:crear', 'ot:editar',
  'servicios:ver', 'servicios:crear',
  'mapa:ver', 'reportes:ver',
  'rrhh:asistencia',
];

const ROLES_DEF = [
  { nombre: 'Propietario Absoluto', descripcion: 'Control total. Único portador de sistema:owner.', permisos: OWNER_PERMS, require2FA: true,  email: 'crosario@acrnetworks.do'  },
  { nombre: 'Socio Administrador',  descripcion: 'Acceso completo sin modificar rol del Propietario.', permisos: ALL_PERMS,   require2FA: false, email: 'cadams@acrnetworks.do'    },
  { nombre: 'Beta Tester / QA',     descripcion: 'POS + catálogo. Sin permisos destructivos.',       permisos: BETA_PERMS,  require2FA: false, email: 'afernandez@acrnetworks.do' },
];

async function confirm(msg) {
  if (process.argv.includes('--yes')) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${msg} [s/N]: `, ans => {
      rl.close();
      if (ans.trim().toLowerCase() !== 's') { console.log('Abortado.'); process.exit(0); }
      resolve();
    });
  });
}

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  ACR — HARD RESET: Sessions + Roles');
  console.log('══════════════════════════════════════════════\n');
  await confirm('⚠  ACCIÓN DESTRUCTIVA en producción. ¿Continuar?');

  // 1. Wipe all sessions → forces everyone to re-login with fresh JWT
  console.log('[1/5] Wiping SessionToken table...');
  const { count: sessionCount } = await prisma.sessionToken.deleteMany({});
  console.log(`   ✓ ${sessionCount} sesiones eliminadas`);

  // 2. Disconnect all employees from all roles (implicit M2M join table)
  console.log('\n[2/5] Disconnecting all employee→role assignments...');
  const cleared = await prisma.$executeRaw`DELETE FROM "_EmpleadoToRol"`;
  console.log(`   ✓ ${cleared} filas borradas de "_EmpleadoToRol"`);

  // 3. Delete ALL roles unconditionally
  console.log('\n[3/5] Deleting all existing roles...');
  const { count: rolCount } = await prisma.rol.deleteMany({});
  console.log(`   ✓ ${rolCount} roles eliminados`);

  // 4. Create master roles from scratch
  console.log('\n[4/5] Creating master roles...');
  const rolIds = {};
  for (const def of ROLES_DEF) {
    const r = await prisma.rol.create({
      data: {
        nombre:      def.nombre,
        descripcion: def.descripcion,
        permisos:    def.permisos,
        require2FA:  def.require2FA,
        activo:      true,
      },
    });
    rolIds[def.nombre] = r.id;
    console.log(`   ✓ "${def.nombre}" id=${r.id} (${def.permisos.length}p)`);
  }

  // 5. Assign exactly one role per user by email
  console.log('\n[5/5] Assigning roles by email...');
  for (const def of ROLES_DEF) {
    const emp = await prisma.empleado.findUnique({ where: { email: def.email } });
    if (!emp) { console.warn(`   ⚠  No encontrado: ${def.email}`); continue; }
    await prisma.empleado.update({
      where: { id: emp.id },
      data:  { roles: { connect: [{ id: rolIds[def.nombre] }] } },
    });
    console.log(`   ✓ ${emp.nombre} (${def.email}) → "${def.nombre}"`);
  }

  // Safety check: nobody but crosario holds Propietario Absoluto
  const propietarios = await prisma.empleado.findMany({
    where:  { roles: { some: { id: rolIds['Propietario Absoluto'] } } },
    select: { email: true, nombre: true },
  });
  const badOwners = propietarios.filter(e => e.email !== 'crosario@acrnetworks.do');
  if (badOwners.length > 0) {
    console.error('\n🚨 ALERTA: Propietario Absoluto asignado a usuarios no autorizados:');
    badOwners.forEach(e => console.error(`   • ${e.nombre} (${e.email})`));
    process.exit(1);
  }

  // Final summary
  const activos = await prisma.rol.findMany({
    where:   { activo: true },
    include: { _count: { select: { empleados: true } } },
    orderBy: { id: 'asc' },
  });
  console.log('\n══════════════════════════════════════════════');
  for (const r of activos) {
    const p = Array.isArray(r.permisos) ? r.permisos : JSON.parse(r.permisos);
    const crown = p.includes('sistema:owner') ? ' 👑' : '';
    console.log(`  • ${r.nombre.padEnd(28)} ${String(p.length).padStart(2)}p  ${r._count.empleados}u${crown}`);
  }
  console.log('══════════════════════════════════════════════');
  console.log('  ✓ Hard reset completado. Todos los usuarios deben re-loguearse.\n');
}

main()
  .catch(e => { console.error('FATAL:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
