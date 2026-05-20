/**
 * backend/prisma/seeds/usuario-preferencias-pos.js
 *
 * Pre-popula la tabla UsuarioPreferenciasPOS con la fila default para cada
 * empleado que pueda acceder al POS (rol con permiso 'pos:ver', 'pos:facturar',
 * 'pos:cotizar' o nivel sistema:owner). Idempotente: usa upsert.
 *
 * Ejecutar con:
 *   node backend/prisma/seeds/usuario-preferencias-pos.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PERMISOS_POS = ['pos:ver', 'pos:facturar', 'pos:cotizar', 'sistema:owner'];

const DEFAULTS = {
  mostrarValidez:   true,
  mostrarFormaPago: true,
  mostrarEntrega:   true,
  mostrarGarantia:  true,
  mostrarNotas:     false,
};

function rolTienePosAccess(rol) {
  const permisos = Array.isArray(rol.permisos) ? rol.permisos : [];
  return permisos.some((p) => PERMISOS_POS.includes(p));
}

async function main() {
  // 1. Roles que dan acceso al POS (permisos:* incluye alguno de pos:*).
  const roles = await prisma.rol.findMany({ where: { activo: true } });
  const rolesPos = roles.filter(rolTienePosAccess).map((r) => r.id);

  if (rolesPos.length === 0) {
    console.log('[seed:preferencias-pos] No hay roles con permisos POS. Nada que hacer.');
    return;
  }

  // 2. Empleados que tienen al menos uno de esos roles y no están eliminados.
  const empleados = await prisma.empleado.findMany({
    where: {
      deletedAt: null,
      roles:     { some: { id: { in: rolesPos } } },
    },
    select: { id: true, nombre: true, email: true },
  });

  let created = 0, existed = 0;
  for (const e of empleados) {
    const before = await prisma.usuarioPreferenciasPOS.findUnique({ where: { empleadoId: e.id } });
    await prisma.usuarioPreferenciasPOS.upsert({
      where:  { empleadoId: e.id },
      create: { empleadoId: e.id, ...DEFAULTS },
      update: {}, // si ya existe, NO sobrescribir preferencias custom del cajero
    });
    if (before) existed += 1;
    else        created += 1;
  }

  console.log(`[seed:preferencias-pos] OK · empleados con POS: ${empleados.length} · creados: ${created} · ya existían: ${existed}`);
}

main()
  .catch((err) => {
    console.error('[seed:preferencias-pos] ERROR:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
