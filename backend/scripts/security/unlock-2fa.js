'use strict';
/**
 * emergency-unlock-2fa.js — ACR Networks ERP
 * Sets require2FA=false on ALL roles so blocked owners can log in immediately.
 * Re-run hard-reset-db.js afterwards to restore the correct require2FA per role.
 * Usage: node backend/scripts/emergency-unlock-2fa.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const { count } = await prisma.rol.updateMany({ data: { require2FA: false } });
  console.log(`✓ ${count} roles updated → require2FA=false. All users can now log in.`);
  console.log('  Run hard-reset-db.js to restore proper role permissions afterwards.');
}

main()
  .catch(e => { console.error('FATAL:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
