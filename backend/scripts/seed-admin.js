'use strict';
// Run once against a fresh DB:
//   DATABASE_URL="postgres://..." node backend/scripts/seed-admin.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const bcrypt           = require('bcryptjs');

const prisma = new PrismaClient();

const ADMIN_EMAIL    = 'crosario@acrnetworks.do';
const ADMIN_NAME     = 'Carmelo Junior Rosario';
const ADMIN_CARGO    = 'Administrador General';
const ADMIN_PASSWORD = 'Admin123!';
const ROL_NOMBRE     = 'Owner';
const ROL_PERMISOS   = ['sistema:owner'];

async function main() {
  console.log('[SEED] Starting admin seed...');

  // 1 — Upsert the Owner role
  const rol = await prisma.rol.upsert({
    where:  { nombre: ROL_NOMBRE },
    update: {},
    create: {
      nombre:      ROL_NOMBRE,
      descripcion: 'Acceso total al sistema',
      permisos:    ROL_PERMISOS,
      activo:      true,
      require2FA:  false,
    },
  });
  console.log(`[SEED] Rol "${rol.nombre}" id=${rol.id} — OK`);

  // 2 — Hash password
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  // 3 — Upsert the admin employee
  const empleado = await prisma.empleado.upsert({
    where:  { email: ADMIN_EMAIL },
    update: {
      passwordHash,
      bloqueado: false,
      roles:     { set: [{ id: rol.id }] },
    },
    create: {
      nombre:       ADMIN_NAME,
      cargo:        ADMIN_CARGO,
      email:        ADMIN_EMAIL,
      passwordHash,
      bloqueado:    false,
      permisosExtra: [],
      roles:        { connect: [{ id: rol.id }] },
    },
  });
  console.log(`[SEED] Empleado "${empleado.nombre}" id=${empleado.id} email=${empleado.email} — OK`);
  console.log('[SEED] Done. Change the password after first login.');
}

main()
  .catch(err => {
    console.error('[SEED] Error:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
