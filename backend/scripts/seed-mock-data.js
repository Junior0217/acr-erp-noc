'use strict';
// Seed realistic mock data for ACR Networks ERP — Dominican Republic ISP context
// All records prefixed with "[TEST]" for easy cleanup.
// NEVER touches existing employees (no upsert on Empleado).
// Run: DATABASE_URL="..." node backend/scripts/seed-mock-data.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient, TipoServicio, EstadoServicio, TipoOrden, EstadoFactura, TipoFacturacion } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = arr => arr[rnd(0, arr.length - 1)];
const daysAgo  = n => new Date(Date.now() - n * 86_400_000);
const daysAhead = n => new Date(Date.now() + n * 86_400_000);

// ─── 1. Categorías ───────────────────────────────────────────────────────────

const CATEGORIAS = [
  { nombre: '[TEST] Equipos WISP'           },
  { nombre: '[TEST] Equipos CCTV'           },
  { nombre: '[TEST] Networking / Redes'      },
  { nombre: '[TEST] Cables y Fibra Óptica'  },
  { nombre: '[TEST] Herramientas de Campo'   },
];

// ─── 2. Productos ─────────────────────────────────────────────────────────────

const makeProductos = catMap => [
  { sku: 'TEST-ONU-ZTE-F670', nombre: '[TEST] ONU ZTE F670L GPON',           precio: 3200,  stock: 25, cat: '[TEST] Equipos WISP'          },
  { sku: 'TEST-MT-HAP-AX3',   nombre: '[TEST] Router MikroTik hAP ax3',      precio: 8500,  stock: 15, cat: '[TEST] Equipos WISP'          },
  { sku: 'TEST-UB-NS-M5',     nombre: '[TEST] Antena Ubiquiti NanoStation M5',precio: 6200,  stock: 10, cat: '[TEST] Equipos WISP'          },
  { sku: 'TEST-HIK-CAM-4MP',  nombre: '[TEST] Cámara Hikvision DS-2CD2143G2 4MP', precio: 4800, stock: 20, cat: '[TEST] Equipos CCTV'    },
  { sku: 'TEST-HIK-DVR-8CH',  nombre: '[TEST] DVR Hikvision DS-7208HGHI 8ch',precio: 9500,  stock: 8,  cat: '[TEST] Equipos CCTV'          },
  { sku: 'TEST-TP-SW-8P',     nombre: '[TEST] Switch TP-Link TL-SG108 8P',   precio: 1950,  stock: 30, cat: '[TEST] Networking / Redes'    },
  { sku: 'TEST-MT-CCR2004',   nombre: '[TEST] Router MikroTik CCR2004-1G-12S',precio:42000, stock: 4,  cat: '[TEST] Networking / Redes'    },
  { sku: 'TEST-UTP-CAT6-305', nombre: '[TEST] Cable UTP CAT6 Rollo 305m',    precio: 4200,  stock: 50, cat: '[TEST] Cables y Fibra Óptica' },
  { sku: 'TEST-FTTH-DROP-500',nombre: '[TEST] Fibra Drop 2H Rollo 500m',     precio: 7800,  stock: 40, cat: '[TEST] Cables y Fibra Óptica' },
  { sku: 'TEST-ODF-24P',      nombre: '[TEST] ODF 24 Puertos Wall Mount',     precio: 3600,  stock: 12, cat: '[TEST] Cables y Fibra Óptica' },
  { sku: 'TEST-HERR-FUSION',  nombre: '[TEST] Fusionadora Fujikura 62S',      precio:85000, stock: 2,  cat: '[TEST] Herramientas de Campo'  },
  { sku: 'TEST-HERR-OTDR',    nombre: '[TEST] OTDR EXFO AXS-100',             precio:120000,stock: 1,  cat: '[TEST] Herramientas de Campo'  },
].map(p => ({ ...p, categoriaId: catMap[p.cat] }));

// ─── 3. Roles adicionales ────────────────────────────────────────────────────

