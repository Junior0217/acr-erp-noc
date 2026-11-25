'use strict';
/**
 * backend/scripts/db-ops/export-fiscal.js
 *
 * Export lógico de los datos fiscalmente relevantes a un JSON portable.
 *
 * POR QUÉ EXISTE: el backup real (.github/workflows/backup-db.yml) usa pg_dump
 * y depende del secret DATABASE_URL en GitHub. Mientras ese secret no esté
 * cargado —y en cualquier máquina sin cliente de PostgreSQL instalado— no hay
 * forma de sacar un respaldo. Este script solo necesita Prisma, así que corre
 * donde sea y cubre el hueco.
 *
 * NO reemplaza al pg_dump: no trae esquema, índices, permisos ni tablas no
 * fiscales. Es la red de seguridad para lo que la DGII exige conservar 10 años
 * (Norma 06-2018 art. 7): comprobantes emitidos con su NCF y su detalle.
 *
 * Uso:
 *   node scripts/db-ops/export-fiscal.js [--out <carpeta>] [--todo]
 *     --out   carpeta destino (default: ./backups)
 *     --todo  incluye también cotizaciones y catálogo, no solo lo fiscal
 *
 * Verifica cada factura contra su verifyHash y aborta si alguna no cuadra:
 * respaldar un documento ya alterado daría una falsa sensación de seguridad.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const createVerifyHash = require('../../shared/services/verify-hash.service.js');

const args = process.argv.slice(2);
const TODO = args.includes('--todo');
const OUT = (() => {
  const i = args.indexOf('--out');
  return i !== -1 && args[i + 1] ? args[i + 1] : path.join(process.cwd(), 'backups');
})();

(async () => {
  const { facturaVerifyHash } = createVerifyHash({ prisma });
  fs.mkdirSync(OUT, { recursive: true });

  const incluirLineas = {
    lineas: { include: { producto: { select: { sku: true, nombre: true } } } },
    cliente: true,
  };

  // 1) Comprobantes fiscales emitidos — el núcleo irreemplazable.
  const fiscales = await prisma.factura.findMany({
    where: { esCotizacion: false, ncf: { not: null } },
    include: incluirLineas,
    orderBy: { ncf: 'asc' },
  });

  // 2) Integridad: ninguna factura respaldada puede venir alterada.
  const alteradas = [];
  for (const f of fiscales) {
    if (f.verifyHash && facturaVerifyHash(f) !== f.verifyHash) alteradas.push(f.noFactura);
  }
  if (alteradas.length > 0) {
    console.error(`ABORTADO: ${alteradas.length} factura(s) con verifyHash inválido: ${alteradas.join(', ')}`);
    console.error('Se detuvo el export a propósito: respaldar un documento alterado esconde el problema.');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const payload = {
    _meta: {
      generado:     new Date().toISOString(),
      origen:       'export-fiscal.js',
      alcance:      TODO ? 'fiscal + cotizaciones + catálogo' : 'solo comprobantes fiscales',
      advertencia:  'Export lógico. NO incluye esquema ni tablas no fiscales. No sustituye pg_dump.',
      facturas:     fiscales.length,
    },
    empresa:        await prisma.empresaPerfil.findUnique({ where: { id: 1 } }),
    configuracionNcf: await prisma.$queryRawUnsafe('SELECT * FROM "ConfiguracionNCF" ORDER BY prefijo'),
    facturasFiscales: fiscales,
  };

  if (TODO) {
    payload.cotizaciones = await prisma.factura.findMany({
      where: { esCotizacion: true, deletedAt: null }, include: incluirLineas, orderBy: { noFactura: 'asc' },
    });
    payload.clientes  = await prisma.cliente.findMany({ where: { deletedAt: null } });
    payload.productos = await prisma.producto.findMany({ orderBy: { sku: 'asc' } });
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
  const dest = path.join(OUT, `export-fiscal-${stamp}.json`);
  // Decimal y BigInt de Prisma no son JSON-serializables por defecto.
  fs.writeFileSync(dest, JSON.stringify(payload, (_k, v) => {
    if (typeof v === 'bigint') return Number(v);
    if (v && typeof v === 'object' && typeof v.toFixed === 'function' && v.constructor?.name === 'Decimal') return Number(v);
    return v;
  }, 2), 'utf8');

  const kb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`\nExport OK → ${dest} (${kb} KB)`);
  console.log(`  comprobantes fiscales : ${fiscales.length} (verifyHash validado)`);
  fiscales.forEach(f => console.log(`     ${f.ncf}  ${f.noFactura}  ${f.fechaEmision.toISOString().slice(0, 10)}  RD$${Number(f.total).toFixed(2)}`));
  if (TODO) console.log(`  cotizaciones: ${payload.cotizaciones.length} · clientes: ${payload.clientes.length} · productos: ${payload.productos.length}`);
  console.log('\nRecordatorio: esto NO sustituye el pg_dump del workflow. Guarda el archivo fuera de esta máquina.\n');
  await prisma.$disconnect();
})().catch(e => { console.error('ERR:', e.message); process.exitCode = 1; });
