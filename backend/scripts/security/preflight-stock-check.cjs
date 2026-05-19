#!/usr/bin/env node
/**
 * Pre-flight para la migration 20260518130000: cuenta cuántas filas tienen
 * stockActual < 0 antes de que la migration las normalice a 0. Si hay > 0,
 * imprime la lista para que el operador audite manualmente.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  try {
    const neg = await p.$queryRaw`
      SELECT id, sku, nombre, "stockActual" AS stock
        FROM "Producto"
       WHERE "stockActual" < 0
       ORDER BY "stockActual" ASC
       LIMIT 50
    `;
    console.log(`Producto · stockActual<0: ${neg.length} fila(s).`);
    neg.forEach(r => console.log(`  id=${r.id} sku=${r.sku} "${r.nombre}" stock=${r.stock}`));

    const negIC = await p.$queryRaw`
      SELECT id, nombre, stock
        FROM "ItemCatalogo"
       WHERE stock IS NOT NULL AND stock < 0
       LIMIT 50
    `;
    console.log(`\nItemCatalogo · stock<0: ${negIC.length} fila(s).`);
    negIC.forEach(r => console.log(`  id=${r.id} "${r.nombre}" stock=${r.stock}`));
  } finally { await p.$disconnect(); }
})().catch(e => { console.error(e.message); process.exit(1); });