const ROLES = [
  { nombre: '[TEST] Cajero',           descripcion: 'Gestión de cobros y facturas', permisos: ['ventas:ver', 'ventas:crear'], require2FA: false },
  { nombre: '[TEST] Técnico de Campo', descripcion: 'Instalaciones y soporte técnico', permisos: ['rrhh:ver', 'inventario:ver'], require2FA: false },
  { nombre: '[TEST] Supervisor NOC',   descripcion: 'Supervisión de operaciones', permisos: ['rrhh:ver', 'clientes:ver', 'servicios:ver', 'inventario:ver'], require2FA: false },
];

// ─── 4. Clientes ─────────────────────────────────────────────────────────────

const CLIENTES = [
  { noCliente: 'CL-TEST-001', razonSocial: '[TEST] Colmado Los Tres Hermanos', tipoCliente: 'Empresa',     tipoEmpresa: 'PYME',        nombreContacto: 'Pedro',   apellidoContacto: 'Jiménez',   telefonoPrincipal: '809-555-0101', email: 'colmado.treshermanos@test.do', direccion: 'Calle Duarte #12', sector: 'Centro', provincia: 'Santo Domingo', rnc: '1-01-00001-1' },
  { noCliente: 'CL-TEST-002', razonSocial: '[TEST] Ferretería Don Ramón',       tipoCliente: 'Empresa',     tipoEmpresa: 'PYME',        nombreContacto: 'Ramón',    apellidoContacto: 'Peralta',   telefonoPrincipal: '809-555-0102', email: 'ferr.donramon@test.do',       direccion: 'Ave. Independencia #88', sector: 'Gazcue', provincia: 'Santo Domingo', rnc: '1-01-00002-2' },
  { noCliente: 'CL-TEST-003', razonSocial: '[TEST] Clínica Familiar La Salud',  tipoCliente: 'Empresa',     tipoEmpresa: 'Empresa',     nombreContacto: 'Dra. Ana', apellidoContacto: 'Castro',    telefonoPrincipal: '809-555-0103', email: 'clinica.lasalud@test.do',     direccion: 'Calle El Conde #5', sector: 'Ciudad Colonial', provincia: 'Santo Domingo' },
  { noCliente: 'CL-TEST-004', razonSocial: '[TEST] Supermercado El Buen Precio',tipoCliente: 'Empresa',     tipoEmpresa: 'Empresa',     nombreContacto: 'Luis',     apellidoContacto: 'Fernández', telefonoPrincipal: '829-555-0104', email: 'super.buenprecio@test.do',    direccion: 'Calle Mella #200', sector: 'Los Mina', provincia: 'Santo Domingo Este' },
  { noCliente: 'CL-TEST-005', razonSocial: '[TEST] Residencial Juan López',     tipoCliente: 'Residencial', tipoEmpresa: 'Residencial', nombreContacto: 'Juan',     apellidoContacto: 'López',     telefonoPrincipal: '849-555-0105', email: 'j.lopez.test@gmail.com',      direccion: 'Calle Hostos #45 Apt 3B', sector: 'Naco', provincia: 'Santo Domingo' },
  { noCliente: 'CL-TEST-006', razonSocial: '[TEST] Hotel Playa Caribe',         tipoCliente: 'Empresa',     tipoEmpresa: 'Empresa',     nombreContacto: 'Carlos',   apellidoContacto: 'Marte',     telefonoPrincipal: '809-555-0106', email: 'it.playacaribe@test.do',      direccion: 'Playa Bávaro Km 3', sector: 'Bávaro', provincia: 'La Altagracia', rnc: '1-01-00006-6' },
  { noCliente: 'CL-TEST-007', razonSocial: '[TEST] Escuela Básica San Martín',  tipoCliente: 'Institución', tipoEmpresa: 'Institución', nombreContacto: 'Directora María', apellidoContacto: 'Soto', telefonoPrincipal: '809-555-0107', email: 'escuela.sanmartin@test.do',   direccion: 'Av. 27 de Febrero #310', sector: 'La Julia', provincia: 'Santo Domingo' },
  { noCliente: 'CL-TEST-008', razonSocial: '[TEST] Residencial María Rodríguez',tipoCliente: 'Residencial', tipoEmpresa: 'Residencial', nombreContacto: 'María',    apellidoContacto: 'Rodríguez', telefonoPrincipal: '809-555-0108', email: 'm.rodriguez.test@gmail.com',  direccion: 'Calle Pasteur #8', sector: 'Piantini', provincia: 'Santo Domingo' },
  { noCliente: 'CL-TEST-009', razonSocial: '[TEST] Centro Comercial Las Torres',tipoCliente: 'Empresa',     tipoEmpresa: 'Empresa',     nombreContacto: 'Ing. Roberto', apellidoContacto: 'Díaz', telefonoPrincipal: '809-555-0109', email: 'admin.lastorres@test.do',     direccion: 'Ave. Tiradentes #58', sector: 'Naco', provincia: 'Santo Domingo', rnc: '1-01-00009-9' },
  { noCliente: 'CL-TEST-010', razonSocial: '[TEST] Residencial Carlos Mejía',   tipoCliente: 'Residencial', tipoEmpresa: 'Residencial', nombreContacto: 'Carlos',   apellidoContacto: 'Mejía',     telefonoPrincipal: '849-555-0110', email: 'c.mejia.test@gmail.com',      direccion: 'Urb. Los Jardines #14', sector: 'Los Jardines', provincia: 'Santiago' },
];

