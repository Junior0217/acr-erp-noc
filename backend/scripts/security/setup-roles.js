'use strict';
/**
 * setup-roles.js — ACR Networks ERP
 * Establece la jerarquía definitiva de 3 roles maestros e invalida roles redundantes.
 *
 * Uso:
 *   node backend/scripts/setup-roles.js [--yes]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const readline     = require('readline');
const { PrismaClient } = require('@prisma/client');
const PERMISSIONS_MAP  = require('../../shared/permissions.map.js');

const prisma = new PrismaClient();

// ─── All system permissions ────────────────────────────────────────────────────
const ALL_PERMS   = PERMISSIONS_MAP.map(p => p.key);
const OWNER_PERMS = [...ALL_PERMS, 'sistema:owner'];

// ─── Beta Tester — subset: can use POS/Catálogo but no destructive ops ─────────
const BETA_PERMS = [
  'dashboard:ver',
  'inventario:ver',
  'inventario:editar',
  'inventario:kardex',
  'catalogo:ver',
  'catalogo:editar',
  'factura:ver',
  'factura:emitir',
  'crm:ver',
  'crm:crear',
  'ot:ver',
  'ot:crear',
  'ot:editar',
  'servicios:ver',
  'servicios:crear',
  'mapa:ver',
  'reportes:ver',
  'rrhh:asistencia',
];

// ─── Role definitions ──────────────────────────────────────────────────────────
const ROLES = [
  {
    nombre:      'Propietario Absoluto',
    descripcion: 'Control total del sistema. Intocable — único portador de sistema:owner.',
    permisos:    OWNER_PERMS,
    require2FA:  true,
    email:       'crosario@acrnetworks.do',
  },
  {
    nombre:      'Socio Administrador',
    descripcion: 'Acceso completo a operaciones. No puede modificar roles del Propietario ni configuraciones core.',
    permisos:    ALL_PERMS,
    require2FA:  false,
    emailSearch: 'cristian',
  },
  {
    nombre:      'Beta Tester / QA',
    descripcion: 'Acceso de prueba al POS y catálogo. Sin permisos destructivos ni de configuración.',
    permisos:    BETA_PERMS,
    require2FA:  false,
    emailSearch: 'andrews',
  },
];

// ─── Legacy role names to delete ──────────────────────────────────────────────
const LEGACY_ROLES = ['Owner', 'Propietario', 'Administrador General', 'Admin'];

async function confirm(msg) {
  if (process.argv.includes('--yes')) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question(`${msg} [s/N]: `, ans => {
      rl.close();
      if (ans.trim().toLowerCase() !== 's') { console.log('  Abortado.'); process.exit(0); }
      resolve();
    });
  });
}

async function findEmpleado(email, searchTerm) {
  if (email) {
    const e = await prisma.empleado.findUnique({ where: { email } });
    if (e) return e;
    console.warn(`  ⚠  No se encontró empleado con email "${email}"`);
    return null;
  }
  if (searchTerm) {
    const results = await prisma.empleado.findMany({
      where: { OR: [
        { email:  { contains: searchTerm, mode: 'insensitive' } },
        { nombre: { contains: searchTerm, mode: 'insensitive' } },
      ]},
    });
    if (results.length === 1) return results[0];
    if (results.length > 1) {
      console.warn(`  ⚠  Múltiples empleados con "${searchTerm}" — se usará el primero: ${results[0].nombre}`);
      return results[0];
    }
    console.warn(`  ⚠  No se encontró empleado con término "${searchTerm}"`);
    return null;
  }
  return null;
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  ACR Networks ERP — Setup de Roles Maestros');
  console.log('══════════════════════════════════════════════════════');

  const permsCount = {
    'Propietario Absoluto': OWNER_PERMS.length,
    'Socio Administrador':  ALL_PERMS.length,
    'Beta Tester / QA':     BETA_PERMS.length,
  };

  console.log('\n  Roles a crear/actualizar:');
  for (const [nombre, count] of Object.entries(permsCount)) {
    console.log(`    • ${nombre.padEnd(25)} ${count} permisos`);
  }
  console.log('\n  Roles legacy a eliminar (si existen):');
  console.log('   ', LEGACY_ROLES.join(', '));
  console.log('');

  await confirm('⚠  ¿Confirmas la reconfiguración de roles?');

  // ── 1. Upsert the 3 master roles ──────────────────────────────────────────
  console.log('\n[1/3] Creando/actualizando roles maestros...');
  const rolIds = {};

  for (const def of ROLES) {
    const rol = await prisma.rol.upsert({
      where:  { nombre: def.nombre },
      update: { permisos: def.permisos, descripcion: def.descripcion, require2FA: def.require2FA, activo: true },
      create: { nombre: def.nombre, descripcion: def.descripcion, permisos: def.permisos, require2FA: def.require2FA, activo: true },
    });
    rolIds[def.nombre] = rol.id;
    console.log(`   ✓ "${def.nombre}" id=${rol.id} — ${def.permisos.length} permisos`);
  }

  // ── 2. Assign employees ───────────────────────────────────────────────────
  console.log('\n[2/3] Asignando empleados a roles...');

  for (const def of ROLES) {
    const emp = await findEmpleado(def.email, def.emailSearch);
    if (!emp) continue;

    // Disconnect all existing roles, then connect the new master role
    await prisma.empleado.update({
      where: { id: emp.id },
      data:  { roles: { set: [{ id: rolIds[def.nombre] }] } },
    });
    console.log(`   ✓ ${emp.nombre} (${emp.email}) → "${def.nombre}"`);
  }

  // ── 3. Delete legacy roles (only if no employees remain assigned) ─────────
  console.log('\n[3/3] Eliminando roles legacy...');

  for (const legacyName of LEGACY_ROLES) {
    const legacy = await prisma.rol.findUnique({
      where: { nombre: legacyName },
      include: { _count: { select: { empleados: true } } },
    });
    if (!legacy) { console.log(`   —  "${legacyName}" no existe, saltando.`); continue; }
    if (legacy._count.empleados > 0) {
      console.warn(`   ⚠  "${legacyName}" tiene ${legacy._count.empleados} empleado(s) — NO eliminado.`);
      continue;
    }
    await prisma.rol.delete({ where: { id: legacy.id } });
    console.log(`   ✓ "${legacyName}" eliminado.`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Roles maestros activos:');
  const activos = await prisma.rol.findMany({ where: { activo: true }, include: { _count: { select: { empleados: true } } } });
  for (const r of activos) {
    const perms = Array.isArray(r.permisos) ? r.permisos : JSON.parse(r.permisos);
    const hasOwner = perms.includes('sistema:owner') ? ' 👑' : '';
    console.log(`    • ${r.nombre.padEnd(30)} ${String(perms.length).padStart(2)} permisos  ${r._count.empleados} empleado(s)${hasOwner}`);
  }
  console.log('══════════════════════════════════════════════════════\n');
  console.log('  ✓ Setup completado.\n');
}

main()
  .catch(err => { console.error('[SETUP-ROLES] Error:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
