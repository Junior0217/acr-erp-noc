'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TARGET_EMAIL = process.env.RESET_EMAIL || 'crosario@acrnetworks.do';

async function main() {
  const before = await prisma.empleado.findUnique({
    where:  { email: TARGET_EMAIL },
    select: { id: true, nombre: true, twoFactorEnabled: true, twoFactorSecret: true },
  });

  if (!before) {
    console.error(`[RESET-2FA] No employee found with email: ${TARGET_EMAIL}`);
    process.exit(1);
  }

  console.log(`[RESET-2FA] Found: id=${before.id} | nombre="${before.nombre}" | twoFactorEnabled=${before.twoFactorEnabled} | hasSecret=${!!before.twoFactorSecret}`);

  const updated = await prisma.empleado.update({
    where: { email: TARGET_EMAIL },
    data:  { twoFactorEnabled: false, twoFactorSecret: null },
    select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
  });

  console.log(`[RESET-2FA] Done. id=${updated.id} | twoFactorEnabled=${updated.twoFactorEnabled} | twoFactorSecret=${updated.twoFactorSecret ?? 'null'}`);
  console.log('[RESET-2FA] User can now log in without 2FA and re-enroll if needed.');
}

main()
  .catch(err => { console.error('[RESET-2FA] Error:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