// ─── 5. Planes ───────────────────────────────────────────────────────────────

const PLANES = [
  { nombre: '[TEST] Residencial 30Mbps',    tipo: TipoServicio.WISP,          precioMensualBase: 1500, precioInstalBase: 2500 },
  { nombre: '[TEST] Residencial 50Mbps',    tipo: TipoServicio.WISP,          precioMensualBase: 2200, precioInstalBase: 2500 },
  { nombre: '[TEST] Empresarial 100Mbps',   tipo: TipoServicio.WISP,          precioMensualBase: 4500, precioInstalBase: 4000 },
  { nombre: '[TEST] Empresarial 200Mbps',   tipo: TipoServicio.WISP,          precioMensualBase: 7500, precioInstalBase: 4000 },
  { nombre: '[TEST] CCTV Básico 4 Cámaras', tipo: TipoServicio.CCTV,          precioMensualBase: 800,  precioInstalBase: 12000 },
  { nombre: '[TEST] CCTV Empresarial 8C',   tipo: TipoServicio.CCTV,          precioMensualBase: 1500, precioInstalBase: 22000 },
  { nombre: '[TEST] Soporte Técnico Mensual',tipo: TipoServicio.SoporteTecnico,precioMensualBase: 3000, precioInstalBase: 0 },
];

// ─── 6. Items de Catálogo ────────────────────────────────────────────────────

