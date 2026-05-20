/**
 * backend/prisma/seeds/usuario-preferencias-pos.js
 *
 * Pre-popula la tabla UsuarioPreferenciasPOS con la fila default para cada
 * empleado que pueda acceder al POS (rol con permiso 'pos:ver', 'pos:facturar',
 * 'pos:cotizar' o 'sistema:owner'). Idempotente: usa upsert con `update: {}`
 * para no sobrescribir preferencias custom del cajero.
 *
 * Dos modos de invocación:
 *   1) Standalone (CLI manual):  node backend/prisma/seeds/usuario-preferencias-pos.js
 *      → Crea su propio PrismaClient y se desconecta al final.
 *   2) Embedded (boot del server):
 *      → server.js importa { runSeed } y lo invoca con el prisma ya inicializado
 *        después de prisma migrate deploy y antes de app.listen().
 */

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

async function runSeed({ prisma }) {
  if (!prisma) throw new Error('runSeed: prisma required');

  const roles = await prisma.rol.findMany({ where: { activo: true } });
  const rolesPos = roles.filter(rolTienePosAccess).map((r) => r.id);
  if (rolesPos.length === 0) {
    return { ok: true, empleados: 0, creados: 0, existian: 0, huerfanos: 0, motivo: 'sin-roles-pos' };
  }

  const empleados = await prisma.empleado.findMany({
    where: {
      deletedAt: null,
      roles:     { some: { id: { in: rolesPos } } },
    },
    select: { id: true },
  });

  let creados = 0, existian = 0;
  for (const e of empleados) {
    const before = await prisma.usuarioPreferenciasPOS.findUnique({ where: { empleadoId: e.id } });
    await prisma.usuarioPreferenciasPOS.upsert({
      where:  { empleadoId: e.id },
      create: { empleadoId: e.id, ...DEFAULTS },
      update: {}, // no pisar preferencias custom
    });
    if (before) existian += 1;
    else        creados  += 1;
  }

  // Detección de huérfanos: filas de UsuarioPreferenciasPOS cuyo empleado ya
  // no figura en `empleados` (perdió permiso POS, fue desactivado o el rol
  // pasó a inactivo). NO borramos automáticamente — solo reportamos. La
  // decisión de purga la toma el operador (puede haber preferencias custom
  // que el cajero recupere si lo re-activan).
  const idsActivos = new Set(empleados.map((e) => e.id));
  const todasPrefs = await prisma.usuarioPreferenciasPOS.findMany({ select: { empleadoId: true } });
  const huerfanos  = todasPrefs.filter((p) => !idsActivos.has(p.empleadoId)).length;

  return { ok: true, empleados: empleados.length, creados, existian, huerfanos };
}

module.exports = { runSeed, DEFAULTS, PERMISOS_POS };

// ─── Standalone CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  runSeed({ prisma })
    .then((r) => {
      console.log(`[seed:preferencias-pos] OK · empleados: ${r.empleados} · creados: ${r.creados} · ya existían: ${r.existian}${r.motivo ? ` · ${r.motivo}` : ''}`);
    })
    .catch((err) => {
      console.error('[seed:preferencias-pos] ERROR:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
