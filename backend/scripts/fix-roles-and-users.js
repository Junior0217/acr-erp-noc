'use strict';
/**
 * fix-roles-and-users.js — ACR Networks ERP
 * Upserts 3 master roles and assigns known production users by email.
 * Safe to run multiple times (idempotent).
 *
 * Uso: node backend/scripts/fix-roles-and-users.js [--yes]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline          = require('readline');
const { PrismaClient }  = require('@prisma/client');
const PERMISSIONS_MAP   = require('../shared/permissions.map.js');

const prisma = new PrismaClient();

const ALL_PERMS   = PERMISSIONS_MAP.map(p => p.key);
const OWNER_PERMS = [...ALL_PERMS, 'sistema:owner'];

const BETA_PERMS = [
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
  { nombre: 'Propietario Absoluto', descripcion: 'Control total. Intocable — único portador de sistema:owner.', permisos: OWNER_PERMS, require2FA: true,  email: 'crosario@acrnetworks.do'  },
  { nombre: 'Socio Administrador',  descripcion: 'Acceso completo. No puede modificar roles del Propietario.',  permisos: ALL_PERMS,   require2FA: false, email: 'cadams@acrnetworks.do'    },
  { nombre: 'Beta Tester / QA',     descripcion: 'POS + catálogo. Sin permisos destructivos ni de config.',     permisos: BETA_PERMS,  require2FA: false, email: 'afernandez@acrnetworks.do' },
];

const LEGACY = ['Owner', 'Propietario', 'Administrador General', 'Admin'];

async function confirm(msg) {
  if (process.argv.includes('--yes')) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${msg} [s/N]: `, ans => { rl.close(); if (ans.trim().toLowerCase() !== 's') { console.log('Abortado.'); process.exit(0); } resolve(); });
  });
}

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  ACR — Fix Roles & Users (production)');
  console.log('══════════════════════════════════════════\n');
  await confirm('⚠  ¿Aplicar en producción?');

  const rolIds = {};

  // 1. Upsert master roles
  console.log('[1/3] Upsert master roles...');
  for (const def of ROLES_DEF) {
    const r = await prisma.rol.upsert({
      where:  { nombre: def.nombre },
      update: { permisos: def.permisos, descripcion: def.descripcion, require2FA: def.require2FA, activo: true },
      create: { nombre: def.nombre, descripcion: def.descripcion, permisos: def.permisos, require2FA: def.require2FA, activo: true },
    });
    rolIds[def.nombre] = r.id;
    console.log(`   ✓ "${def.nombre}" id=${r.id}`);
  }

  // 2. Assign users by email
  console.log('\n[2/3] Assigning users...');
  for (const def of ROLES_DEF) {
    const emp = await prisma.empleado.findUnique({
      where:   { email: def.email },
      include: { roles: { select: { nombre: true } } },
    });
    if (!emp) { console.warn(`   ⚠  No encontrado: ${def.email}`); continue; }
    const antes = emp.roles.map(r => r.nombre).join(', ') || '(ninguno)';
    await prisma.empleado.update({
      where: { id: emp.id },
      data:  { roles: { set: [{ id: rolIds[def.nombre] }] } },
    });
    console.log(`   ✓ ${emp.nombre} (${def.email})`);
    console.log(`       antes: [${antes}]  →  después: ["${def.nombre}"]`);
  }

  // Explicit safety check: nobody besides crosario must hold Propietario
  const propietarioId = rolIds['Propietario Absoluto'];
  const propietarios = await prisma.empleado.findMany({
    where: { roles: { some: { id: propietarioId } } },
    select: { email: true, nombre: true },
  });
  const badOwners = propietarios.filter(e => e.email !== 'crosario@acrnetworks.do');
  if (badOwners.length > 0) {
    console.error('\n🚨 ALERTA: Propietario asignado a usuarios no autorizados:');
    badOwners.forEach(e => console.error(`   • ${e.nombre} (${e.email})`));
    process.exit(1);
  }
  console.log(`\n   ✓ Safety check OK — solo crosario tiene Propietario Absoluto`);

  // 3. Delete legacy roles (only if empty)
  console.log('\n[3/3] Removing legacy roles...');
  for (const name of LEGACY) {
    const r = await prisma.rol.findUnique({ where: { nombre: name }, include: { _count: { select: { empleados: true } } } });
    if (!r) { console.log(`   —  "${name}" not found`); continue; }
    if (r._count.empleados > 0) { console.warn(`   ⚠  "${name}" still has ${r._count.empleados} user(s) — skipped`); continue; }
    await prisma.rol.delete({ where: { id: r.id } });
    console.log(`   ✓ "${name}" deleted`);
  }

  // Summary
  const activos = await prisma.rol.findMany({ where: { activo: true }, include: { _count: { select: { empleados: true } } } });
  console.log('\n══════════════════════════════════════════');
  for (const r of activos) {
    const p = Array.isArray(r.permisos) ? r.permisos : JSON.parse(r.permisos);
    console.log(`  • ${r.nombre.padEnd(28)} ${String(p.length).padStart(2)}p  ${r._count.empleados}u${p.includes('sistema:owner') ? ' 👑' : ''}`);
  }
  console.log('══════════════════════════════════════════\n  ✓ Done.\n');
}

main()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