const ITEMS_CATALOGO = [
  { nombre: '[TEST] Servicio de Instalación WISP',   tipo: TipoFacturacion.Servicio,    categoria: TipoServicio.WISP,          precio: 2500, costo: 800  },
  { nombre: '[TEST] Servicio de Instalación CCTV',   tipo: TipoFacturacion.Servicio,    categoria: TipoServicio.CCTV,          precio: 5000, costo: 1500 },
  { nombre: '[TEST] Mensualidad Internet 50Mbps',    tipo: TipoFacturacion.Recurrente,  categoria: TipoServicio.WISP,          precio: 2200, costo: 0    },
  { nombre: '[TEST] Mensualidad Monitoreo CCTV',     tipo: TipoFacturacion.Recurrente,  categoria: TipoServicio.CCTV,          precio: 800,  costo: 0    },
  { nombre: '[TEST] Visita Técnica Diagnóstico',     tipo: TipoFacturacion.Servicio,    categoria: TipoServicio.SoporteTecnico,precio: 800,  costo: 200  },
  { nombre: '[TEST] Reemplazo ONU/Router',           tipo: TipoFacturacion.VentaUnica,  categoria: TipoServicio.WISP,          precio: 3500, costo: 2800 },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n[SEED MOCK] Starting mock data seed...\n');

  // ── Categorías ──────────────────────────────────────────────────────────────
  const catMap = {};
  for (const c of CATEGORIAS) {
    const r = await prisma.categoria.upsert({ where: { nombre: c.nombre }, update: {}, create: c });
    catMap[r.nombre] = r.id;
  }
  console.log(`  [Categoria      ] ${CATEGORIAS.length} records`);

  // ── Productos ───────────────────────────────────────────────────────────────
  const prodMap = {};
  for (const p of makeProductos(catMap)) {
    const { cat, ...data } = p;
    const r = await prisma.producto.upsert({ where: { sku: data.sku }, update: { nombre: data.nombre, precio: data.precio, stockActual: data.stock, categoriaId: data.categoriaId }, create: { sku: data.sku, nombre: data.nombre, precio: data.precio, stockActual: data.stock, categoriaId: data.categoriaId } });
    prodMap[r.sku] = r.id;
  }
  console.log(`  [Producto        ] ${Object.keys(prodMap).length} records`);

  // ── Roles adicionales ───────────────────────────────────────────────────────
  for (const rol of ROLES) {
    await prisma.rol.upsert({ where: { nombre: rol.nombre }, update: {}, create: rol });
  }
  console.log(`  [Rol             ] ${ROLES.length} records`);

  // ── Items catálogo ──────────────────────────────────────────────────────────
  const itemMap = {};
  for (const item of ITEMS_CATALOGO) {
    const r = await prisma.itemCatalogo.upsert({ where: { id: (await prisma.itemCatalogo.findFirst({ where: { nombre: item.nombre } }))?.id ?? '00000000-0000-0000-0000-000000000000' }, update: { precio: item.precio, costo: item.costo, activo: true }, create: item });
    itemMap[item.nombre] = r.id;
  }
  console.log(`  [ItemCatalogo    ] ${ITEMS_CATALOGO.length} records`);

  // ── Planes ──────────────────────────────────────────────────────────────────
  const planMap = {};
  for (const plan of PLANES) {
    const existing = await prisma.plan.findFirst({ where: { nombre: plan.nombre } });
    const r = existing
      ? await prisma.plan.update({ where: { id: existing.id }, data: plan })
      : await prisma.plan.create({ data: plan });
    planMap[plan.nombre] = r.id;
  }
  console.log(`  [Plan            ] ${PLANES.length} records`);

  // Attach sample plantilla to residential plans
  const onuId = prodMap['TEST-ONU-ZTE-F670'];
  const mtHapId = prodMap['TEST-MT-HAP-AX3'];
  for (const planNombre of ['[TEST] Residencial 30Mbps', '[TEST] Residencial 50Mbps']) {
    const planId = planMap[planNombre];
    if (onuId) await prisma.plantillaEquipo.upsert({ where: { planId_productoId: { planId, productoId: onuId } }, update: { cantidad: 1 }, create: { planId, productoId: onuId, cantidad: 1 } });
    if (mtHapId) await prisma.plantillaEquipo.upsert({ where: { planId_productoId: { planId, productoId: mtHapId } }, update: { cantidad: 1 }, create: { planId, productoId: mtHapId, cantidad: 1 } });
  }

  // ── Clientes ────────────────────────────────────────────────────────────────
  const clienteMap = {};
  for (const c of CLIENTES) {
    const r = await prisma.cliente.upsert({
      where:  { noCliente: c.noCliente },
      update: {},
      create: { ...c, tipoNcf: c.tipoEmpresa === 'Residencial' ? 'Consumidor Final' : 'Fiscal', itbis: true, activo: true },
    });
    clienteMap[c.noCliente] = r.id;
  }
  console.log(`  [Cliente         ] ${CLIENTES.length} records`);

  // ── Get existing employees for tech assignments (DO NOT MODIFY THEM) ────────
  const tecnicos = await prisma.empleado.findMany({ where: { bloqueado: false }, select: { id: true, nombre: true }, take: 5 });
  if (!tecnicos.length) { console.warn('  [WARN] No active employees found — OT tecnico will be null'); }
  const getTecnico = () => tecnicos.length ? pick(tecnicos).id : null;

  // ── Servicios ───────────────────────────────────────────────────────────────
  const SERVICIO_SPECS = [
    { noCliente: 'CL-TEST-001', planNombre: '[TEST] Residencial 50Mbps',    estado: EstadoServicio.Activo,         precioMensual: 2200, precioInstal: 2500  },
    { noCliente: 'CL-TEST-002', planNombre: '[TEST] Empresarial 100Mbps',   estado: EstadoServicio.Activo,         precioMensual: 4500, precioInstal: 4000  },
    { noCliente: 'CL-TEST-003', planNombre: '[TEST] CCTV Básico 4 Cámaras', estado: EstadoServicio.Activo,         precioMensual: 800,  precioInstal: 12000 },
    { noCliente: 'CL-TEST-004', planNombre: '[TEST] Empresarial 200Mbps',   estado: EstadoServicio.Activo,         precioMensual: 7500, precioInstal: 4000  },
    { noCliente: 'CL-TEST-005', planNombre: '[TEST] Residencial 30Mbps',    estado: EstadoServicio.Activo,         precioMensual: 1500, precioInstal: 2500  },
    { noCliente: 'CL-TEST-006', planNombre: '[TEST] CCTV Empresarial 8C',   estado: EstadoServicio.EnInstalacion,  precioMensual: 1500, precioInstal: 22000 },
    { noCliente: 'CL-TEST-007', planNombre: '[TEST] Residencial 50Mbps',    estado: EstadoServicio.Pendiente,      precioMensual: 2200, precioInstal: 2500  },
    { noCliente: 'CL-TEST-008', planNombre: '[TEST] Residencial 30Mbps',    estado: EstadoServicio.Suspendido,     precioMensual: 1500, precioInstal: 2500  },
    { noCliente: 'CL-TEST-009', planNombre: '[TEST] Soporte Técnico Mensual',estado: EstadoServicio.Activo,        precioMensual: 3000, precioInstal: 0     },
    { noCliente: 'CL-TEST-010', planNombre: '[TEST] Residencial 50Mbps',    estado: EstadoServicio.Activo,         precioMensual: 2200, precioInstal: 2500  },
  ];

  const servicioIds = [];
  for (const s of SERVICIO_SPECS) {
    const clienteId = clienteMap[s.noCliente];
    const planId    = planMap[s.planNombre];
    if (!clienteId || !planId) continue;
    const existing  = await prisma.servicio.findFirst({ where: { clienteId, planId } });
    const r = existing
      ? await prisma.servicio.update({ where: { id: existing.id }, data: { estado: s.estado, precioMensual: s.precioMensual, precioInstalacion: s.precioInstal } })
      : await prisma.servicio.create({ data: { clienteId, planId, estado: s.estado, precioMensual: s.precioMensual, precioInstalacion: s.precioInstal } });
    servicioIds.push({ id: r.id, clienteId, noCliente: s.noCliente });
  }
  console.log(`  [Servicio        ] ${servicioIds.length} records`);

  // ── Órdenes de Trabajo ──────────────────────────────────────────────────────
  const OT_SPECS = [
    { noCliente: 'CL-TEST-001', tipoOT: 'Instalacion', estado: 'Completada', daysAgoN: 30, itemNombre: '[TEST] Servicio de Instalación WISP', precio: 2500 },
    { noCliente: 'CL-TEST-002', tipoOT: 'Instalacion', estado: 'Completada', daysAgoN: 45, itemNombre: '[TEST] Servicio de Instalación WISP', precio: 2500 },
    { noCliente: 'CL-TEST-003', tipoOT: 'Instalacion', estado: 'Completada', daysAgoN: 20, itemNombre: '[TEST] Servicio de Instalación CCTV', precio: 5000 },
    { noCliente: 'CL-TEST-004', tipoOT: 'Soporte',     estado: 'Pendiente',  daysAgoN: 2,  itemNombre: '[TEST] Visita Técnica Diagnóstico',   precio: 800  },
    { noCliente: 'CL-TEST-005', tipoOT: 'Soporte',     estado: 'EnProceso',  daysAgoN: 1,  itemNombre: '[TEST] Visita Técnica Diagnóstico',   precio: 800  },
    { noCliente: 'CL-TEST-006', tipoOT: 'Instalacion', estado: 'EnProceso',  daysAgoN: 3,  itemNombre: '[TEST] Servicio de Instalación CCTV', precio: 5000 },
    { noCliente: 'CL-TEST-009', tipoOT: 'Mantenimiento',estado: 'Pendiente', daysAgoN: 0,  itemNombre: '[TEST] Visita Técnica Diagnóstico',   precio: 800  },
  ];

  const otIds = [];
  for (const ot of OT_SPECS) {
    const clienteId = clienteMap[ot.noCliente];
    if (!clienteId) continue;
    const tecnicoId = getTecnico();
    const existing  = await prisma.ordenTrabajo.findFirst({ where: { clienteId, tipoOT: ot.tipoOT, estado: ot.estado, createdAt: { gte: daysAgo(ot.daysAgoN + 1) } } });
    if (existing) { otIds.push(existing.id); continue; }
    const r = await prisma.ordenTrabajo.create({
      data: {
        clienteId, tecnicoId, tipoOT: ot.tipoOT, estado: ot.estado, metadatos: {},
        completadaEn: ot.estado === 'Completada' ? daysAgo(ot.daysAgoN) : null,
        lineas: { create: [{
          descripcion: ot.itemNombre, cantidad: 1, precioUnitario: ot.precio,
          itemCatalogoId: itemMap[ot.itemNombre] ?? null,
        }] },
      },
    });
    otIds.push(r.id);
  }
  console.log(`  [OrdenTrabajo    ] ${otIds.length} records`);

  // ── Facturas ────────────────────────────────────────────────────────────────
  const FAC_SPECS = [
    // Pagadas (clientes activos, meses anteriores)
    { noCliente: 'CL-TEST-001', noFac: 'FAC-TEST-001', estado: EstadoFactura.Pagada,   subtotal: 2200, itbis: 374,  daysAgoEmision: 32, daysAgoPago: 25  },
    { noCliente: 'CL-TEST-001', noFac: 'FAC-TEST-002', estado: EstadoFactura.Pagada,   subtotal: 2200, itbis: 374,  daysAgoEmision: 62, daysAgoPago: 55  },
    { noCliente: 'CL-TEST-002', noFac: 'FAC-TEST-003', estado: EstadoFactura.Pagada,   subtotal: 4500, itbis: 765,  daysAgoEmision: 30, daysAgoPago: 22  },
    { noCliente: 'CL-TEST-003', noFac: 'FAC-TEST-004', estado: EstadoFactura.Pagada,   subtotal: 5000, itbis: 850,  daysAgoEmision: 20, daysAgoPago: 15  },
    { noCliente: 'CL-TEST-004', noFac: 'FAC-TEST-005', estado: EstadoFactura.Pagada,   subtotal: 7500, itbis: 1275, daysAgoEmision: 30, daysAgoPago: 20  },
    // Emitidas (corriente)
    { noCliente: 'CL-TEST-001', noFac: 'FAC-TEST-006', estado: EstadoFactura.Emitida,  subtotal: 2200, itbis: 374,  daysAgoEmision: 2,  daysVence: 28    },
    { noCliente: 'CL-TEST-002', noFac: 'FAC-TEST-007', estado: EstadoFactura.Emitida,  subtotal: 4500, itbis: 765,  daysAgoEmision: 1,  daysVence: 29    },
    { noCliente: 'CL-TEST-005', noFac: 'FAC-TEST-008', estado: EstadoFactura.Emitida,  subtotal: 1500, itbis: 255,  daysAgoEmision: 5,  daysVence: 25    },
    { noCliente: 'CL-TEST-009', noFac: 'FAC-TEST-009', estado: EstadoFactura.Emitida,  subtotal: 3000, itbis: 510,  daysAgoEmision: 3,  daysVence: 27    },
    // Vencidas (cliente suspendido + otros morosos)
    { noCliente: 'CL-TEST-008', noFac: 'FAC-TEST-010', estado: EstadoFactura.Vencida,  subtotal: 1500, itbis: 255,  daysAgoEmision: 45, daysVence: -15   },
    { noCliente: 'CL-TEST-008', noFac: 'FAC-TEST-011', estado: EstadoFactura.Vencida,  subtotal: 1500, itbis: 255,  daysAgoEmision: 75, daysVence: -45   },
    { noCliente: 'CL-TEST-006', noFac: 'FAC-TEST-012', estado: EstadoFactura.Vencida,  subtotal: 5000, itbis: 850,  daysAgoEmision: 60, daysVence: -30   },
    // Instalaciones facturadas (con referencia a OT completada)
    { noCliente: 'CL-TEST-001', noFac: 'FAC-TEST-013', estado: EstadoFactura.Pagada,   subtotal: 2500, itbis: 425,  daysAgoEmision: 30, daysAgoPago: 28, otIndex: 0 },
    { noCliente: 'CL-TEST-003', noFac: 'FAC-TEST-014', estado: EstadoFactura.Pagada,   subtotal: 5000, itbis: 850,  daysAgoEmision: 20, daysAgoPago: 18, otIndex: 2 },
  ];

  let facCount = 0;
  for (const f of FAC_SPECS) {
    const clienteId = clienteMap[f.noCliente];
    if (!clienteId) continue;
    const total   = f.subtotal + f.itbis;
    const ordenId = f.otIndex !== undefined ? (otIds[f.otIndex] ?? null) : null;
    await prisma.factura.upsert({
      where:  { noFactura: f.noFac },
      update: { estado: f.estado, total },
      create: {
        noFactura:    f.noFac,
        clienteId,
        ordenId,
        estado:       f.estado,
        subtotal:     f.subtotal,
        itbis:        f.itbis,
        total,
        fechaEmision: daysAgo(f.daysAgoEmision),
        fechaVence:   f.daysVence !== undefined ? daysAhead(f.daysVence) : (f.daysAgoEmision ? daysAgo(Math.abs(f.daysVence ?? 0)) : null),
        fechaPago:    f.daysAgoPago ? daysAgo(f.daysAgoPago) : null,
        tipoNcf:      'Consumidor Final',
      },
    });
    facCount++;
  }
  console.log(`  [Factura         ] ${facCount} records`);

  // ── Prospectos ──────────────────────────────────────────────────────────────
  const PROSPECTOS = [
    { nombre: '[TEST] Alejandro Morales',  telefono: '809-555-1001', servicioInteresado: 'Internet 50Mbps',  origen: 'WhatsApp', estado: 'Nuevo'       },
    { nombre: '[TEST] Empresa Tech RD',    telefono: '809-555-1002', servicioInteresado: 'Internet 200Mbps + CCTV', origen: 'Referido', estado: 'Contactado' },
    { nombre: '[TEST] Isabel Gómez',       telefono: '829-555-1003', servicioInteresado: 'CCTV 4 Cámaras',   origen: 'Facebook', estado: 'Nuevo'       },
    { nombre: '[TEST] Distribuidora Norte',telefono: '809-555-1004', servicioInteresado: 'Fibra Empresarial', origen: 'Llamada',  estado: 'Propuesta'   },
    { nombre: '[TEST] Residencial El Pino',telefono: '849-555-1005', servicioInteresado: 'Internet 30Mbps',  origen: 'WhatsApp', estado: 'Nuevo'       },
  ];
  for (const p of PROSPECTOS) {
    const existing = await prisma.prospecto.findFirst({ where: { nombre: p.nombre } });
    if (!existing) await prisma.prospecto.create({ data: p });
  }
  console.log(`  [Prospecto       ] ${PROSPECTOS.length} records`);

  // ── NCF ──────────────────────────────────────────────────────────────────────
  const NCF_CONFIGS = [
    { prefijo: 'B01', tipoNcf: 'Fiscal',           tipoDescripcion: 'Crédito Fiscal',       secuenciaActual: 14, limite: 9999999, activo: true },
    { prefijo: 'B02', tipoNcf: 'Consumidor Final',  tipoDescripcion: 'Consumidor Final',     secuenciaActual: 52, limite: 9999999, activo: true },
    { prefijo: 'B14', tipoNcf: 'Régimen Especial',  tipoDescripcion: 'Régimen Especial',     secuenciaActual: 0,  limite: 9999999, activo: true },
    { prefijo: 'B15', tipoNcf: 'Gubernamental',     tipoDescripcion: 'Gubernamental',        secuenciaActual: 0,  limite: 9999999, activo: true },
  ];
  for (const n of NCF_CONFIGS) {
    await prisma.configuracionNCF.upsert({ where: { tipoNcf: n.tipoNcf }, update: {}, create: n });
  }
  console.log(`  [ConfigNCF       ] ${NCF_CONFIGS.length} records`);

  console.log('\n[SEED MOCK] ✓ Done. All [TEST] records created/verified.');
  console.log('[SEED MOCK] To clean up: DELETE FROM "<Table>" WHERE nombre LIKE \'%[TEST]%\' (cascade handles relations).');
}

main()
  .catch(err => { console.error('[SEED MOCK] FATAL:', err.message, '\n', err.stack); process.exit(1); })
  .finally(() => prisma.$disconnect());
