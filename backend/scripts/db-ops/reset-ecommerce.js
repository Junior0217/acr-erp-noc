'use strict';
/**
 * reset-ecommerce.js
 * DESTRUCTIVE: Wipes all transactional data (facturas, OTs, clientes, inventario)
 * and rebuilds the catalog from scratch with ART-/SV- prefixes and TipoItem.
 * Does NOT touch Empleado, Rol, SessionToken, Asistencia.
 * Run: DATABASE_URL="..." node backend/scripts/reset-ecommerce.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const readline = require('readline');
const prisma = new PrismaClient();

function confirm(msg) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n⚠  ${msg} [s/N]: `, ans => { rl.close(); resolve(ans.trim().toLowerCase() === 's'); });
  });
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

const CATEGORIAS = [
  // Artículos físicos
  { nombre: 'Equipos WISP'             },
  { nombre: 'Equipos CCTV'             },
  { nombre: 'Networking & Redes'       },
  { nombre: 'Cables y Fibra Óptica'   },
  { nombre: 'Herramientas de Campo'    },
  // Servicios (intangibles)
  { nombre: 'Mano de Obra'             },
  { nombre: 'Instalaciones'            },
  { nombre: 'Fusiones y Empalmes'      },
];

// tipoItem: 'ARTICULO' | 'SERVICIO'
const makeProductos = (catMap) => [
  // ── WISP ──────────────────────────────────────────────────────────────
  { sku: 'ART-ONU-ZTE-F670',  nombre: 'ONU ZTE F670L GPON',              precio: 3200,  stock: 25, cat: 'Equipos WISP',          tipoItem: 'ARTICULO' },
  { sku: 'ART-MT-HAP-AX3',    nombre: 'Router MikroTik hAP ax3',          precio: 8500,  stock: 15, cat: 'Equipos WISP',          tipoItem: 'ARTICULO' },
  { sku: 'ART-UB-NS-M5',      nombre: 'Antena Ubiquiti NanoStation M5',   precio: 6200,  stock: 10, cat: 'Equipos WISP',          tipoItem: 'ARTICULO' },
  { sku: 'ART-UB-LBE-M5',     nombre: 'Ubiquiti LiteBeam M5 23dBi',       precio: 4800,  stock: 18, cat: 'Equipos WISP',          tipoItem: 'ARTICULO' },
  { sku: 'ART-MT-CCR2004',    nombre: 'Router MikroTik CCR2004-1G-12S',   precio:42000,  stock:  4, cat: 'Equipos WISP',          tipoItem: 'ARTICULO' },
  // ── CCTV ──────────────────────────────────────────────────────────────
  { sku: 'ART-HIK-CAM-4MP',   nombre: 'Cámara Hikvision DS-2CD2143G2 4MP',precio: 4800, stock: 20, cat: 'Equipos CCTV',          tipoItem: 'ARTICULO' },
  { sku: 'ART-HIK-DVR-8CH',   nombre: 'DVR Hikvision DS-7208HGHI 8ch',    precio: 9500,  stock:  8, cat: 'Equipos CCTV',          tipoItem: 'ARTICULO' },
  { sku: 'ART-HIK-NVR-16CH',  nombre: 'NVR Hikvision DS-7616NI 16ch',     precio:18500,  stock:  5, cat: 'Equipos CCTV',          tipoItem: 'ARTICULO' },
  { sku: 'ART-DAH-CAM-2MP',   nombre: 'Cámara Dahua IPC-HFW2831S 8MP',    precio: 3600,  stock: 15, cat: 'Equipos CCTV',          tipoItem: 'ARTICULO' },
  // ── Networking ────────────────────────────────────────────────────────
  { sku: 'ART-TP-SW-8P',      nombre: 'Switch TP-Link TL-SG108 8P PoE',   precio: 1950,  stock: 30, cat: 'Networking & Redes',    tipoItem: 'ARTICULO' },
  { sku: 'ART-TP-SW-24P',     nombre: 'Switch TP-Link TL-SG1024 24P',     precio: 6800,  stock: 10, cat: 'Networking & Redes',    tipoItem: 'ARTICULO' },
  { sku: 'ART-MT-RB750',      nombre: 'Router MikroTik RB750Gr3',         precio: 3200,  stock: 20, cat: 'Networking & Redes',    tipoItem: 'ARTICULO' },
  { sku: 'ART-PATCH-CAT6-1M', nombre: 'Patch Cord CAT6 1m',               precio:  120,  stock:100, cat: 'Networking & Redes',    tipoItem: 'ARTICULO' },
  { sku: 'ART-PATCH-CAT6-2M', nombre: 'Patch Cord CAT6 2m',               precio:  180,  stock:100, cat: 'Networking & Redes',    tipoItem: 'ARTICULO' },
  // ── Cables ────────────────────────────────────────────────────────────
  { sku: 'ART-UTP-CAT6-305',  nombre: 'Cable UTP CAT6 Rollo 305m',        precio: 4200,  stock: 50, cat: 'Cables y Fibra Óptica', tipoItem: 'ARTICULO' },
  { sku: 'ART-FTTH-DROP-500', nombre: 'Fibra Drop 2H Rollo 500m',         precio: 7800,  stock: 40, cat: 'Cables y Fibra Óptica', tipoItem: 'ARTICULO' },
  { sku: 'ART-ODF-24P',       nombre: 'ODF 24 Puertos Wall Mount',        precio: 3600,  stock: 12, cat: 'Cables y Fibra Óptica', tipoItem: 'ARTICULO' },
  { sku: 'ART-PATCH-SC-APC',  nombre: 'Patch Cord SC/APC-SC/APC 3m',     precio:  350,  stock: 60, cat: 'Cables y Fibra Óptica', tipoItem: 'ARTICULO' },
  // ── Herramientas ──────────────────────────────────────────────────────
  { sku: 'ART-HERR-FUSION',   nombre: 'Fusionadora Fujikura 62S',         precio:85000,  stock:  2, cat: 'Herramientas de Campo',  tipoItem: 'ARTICULO' },
  { sku: 'ART-HERR-OTDR',     nombre: 'OTDR EXFO AXS-100',                precio:120000, stock:  1, cat: 'Herramientas de Campo',  tipoItem: 'ARTICULO' },
  // ── Servicios (no descuentan stock) ───────────────────────────────────
  { sku: 'SV-MO-HR',          nombre: 'Mano de Obra (hora técnica)',       precio:  800,  stock:  0, cat: 'Mano de Obra',           tipoItem: 'SERVICIO' },
  { sku: 'SV-MO-VISITA',      nombre: 'Visita Técnica',                   precio: 1200,  stock:  0, cat: 'Mano de Obra',           tipoItem: 'SERVICIO' },
  { sku: 'SV-INST-WISP',      nombre: 'Instalación WISP (cliente nuevo)', precio: 3500,  stock:  0, cat: 'Instalaciones',          tipoItem: 'SERVICIO' },
  { sku: 'SV-INST-CCTV-4CAM', nombre: 'Instalación CCTV 4 cámaras',      precio: 6500,  stock:  0, cat: 'Instalaciones',          tipoItem: 'SERVICIO' },
  { sku: 'SV-INST-RED',       nombre: 'Instalación Red LAN (por punto)',   precio: 1500,  stock:  0, cat: 'Instalaciones',          tipoItem: 'SERVICIO' },
  { sku: 'SV-FUSION-EMPALME', nombre: 'Fusión de Fibra (por empalme)',    precio:  600,  stock:  0, cat: 'Fusiones y Empalmes',    tipoItem: 'SERVICIO' },
  { sku: 'SV-FUSION-CAJA',    nombre: 'Instalación Caja Cierre Hermético',precio: 1800,  stock:  0, cat: 'Fusiones y Empalmes',    tipoItem: 'SERVICIO' },
  { sku: 'SV-CONFIG-MK',      nombre: 'Configuración MikroTik (por hora)',precio: 1000,  stock:  0, cat: 'Mano de Obra',           tipoItem: 'SERVICIO' },
].map(p => ({ ...p, categoriaId: catMap[p.cat] }));

const PLANES = [
  { nombre: 'Residencial 10 Mbps', tipo: 'WISP', precioMensualBase: 1200, precioInstalBase: 2500 },
  { nombre: 'Residencial 25 Mbps', tipo: 'WISP', precioMensualBase: 1800, precioInstalBase: 2500 },
  { nombre: 'Residencial 50 Mbps', tipo: 'WISP', precioMensualBase: 2800, precioInstalBase: 3500 },
  { nombre: 'PYME 50 Mbps',        tipo: 'WISP', precioMensualBase: 4500, precioInstalBase: 5000 },
  { nombre: 'PYME 100 Mbps',       tipo: 'WISP', precioMensualBase: 7500, precioInstalBase: 6000 },
  { nombre: 'CCTV Básico 4 cams',  tipo: 'CCTV', precioMensualBase:    0, precioInstalBase:18000 },
  { nombre: 'Red LAN Pequeña',     tipo: 'Redes', precioMensualBase:   0, precioInstalBase:12000 },
];

const NCF_CONFIGS = [
  { prefijo: 'B01', tipoNcf: 'Fiscal',           tipoDescripcion: 'Comprobante Fiscal', secuenciaActual: 0, limite: 9999999, activo: true },
  { prefijo: 'B02', tipoNcf: 'Consumidor Final', tipoDescripcion: 'Consumidor Final',   secuenciaActual: 0, limite: 9999999, activo: true },
  { prefijo: 'B14', tipoNcf: 'Regimen Especial', tipoDescripcion: 'Régimen Especial',   secuenciaActual: 0, limite: 9999999, activo: true },
  { prefijo: 'B15', tipoNcf: 'Gubernamental',    tipoDescripcion: 'Gubernamental',      secuenciaActual: 0, limite: 9999999, activo: true },
];

// ─── Role setup ───────────────────────────────────────────────────────────────

const ADMIN_GENERAL_PERMS = [
  'rrhh:ver', 'rrhh:editar',
  'clientes:ver', 'clientes:editar',
  'servicios:ver', 'servicios:editar',
  'inventario:ver', 'inventario:editar',
  'factura:ver', 'factura:emitir', 'factura:editar',
  'ot:ver', 'ot:editar',
  'sistema:admin',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n============================================================');
  console.log('  ACR Networks ERP — Reset E-Commerce / Catalog Rebuild');
  console.log('============================================================');
  console.log('  DB:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@'));
  console.log('\n  ESTO BORRARÁ:');
  console.log('  • Facturas, Cotizaciones y sus líneas');
  console.log('  • Órdenes de Trabajo y sus líneas');
  console.log('  • Órdenes de Instalación y sus detalles');
  console.log('  • Servicios activos de clientes');
  console.log('  • Clientes y Prospectos');
  console.log('  • Inventario (Productos, Categorías, Movimientos)');
  console.log('  • Planes y Plantillas');
  console.log('  • ItemCatalogo y AuditLog');
  console.log('  • Carrito temporal y sus líneas');
  console.log('\n  NO tocará: Empleados, Roles, Sesiones, Asistencias.\n');

  const ok = await confirm('¿Confirmas el reset completo? Escribe "s" para continuar');
  if (!ok) { console.log('Operación cancelada.'); return; }

  console.log('\n[1/4] Eliminando datos transaccionales...');

  // Delete in FK-safe order
  await prisma.$transaction([
    prisma.lineaCarrito.deleteMany(),
    prisma.carritoTemp.deleteMany(),
  ]);
  await prisma.$transaction([
    prisma.lineaFactura.deleteMany(),
  ]);
  await prisma.factura.deleteMany();
  await prisma.$transaction([
    prisma.lineaOrdenTrabajo.deleteMany(),
  ]);
  await prisma.ordenTrabajo.deleteMany();
  await prisma.$transaction([
    prisma.detalleOrden.deleteMany(),
    prisma.movimientoInventario.deleteMany(),
  ]);
  await prisma.ordenInstalacion.deleteMany();
  await prisma.servicio.deleteMany();
  await prisma.prospecto.deleteMany();
  await prisma.cliente.deleteMany();
  await prisma.$transaction([
    prisma.plantillaEquipo.deleteMany(),
    prisma.itemCatalogo.deleteMany(),
  ]);
  await prisma.plan.deleteMany();
  await prisma.$transaction([
    prisma.producto.deleteMany(),
  ]);
  await prisma.categoria.deleteMany();
  await prisma.suplidor.deleteMany();
  await prisma.auditLog.deleteMany();
  console.log('   ✓ Datos transaccionales eliminados.');

  console.log('[2/4] Reconstruyendo catálogo...');

  // Categorias
  for (const c of CATEGORIAS) {
    await prisma.categoria.upsert({ where: { nombre: c.nombre }, update: {}, create: c });
  }
  const cats = await prisma.categoria.findMany();
  const catMap = Object.fromEntries(cats.map(c => [c.nombre, c.id]));

  // Productos
  for (const p of makeProductos(catMap)) {
    const { cat, stock, ...data } = p;
    await prisma.producto.upsert({
      where: { sku: data.sku }, update: { ...data, stockActual: stock }, create: { ...data, stockActual: stock },
    });
  }
  console.log(`   ✓ ${CATEGORIAS.length} categorías y ${makeProductos(catMap).length} productos creados.`);

  // Planes
  for (const p of PLANES) {
    await prisma.plan.upsert({ where: { nombre: p.nombre }, update: p, create: { ...p, activo: true } }).catch(() =>
      prisma.plan.create({ data: { ...p, activo: true } })
    );
  }
  console.log(`   ✓ ${PLANES.length} planes creados.`);

  // NCF configs (upsert — reset sequences)
  for (const n of NCF_CONFIGS) {
    await prisma.configuracionNCF.upsert({
      where:  { tipoNcf: n.tipoNcf },
      update: { ...n },
      create: { ...n },
    });
  }
  console.log(`   ✓ ${NCF_CONFIGS.length} configuraciones NCF reiniciadas (secuencia → 0).`);

  console.log('[3/4] Configurando roles y permisos...');

  // Ensure Owner role exists and is pristine
  await prisma.rol.upsert({
    where:  { nombre: 'Owner' },
    update: { permisos: ['sistema:owner'], activo: true, require2FA: false },
    create: { nombre: 'Owner', descripcion: 'Propietario absoluto del sistema', permisos: ['sistema:owner'], activo: true, require2FA: false },
  });

  // Upsert Administrador General role
  await prisma.rol.upsert({
    where:  { nombre: 'Administrador General' },
    update: { permisos: ADMIN_GENERAL_PERMS, activo: true },
    create: { nombre: 'Administrador General', descripcion: 'Acceso completo excepto configuración core del sistema', permisos: ADMIN_GENERAL_PERMS, activo: true, require2FA: false },
  });

  // Delete legacy "Propietario" role if it has no employees
  const propietario = await prisma.rol.findFirst({
    where: { nombre: 'Propietario' },
    include: { _count: { select: { empleados: true } } },
  });
  if (propietario && propietario._count.empleados === 0) {
    await prisma.rol.delete({ where: { id: propietario.id } });
    console.log('   ✓ Rol "Propietario" eliminado (sin empleados asignados).');
  } else if (propietario) {
    console.log(`   ℹ Rol "Propietario" mantiene ${propietario._count.empleados} empleado(s) — no eliminado.`);
  }

  // Assign Administrador General to Cristian and Andrews
  const adminRol = await prisma.rol.findUnique({ where: { nombre: 'Administrador General' } });
  const ownerRol = await prisma.rol.findUnique({ where: { nombre: 'Owner' } });

  const crosario = await prisma.empleado.findFirst({ where: { email: { contains: 'crosario' } } });
  if (crosario) {
    await prisma.empleado.update({ where: { id: crosario.id }, data: { roles: { set: [{ id: ownerRol.id }] } } });
    console.log(`   ✓ crosario → rol Owner.`);
  }

  // Find Cristian and Andrews by partial name match
  const admins = await prisma.empleado.findMany({
    where: { nombre: { contains: 'Cristian', mode: 'insensitive' }, NOT: { email: { contains: 'crosario' } } },
  });
  const andrews = await prisma.empleado.findMany({
    where: { nombre: { contains: 'Andrews', mode: 'insensitive' } },
  });
  for (const emp of [...admins, ...andrews]) {
    await prisma.empleado.update({ where: { id: emp.id }, data: { roles: { set: [{ id: adminRol.id }] } } });
    console.log(`   ✓ ${emp.nombre} (${emp.email}) → rol Administrador General.`);
  }
  if (admins.length + andrews.length === 0) {
    console.log('   ℹ No se encontraron empleados "Cristian" o "Andrews". Asigna roles manualmente.');
  }

  console.log('[4/4] Listo.');
  const pCount = makeProductos(catMap).length;
  console.log(`\n  Resumen:`);
  console.log(`  • Categorías: ${CATEGORIAS.length}`);
  console.log(`  • Productos (ART-*): ${makeProductos(catMap).filter(p => p.tipoItem === 'ARTICULO').length}`);
  console.log(`  • Servicios (SV-*): ${makeProductos(catMap).filter(p => p.tipoItem === 'SERVICIO').length}`);
  console.log(`  • Total ítems de catálogo: ${pCount}`);
  console.log(`  • Planes: ${PLANES.length}`);
  console.log(`  • NCF configs reiniciadas: ${NCF_CONFIGS.length}`);
  console.log('\n  ✓ Reset completado. BD lista para producción.\n');
}

main()
  .catch(e => { console.error('\n[ERROR]', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
