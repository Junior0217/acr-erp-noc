'use strict';
/**
 * backend/scripts/ops/duplicados-catalogo.js
 *
 * Detecta productos duplicados en el catálogo: el mismo equipo cargado dos
 * veces con SKU distinto (pasa al cotizar contra una lista nueva del suplidor).
 * El riesgo real es elegir el SKU equivocado al cotizar y arrastrar un precio
 * viejo.
 *
 * Uso:
 *   node scripts/ops/duplicados-catalogo.js            → solo reporta
 *   node scripts/ops/duplicados-catalogo.js --purgar   → borra los duplicados
 *                                                        SIN referencias
 *
 * Un producto es PURGABLE solo si no aparece en ninguna línea de factura o
 * cotización, movimiento de inventario, orden, activo de cliente, préstamo,
 * serie, bundle, reserva ni plantilla. Lo referenciado NUNCA se toca: borrar
 * un producto usado por una factura fiscal rompería el histórico que la DGII
 * exige conservar 10 años.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PURGAR = process.argv.includes('--purgar');

// Normaliza el nombre para comparar. Quita acentos, lo que va tras el guión
// largo (marca/modelo), paréntesis y los adjetivos de color/acabado, que son
// justo lo que varía entre dos cargas del mismo equipo:
//   "Sirena inalámbrica para exterior (blanca) — StreetSiren"
//   "Sirena inalámbrica para exterior — StreetSiren"
// Deliberadamente NO agrupa por precio ni categoría: dos equipos distintos
// pueden compartir ambos, y un falso positivo aquí es un borrado indebido.
const RUIDO = /\b(blanco|blanca|negro|negra|rojo|roja|gris|azul|inalambrico|inalambrica|para|de|del|la|el|los|las|con|y)\b/g;
function clave(nombre) {
  return String(nombre ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split('—')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(RUIDO, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function contarReferencias(id) {
  const [lineas, movs, ordenes, detalles, activos, prestamos, series, bundleP, bundleH, reservas, plantillas, carrito, catalogo] =
    await Promise.all([
      prisma.lineaFactura.count({ where: { productoId: id } }),
      prisma.movimientoInventario.count({ where: { productoId: id } }),
      prisma.lineaOrden?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.detalleOrden?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.activoCliente?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.prestamo?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.serieProducto?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.bundleComponente?.count({ where: { productoPadreId: id } }).catch(() => 0) ?? 0,
      prisma.bundleComponente?.count({ where: { productoHijoId: id } }).catch(() => 0) ?? 0,
      prisma.reservaInventario?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.plantillaEquipo?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.lineaCarrito?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
      prisma.itemCatalogo?.count({ where: { productoId: id } }).catch(() => 0) ?? 0,
    ]);
  const total = lineas + movs + ordenes + detalles + activos + prestamos + series +
                bundleP + bundleH + reservas + plantillas + carrito + catalogo;
  return { total, lineas, movs, otros: total - lineas - movs };
}

(async () => {
  const prods = await prisma.producto.findMany({
    select: { id: true, sku: true, nombre: true, precio: true, stockActual: true, categoriaId: true },
    orderBy: { sku: 'asc' },
  });

  const grupos = new Map();
  for (const p of prods) {
    const k = clave(p.nombre);
    if (!k) continue;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(p);
  }
  const dups = [...grupos.entries()].filter(([, v]) => v.length > 1);

  if (dups.length === 0) { console.log('Sin duplicados en el catálogo.'); await prisma.$disconnect(); return; }

  console.log(`\n${dups.length} grupo(s) de productos duplicados:\n`);
  const purgables = [];
  for (const [k, items] of dups) {
    console.log(`• "${k}"`);
    for (const p of items) {
      const r = await contarReferencias(p.id);
      const marca = r.total === 0 ? 'SIN USO' : `usado (${r.lineas} línea(s), ${r.movs} mov., ${r.otros} otros)`;
      console.log(`    ${p.sku.padEnd(16)} RD$${String(Number(p.precio)).padStart(10)}  stock ${String(p.stockActual).padStart(3)}  ${marca}`);
      if (r.total === 0) purgables.push(p);
    }
  }

  // Nunca dejar un grupo vacío: si TODOS los de un grupo están sin uso, se
  // conserva el de SKU más alto (el cargado más recientemente, con el precio
  // vigente) y se purga el resto.
  const porGrupo = new Map();
  for (const [k, items] of dups) porGrupo.set(k, items);
  const conservar = new Set();
  for (const [k, items] of porGrupo) {
    const sinUso = items.filter(p => purgables.some(q => q.id === p.id));
    if (sinUso.length === items.length) conservar.add(sinUso.sort((a, b) => a.sku < b.sku ? 1 : -1)[0].id);
  }
  const aPurgar = purgables.filter(p => !conservar.has(p.id));

  console.log(`\nPurgables (duplicado sin ninguna referencia): ${aPurgar.length}`);
  aPurgar.forEach(p => console.log(`    ${p.sku}  ${p.nombre}`));
  if (conservar.size > 0) console.log(`Conservados por ser el único vivo de su grupo: ${conservar.size}`);

  if (!PURGAR) {
    console.log('\nModo reporte. Para borrar los purgables: node scripts/ops/duplicados-catalogo.js --purgar\n');
    await prisma.$disconnect();
    return;
  }
  if (aPurgar.length === 0) { console.log('\nNada que purgar.\n'); await prisma.$disconnect(); return; }

  // Revalidación dentro de la transacción: entre el reporte y el borrado alguien
  // pudo haber usado el producto en una cotización.
  let borrados = 0;
  for (const p of aPurgar) {
    const r = await contarReferencias(p.id);
    if (r.total > 0) { console.log(`  SALTADO ${p.sku}: adquirió referencias (${r.total})`); continue; }
    await prisma.producto.delete({ where: { id: p.id } });
    console.log(`  borrado ${p.sku}  ${p.nombre}`);
    borrados++;
  }
  console.log(`\n${borrados} producto(s) duplicado(s) borrado(s).\n`);
  await prisma.$disconnect();
})().catch(e => { console.error('ERR:', e.message); process.exitCode = 1; });
