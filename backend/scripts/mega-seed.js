#!/usr/bin/env node
'use strict'
/**
 * mega-seed.js — Full QA/demo population.
 * Safe to re-run: upserts where possible, skips real prod employees.
 * Adds prefix "[SEED]" to test employee emails for easy cleanup.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient, TipoServicio, TipoFacturacion, TipoItem,
        EstadoFactura, EstadoServicio, TipoOrden, TipoMovimiento, TipoAsistencia } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad  = (n, len = 8) => String(n).padStart(len, '0')
const dAgo = (days) => new Date(Date.now() - days * 86_400_000)

async function upsertCliente(data) {
  return prisma.cliente.upsert({
    where:  { noCliente: data.noCliente },
    update: {},
    create: data,
  })
}

async function upsertProducto(data) {
  return prisma.producto.upsert({
    where:  { sku: data.sku },
    update: {},
    create: data,
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══ MEGA-SEED ══════════════════════════════════════════')

  // ─── 0. Categorías (upsert) ───────────────────────────────────────────────
  const cats = await Promise.all([
    prisma.categoria.upsert({ where: { nombre: 'WISP'               }, update: {}, create: { nombre: 'WISP'               } }),
    prisma.categoria.upsert({ where: { nombre: 'CCTV'               }, update: {}, create: { nombre: 'CCTV'               } }),
    prisma.categoria.upsert({ where: { nombre: 'Redes'              }, update: {}, create: { nombre: 'Redes'              } }),
    prisma.categoria.upsert({ where: { nombre: 'Fibra Óptica'       }, update: {}, create: { nombre: 'Fibra Óptica'       } }),
    prisma.categoria.upsert({ where: { nombre: 'Equipos de Cómputo' }, update: {}, create: { nombre: 'Equipos de Cómputo' } }),
  ])
  const [catWisp, catCCTV, catRedes, catFibra, catComp] = cats
  console.log('  ✓ Categorías')

  // ─── 1. Clientes (10 non-CF) ──────────────────────────────────────────────
  const cliBase    = { tipoNcf: 'Fiscal',           itbis: true,  activo: true, tipoCliente: 'Corporativo', sector: 'Piantini',    provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0000', email: 'default@acr.do', direccion: 'Av. Principal 1' }
  const cliResBase = { tipoNcf: 'Consumidor Final',  itbis: false, activo: true, tipoCliente: 'Residencial', sector: 'Bella Vista', provincia: 'Distrito Nacional', telefonoPrincipal: '829-555-0000', email: 'default@acr.do', direccion: 'Calle 1 #1' }

  const [c01, c02, c03, c04, c05, c06, c07, c08, c09, c10] = await Promise.all([
    upsertCliente({ ...cliBase,    noCliente: 'CLI-0001', razonSocial: 'Distribuidora Don Pepe S.R.L.',  tipoEmpresa: 'SRL', rnc: '101234567', nombreContacto: 'Pedro',  apellidoContacto: 'Martínez', cargo: 'Gerente',    email: 'pepe@donpepe.do',        tipoNcf: 'Fiscal',           sector: 'Piantini',          provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0101', direccion: 'Av. Winston Churchill 123', latitud: '18.4790', longitud: '-69.9405' }),
    upsertCliente({ ...cliBase,    noCliente: 'CLI-0002', razonSocial: 'Tech Solutions RD S.A.S.',       tipoEmpresa: 'SAS', rnc: '101345678', nombreContacto: 'María',  apellidoContacto: 'Pérez',    cargo: 'CEO',        email: 'mperez@techrd.do',       tipoNcf: 'Fiscal',           sector: 'Zona Colonial',     provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0202', direccion: 'C/ El Conde 45',            latitud: '18.4749', longitud: '-69.8841' }),
    upsertCliente({ ...cliBase,    noCliente: 'CLI-0003', razonSocial: 'Constructora Rivera S.R.L.',     tipoEmpresa: 'SRL', rnc: '101456789', nombreContacto: 'Carlos', apellidoContacto: 'Rivera',   cargo: 'Director',   email: 'crivera@rivera.do',      tipoNcf: 'Fiscal',           sector: 'Gazcue',            provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0303', direccion: 'Av. Independencia 889',     latitud: '18.4769', longitud: '-69.9122' }),
    upsertCliente({ ...cliResBase, noCliente: 'CLI-0004', razonSocial: 'Ana González',                  tipoEmpresa: 'Persona Física',           nombreContacto: 'Ana',   apellidoContacto: 'González', cedula: '001-1234567-8', email: 'ana.gonzalez@gmail.com',   tipoNcf: 'Consumidor Final', sector: 'Bella Vista',       provincia: 'Distrito Nacional', telefonoPrincipal: '829-555-0404', direccion: 'C/ Las Flores 12 Apto 3',   latitud: '18.4680', longitud: '-69.9467' }),
    upsertCliente({ ...cliResBase, noCliente: 'CLI-0005', razonSocial: 'José Ramírez',                  tipoEmpresa: 'Persona Física',           nombreContacto: 'José',  apellidoContacto: 'Ramírez',  cedula: '001-9876543-2', email: 'jose.ramirez@hotmail.com', tipoNcf: 'Consumidor Final', sector: 'Los Pinos',         provincia: 'Santiago',          telefonoPrincipal: '849-555-0505', direccion: 'Calle 3 #45',               latitud: '19.4517', longitud: '-70.6970' }),
    upsertCliente({ ...cliBase,    noCliente: 'CLI-0006', razonSocial: 'Banco del Progreso S.A.',        tipoEmpresa: 'SA',  rnc: '101567890', nombreContacto: 'Rosa',   apellidoContacto: 'Tejeda',   cargo: 'IT Manager', email: 'rtejeda@bdp.do',         tipoNcf: 'Fiscal',           sector: 'Naco',              provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0606', direccion: 'Av. 27 de Febrero 123',     latitud: '18.4756', longitud: '-69.9355' }),
    upsertCliente({ ...cliBase,    noCliente: 'CLI-0007', razonSocial: 'Hotel Casa Colonial S.R.L.',     tipoEmpresa: 'SRL', rnc: '101678901', nombreContacto: 'Luis',   apellidoContacto: 'Gómez',    cargo: 'Gerente',    email: 'lgomez@casacolonial.do', tipoNcf: 'Fiscal',           sector: 'Zona Colonial',     provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0707', direccion: 'C/ Las Damas 5',            latitud: '18.4742', longitud: '-69.8835' }),
    upsertCliente({ ...cliResBase, noCliente: 'CLI-0008', razonSocial: 'Pedro Álvarez',                  tipoEmpresa: 'Persona Física',           nombreContacto: 'Pedro', apellidoContacto: 'Álvarez',  cedula: '002-1111111-1', email: 'palvarez@gmail.com',      tipoNcf: 'Consumidor Final', sector: 'Urbanización Real', provincia: 'Santiago',          telefonoPrincipal: '829-555-0808', direccion: 'Res. Los Álamos Blq 3 Apt 2A', latitud: '19.4480', longitud: '-70.7010' }),
    upsertCliente({ ...cliResBase, noCliente: 'CLI-0009', razonSocial: 'Laura Medina',                   tipoEmpresa: 'Persona Física',           nombreContacto: 'Laura', apellidoContacto: 'Medina',   cedula: '002-2222222-2', email: 'lmedina@yahoo.com',       tipoNcf: 'Consumidor Final', sector: 'Cristo Rey',        provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-0909', direccion: 'C/ El Número 88',           latitud: '18.4860', longitud: '-69.9600' }),
    upsertCliente({ ...cliBase,    noCliente: 'CLI-0010', razonSocial: 'Supermercados La Cadena S.A.',   tipoEmpresa: 'SA',  rnc: '101789012', nombreContacto: 'Marta',  apellidoContacto: 'Santos',   cargo: 'Compras',    email: 'msantos@lacadena.do',    tipoNcf: 'Fiscal',           sector: 'Ensanche La Fe',    provincia: 'Distrito Nacional', telefonoPrincipal: '809-555-1010', direccion: 'Av. San Martín 456',        latitud: '18.4886', longitud: '-69.9012' }),
  ])
  console.log('  ✓ Clientes (10) con geo coords')

  // Patch geo coords on existing clients (upsert update:{} skips on existing rows)
  await Promise.all([
    prisma.cliente.update({ where: { noCliente: 'CLI-0001' }, data: { latitud: '18.4790', longitud: '-69.9405' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0002' }, data: { latitud: '18.4749', longitud: '-69.8841' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0003' }, data: { latitud: '18.4769', longitud: '-69.9122' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0004' }, data: { latitud: '18.4680', longitud: '-69.9467' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0005' }, data: { latitud: '19.4517', longitud: '-70.6970' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0006' }, data: { latitud: '18.4756', longitud: '-69.9355' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0007' }, data: { latitud: '18.4742', longitud: '-69.8835' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0008' }, data: { latitud: '19.4480', longitud: '-70.7010' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0009' }, data: { latitud: '18.4860', longitud: '-69.9600' } }),
    prisma.cliente.update({ where: { noCliente: 'CLI-0010' }, data: { latitud: '18.4886', longitud: '-69.9012' } }),
  ])
  console.log('  ✓ Geo coords actualizados en clientes')

  // ─── 2. Empleados TEST (4) ────────────────────────────────────────────────
  const HASH = '$2b$10$j8xQgUJbBAcbRTswOErcxeDuB/6iNAGdwOyx8NWH8ccvLAtw6li0i' // Test2024!
  async function upsertEmpleado(data, rolId) {
    const emp = await prisma.empleado.upsert({
      where:  { email: data.email },
      update: {},
      create: { ...data, passwordHash: HASH },
    })
    const current = await prisma.empleado.findUnique({ where: { id: emp.id }, include: { roles: { select: { id: true } } } })
    if (!current.roles.some(r => r.id === rolId)) {
      await prisma.empleado.update({ where: { id: emp.id }, data: { roles: { connect: { id: rolId } } } })
    }
    return emp
  }

  const [empTec1, empTec2, empVend, empSup] = await Promise.all([
    upsertEmpleado({ nombre: '[SEED] Juan Torres',      cargo: 'Técnico WISP',       email: 'seed.jtorres@acr.test'    }, 12),
    upsertEmpleado({ nombre: '[SEED] María Estévez',    cargo: 'Técnica CCTV',       email: 'seed.mestevez@acr.test'   }, 12),
    upsertEmpleado({ nombre: '[SEED] Ricardo Núñez',    cargo: 'Vendedor NOC',       email: 'seed.rnunez@acr.test'     }, 11),
    upsertEmpleado({ nombre: '[SEED] Carmen Gutiérrez', cargo: 'Supervisora NOC',    email: 'seed.cgutierrez@acr.test' }, 13),
  ])
  console.log('  ✓ Empleados SEED (4) — password: Test2024!')

  // ─── 3. Productos (15 total) ──────────────────────────────────────────────
  const [p01, p02, p03, p04, p05, p06, p07, p08, p09, p10, p11, p12, p13, p14, p15] = await Promise.all([
    upsertProducto({ sku: 'NET-RTR-001', nombre: 'Router MikroTik hAP ac3',        precio: 8500,  stockActual: 12,  categoriaId: catRedes.id, tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'NET-SW-008',  nombre: 'Switch TP-Link 8 Puertos',       precio: 3200,  stockActual: 20,  categoriaId: catRedes.id, tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'NET-PC-002',  nombre: 'Patch Cord Cat6 2m',             precio: 180,   stockActual: 150, categoriaId: catRedes.id, tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'CAM-DOMO-01', nombre: 'Cámara Domo Hikvision 2MP',      precio: 4800,  stockActual: 8,   categoriaId: catCCTV.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'CAM-BALA-01', nombre: 'Cámara Bala Dahua 4MP',          precio: 5200,  stockActual: 6,   categoriaId: catCCTV.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'CAM-NVR-004', nombre: 'NVR Hikvision 4CH',              precio: 9500,  stockActual: 4,   categoriaId: catCCTV.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'NET-HDMI-50', nombre: 'Cable HDMI 50m',                 precio: 1100,  stockActual: 30,  categoriaId: catRedes.id, tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'COMP-LT-001', nombre: 'Laptop Lenovo ThinkPad L14',     precio: 68000, stockActual: 5,   categoriaId: catComp.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'COMP-LT-002', nombre: 'Laptop HP Pavilion 15',          precio: 52000, stockActual: 4,   categoriaId: catComp.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'WISP-ANT-001',nombre: 'Antena Ubiquiti NanoBeam 5AC',   precio: 12500, stockActual: 10,  categoriaId: catWisp.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'WISP-RAD-001',nombre: 'Radio MikroTik SXTsq5 ac',       precio: 9800,  stockActual: 8,   categoriaId: catWisp.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'FIB-ONU-001', nombre: 'ONU Fibra ZTE F660',             precio: 3500,  stockActual: 15,  categoriaId: catFibra.id, tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'NET-UTP-305', nombre: 'Cable UTP Cat6 305m (bobina)',    precio: 7200,  stockActual: 12,  categoriaId: catRedes.id, tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'CAM-DVR-008', nombre: 'DVR Dahua 8 Canales',            precio: 14500, stockActual: 7,   categoriaId: catCCTV.id,  tipoItem: TipoItem.ARTICULO }),
    upsertProducto({ sku: 'COMP-UPS-001',nombre: 'UPS APC Back-UPS 750VA',         precio: 6800,  stockActual: 9,   categoriaId: catComp.id,  tipoItem: TipoItem.ARTICULO }),
  ])
  console.log('  ✓ Productos (15)')

  // ─── 4. Movimientos Kardex (50+) ──────────────────────────────────────────
  const movCount = await prisma.movimientoInventario.count()
  if (movCount < 50) {
    const entradas = [
      { productoId: p01.id, cantidad: 10, fecha: dAgo(88) },
      { productoId: p02.id, cantidad: 25, fecha: dAgo(82) },
      { productoId: p03.id, cantidad: 200,fecha: dAgo(75) },
      { productoId: p04.id, cantidad: 12, fecha: dAgo(70) },
      { productoId: p05.id, cantidad: 10, fecha: dAgo(65) },
      { productoId: p06.id, cantidad: 6,  fecha: dAgo(60) },
      { productoId: p07.id, cantidad: 40, fecha: dAgo(55) },
      { productoId: p08.id, cantidad: 5,  fecha: dAgo(50) },
      { productoId: p09.id, cantidad: 6,  fecha: dAgo(45) },
      { productoId: p10.id, cantidad: 12, fecha: dAgo(40) },
      { productoId: p11.id, cantidad: 10, fecha: dAgo(35) },
      { productoId: p12.id, cantidad: 20, fecha: dAgo(30) },
      { productoId: p13.id, cantidad: 15, fecha: dAgo(25) },
      { productoId: p14.id, cantidad: 8,  fecha: dAgo(20) },
      { productoId: p15.id, cantidad: 10, fecha: dAgo(15) },
      // Second wave restock
      { productoId: p01.id, cantidad: 8,  fecha: dAgo(12) },
      { productoId: p04.id, cantidad: 10, fecha: dAgo(10) },
      { productoId: p05.id, cantidad: 8,  fecha: dAgo(9)  },
      { productoId: p06.id, cantidad: 4,  fecha: dAgo(8)  },
      { productoId: p10.id, cantidad: 6,  fecha: dAgo(7)  },
      { productoId: p11.id, cantidad: 5,  fecha: dAgo(6)  },
      { productoId: p12.id, cantidad: 10, fecha: dAgo(5)  },
      { productoId: p13.id, cantidad: 8,  fecha: dAgo(4)  },
      { productoId: p14.id, cantidad: 6,  fecha: dAgo(3)  },
      { productoId: p15.id, cantidad: 8,  fecha: dAgo(2)  },
    ]

    const salidas = [
      { productoId: p01.id, cantidad: 2, fecha: dAgo(85) },
      { productoId: p02.id, cantidad: 5, fecha: dAgo(78) },
      { productoId: p03.id, cantidad: 50,fecha: dAgo(72) },
      { productoId: p04.id, cantidad: 4, fecha: dAgo(68) },
      { productoId: p05.id, cantidad: 4, fecha: dAgo(62) },
      { productoId: p06.id, cantidad: 2, fecha: dAgo(58) },
      { productoId: p07.id, cantidad: 10,fecha: dAgo(52) },
      { productoId: p08.id, cantidad: 1, fecha: dAgo(47) },
      { productoId: p10.id, cantidad: 2, fecha: dAgo(38) },
      { productoId: p11.id, cantidad: 2, fecha: dAgo(32) },
      { productoId: p12.id, cantidad: 5, fecha: dAgo(28) },
      { productoId: p13.id, cantidad: 3, fecha: dAgo(22) },
      { productoId: p14.id, cantidad: 1, fecha: dAgo(18) },
      { productoId: p15.id, cantidad: 2, fecha: dAgo(12) },
      { productoId: p03.id, cantidad: 30,fecha: dAgo(8)  },
      // Recent salidas
      { productoId: p04.id, cantidad: 3, fecha: dAgo(6)  },
      { productoId: p10.id, cantidad: 2, fecha: dAgo(5)  },
      { productoId: p01.id, cantidad: 1, fecha: dAgo(4)  },
      { productoId: p12.id, cantidad: 4, fecha: dAgo(3)  },
      { productoId: p14.id, cantidad: 2, fecha: dAgo(2)  },
      { productoId: p05.id, cantidad: 2, fecha: dAgo(1)  },
      { productoId: p11.id, cantidad: 3, fecha: dAgo(1)  },
      { productoId: p13.id, cantidad: 2, fecha: dAgo(1)  },
      { productoId: p02.id, cantidad: 4, fecha: dAgo(0)  },
      { productoId: p15.id, cantidad: 1, fecha: dAgo(0)  },
    ]

    await prisma.movimientoInventario.createMany({
      data: [
        ...entradas.map(m => ({ ...m, tipo: TipoMovimiento.Entrada })),
        ...salidas.map(m  => ({ ...m, tipo: TipoMovimiento.Salida  })),
      ],
    })
    console.log('  ✓ Movimientos Kardex (50)')
  } else {
    console.log(`  ↷ Kardex ya tiene ${movCount} movimientos — saltando`)
  }

  // ─── 5. Planes (5 total) ──────────────────────────────────────────────────
  async function upsertPlan(nombre, tipo, mensual, instal) {
    const existing = await prisma.plan.findFirst({ where: { nombre } })
    if (existing) return existing
    return prisma.plan.create({ data: { nombre, tipo, precioMensualBase: mensual, precioInstalBase: instal } })
  }

  const [plan10, plan25, plan50, planCCTV, planMant] = await Promise.all([
    upsertPlan('Fibra 10 Mbps',         TipoServicio.WISP,           1500, 3000),
    upsertPlan('Fibra 25 Mbps',         TipoServicio.WISP,           2500, 3500),
    upsertPlan('Fibra 50 Mbps',         TipoServicio.WISP,           4000, 4500),
    upsertPlan('Pack CCTV 4 Cámaras',   TipoServicio.CCTV,              0, 28000),
    upsertPlan('Mantenimiento Mensual', TipoServicio.SoporteTecnico, 3500, 0),
  ])
  console.log('  ✓ Planes (5)')

  // ─── 6. ItemCatalogo (26 items) ─────────────────────────────────────────────
  async function upsertItem(nombre, tipo, categoria, precio, costo, tipoItem, stock) {
    const existing = await prisma.itemCatalogo.findFirst({ where: { nombre } })
    if (existing) return existing
    return prisma.itemCatalogo.create({ data: { nombre, tipo, categoria, precio, costo: costo ?? 0, tipoItem, stock: stock ?? null, activo: true } })
  }

  await Promise.all([
    // ── Servicios CCTV
    upsertItem('Instalación CCTV 4 Cámaras',     TipoFacturacion.VentaUnica, TipoServicio.CCTV,            8000,  4000, TipoItem.SERVICIO,  null),
    upsertItem('Instalación CCTV 8 Cámaras',     TipoFacturacion.VentaUnica, TipoServicio.CCTV,           15000,  8000, TipoItem.SERVICIO,  null),
    upsertItem('Instalación CCTV 16 Cámaras',    TipoFacturacion.VentaUnica, TipoServicio.CCTV,           28000, 14000, TipoItem.SERVICIO,  null),
    upsertItem('Diagnóstico Sistema CCTV',        TipoFacturacion.Servicio,   TipoServicio.CCTV,            1500,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Config NVR / DVR',                TipoFacturacion.Servicio,   TipoServicio.CCTV,            2000,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Monitoreo Remoto 24/7',           TipoFacturacion.Recurrente, TipoServicio.CCTV,            4500,  0,    TipoItem.SERVICIO,  null),
    // ── Taller / Reparaciones
    upsertItem('Diagnóstico Equipo PC / Laptop',  TipoFacturacion.Servicio,   TipoServicio.SoporteTecnico,   600,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Reparación Motherboard',          TipoFacturacion.Servicio,   TipoServicio.SoporteTecnico,  3500,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Limpieza y Mantenimiento PC',     TipoFacturacion.Servicio,   TipoServicio.SoporteTecnico,  1200,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Instalación OS / Software',       TipoFacturacion.Servicio,   TipoServicio.SoporteTecnico,  1500,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Recuperación de Datos',           TipoFacturacion.Servicio,   TipoServicio.SoporteTecnico,  4500,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Soporte Remoto / Hora',           TipoFacturacion.Servicio,   TipoServicio.SoporteTecnico,  1200,  0,    TipoItem.SERVICIO,  null),
    // ── Redes e Infraestructura
    upsertItem('Instalación Cableado Estructurado',TipoFacturacion.VentaUnica,TipoServicio.Redes,          12000,  5000, TipoItem.SERVICIO,  null),
    upsertItem('Certificación Cableado',          TipoFacturacion.Servicio,   TipoServicio.Redes,           4500,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Configuración Router / Switch',   TipoFacturacion.Servicio,   TipoServicio.Redes,           2000,  0,    TipoItem.SERVICIO,  null),
    upsertItem('Rack 12U + Organización',         TipoFacturacion.VentaUnica, TipoServicio.Redes,           9500,  5000, TipoItem.SERVICIO,  null),
    // ── Seguridad / Cerco
    upsertItem('Cerco Eléctrico Básico',          TipoFacturacion.VentaUnica, TipoServicio.CercoElectrico, 18000,  9000, TipoItem.SERVICIO,  null),
    upsertItem('Cerco Eléctrico Avanzado',        TipoFacturacion.VentaUnica, TipoServicio.CercoElectrico, 32000, 15000, TipoItem.SERVICIO,  null),
    upsertItem('Mantenimiento Preventivo CCTV',   TipoFacturacion.Recurrente, TipoServicio.CCTV,            3500,  0,    TipoItem.SERVICIO,  null),
    // ── Repuestos / Hardware (PRODUCTO)
    upsertItem('Disco Duro HDD 1TB',              TipoFacturacion.VentaUnica, TipoServicio.SoporteTecnico,  3800,  2200, TipoItem.PRODUCTO,  15),
    upsertItem('SSD 480GB SATA',                  TipoFacturacion.VentaUnica, TipoServicio.SoporteTecnico,  4500,  2800, TipoItem.PRODUCTO,  10),
    upsertItem('Fuente Alimentación ATX 600W',    TipoFacturacion.VentaUnica, TipoServicio.SoporteTecnico,  2800,  1600, TipoItem.PRODUCTO,  8),
    upsertItem('Memoria RAM 8GB DDR4',            TipoFacturacion.VentaUnica, TipoServicio.SoporteTecnico,  3200,  1900, TipoItem.PRODUCTO,  12),
    upsertItem('Balun BNC Pasivo (par)',          TipoFacturacion.VentaUnica, TipoServicio.CCTV,             380,   180, TipoItem.PRODUCTO,  50),
    upsertItem('Cable Coaxial RG59 (metro)',       TipoFacturacion.VentaUnica, TipoServicio.CCTV,              45,    20, TipoItem.PRODUCTO,  500),
    upsertItem('Conector BNC Macho (×10)',        TipoFacturacion.VentaUnica, TipoServicio.CCTV,             250,   100, TipoItem.PRODUCTO,  200),
  ])
  console.log('  ✓ ItemCatalogo (26)')

  // ─── 7. NCF config ────────────────────────────────────────────────────────
  await prisma.configuracionNCF.deleteMany({ where: { tipoNcf: 'Crédito Fiscal' } })
  await prisma.configuracionNCF.upsert({ where: { tipoNcf: 'Fiscal'          }, update: {}, create: { prefijo: 'B01', tipoNcf: 'Fiscal',          tipoDescripcion: 'Crédito Fiscal',   secuenciaActual: 0, limite: 9999999, activo: true } })
  await prisma.configuracionNCF.upsert({ where: { tipoNcf: 'Consumidor Final' }, update: {}, create: { prefijo: 'B02', tipoNcf: 'Consumidor Final', tipoDescripcion: 'Consumidor Final', secuenciaActual: 0, limite: 9999999, activo: true } })
  await prisma.configuracionNCF.upsert({ where: { tipoNcf: 'Gubernamental'    }, update: {}, create: { prefijo: 'B14', tipoNcf: 'Gubernamental',    tipoDescripcion: 'Gubernamental',    secuenciaActual: 0, limite: 9999999, activo: true } })

  const ncfFiscal = await prisma.configuracionNCF.findFirst({ where: { tipoNcf: 'Fiscal' } })
  const ncfCF     = await prisma.configuracionNCF.findFirst({ where: { tipoNcf: 'Consumidor Final' } })
  let seqFiscal = ncfFiscal.secuenciaActual
  let seqCF     = ncfCF.secuenciaActual
  console.log('  ✓ NCF config')

  // ─── 8. Servicios activos (8) ─────────────────────────────────────────────
  const svCount = await prisma.servicio.count()
  let svos = []
  if (svCount < 8) {
    const svData = [
      { noServicio: 'SV-0001', clienteId: c01.id, planId: plan10.id,   estado: EstadoServicio.Activo,  precioMensual: 1500, precioInstalacion: 3000,  notasTecnicas: 'WISP residencial — instalado en azotea.' },
      { noServicio: 'SV-0002', clienteId: c02.id, planId: plan50.id,   estado: EstadoServicio.Activo,  precioMensual: 4000, precioInstalacion: 4500,  notasTecnicas: 'WISP corporativo — backbone principal.' },
      { noServicio: 'SV-0003', clienteId: c03.id, planId: planCCTV.id, estado: EstadoServicio.Activo,  precioMensual: 0,    precioInstalacion: 28000, notasTecnicas: 'CCTV 4 cámaras IP + NVR.' },
      { noServicio: 'SV-0004', clienteId: c04.id, planId: plan10.id,   estado: EstadoServicio.Activo,  precioMensual: 1500, precioInstalacion: 3000,  notasTecnicas: 'WISP residencial Bella Vista.' },
      { noServicio: 'SV-0005', clienteId: c06.id, planId: planCCTV.id, estado: EstadoServicio.Activo,  precioMensual: 3500, precioInstalacion: 55000, notasTecnicas: 'CCTV sucursales + monitoreo remoto.' },
      { noServicio: 'SV-0006', clienteId: c07.id, planId: planCCTV.id, estado: EstadoServicio.Activo,  precioMensual: 3500, precioInstalacion: 42000, notasTecnicas: 'CCTV hotel — lobby, pasillos y piscina.' },
      { noServicio: 'SV-0007', clienteId: c01.id, planId: planMant.id, estado: EstadoServicio.Activo,  precioMensual: 3500, precioInstalacion: 0,     notasTecnicas: 'Mantenimiento preventivo mensual.' },
      { noServicio: 'SV-0008', clienteId: c10.id, planId: plan25.id,   estado: EstadoServicio.Activo,  precioMensual: 2500, precioInstalacion: 3500,  notasTecnicas: 'WISP supermercado — múltiples puntos AP.' },
    ]
    for (const sv of svData) {
      const existing = await prisma.servicio.findFirst({ where: { noServicio: sv.noServicio } })
      if (!existing) svos.push(await prisma.servicio.create({ data: sv }))
      else svos.push(existing)
    }
    console.log(`  ✓ Servicios (${svos.length})`)
  } else {
    svos = await prisma.servicio.findMany({ take: 8 })
    console.log(`  ↷ Servicios ya existen (${svCount}) — saltando`)
  }

  // ─── 9. Órdenes de Trabajo (13 total) ────────────────────────────────────
  const otCount = await prisma.ordenTrabajo.count()
  let ots = []
  if (otCount < 13) {
    const otData = [
      { noOT: 'OT-0001', clienteId: c01.id, tecnicoId: empTec1.id, tipoOT: 'ISP',    estado: 'Completada', latitud: '18.4792', longitud: '-69.9398', notasTecnicas: 'Instalación WISP 10MB — antena + ONU + router.',    lineas: [{ descripcion: 'Antena Ubiquiti NanoBeam', cantidad: 1, precioUnitario: 12500, productoId: p10.id }, { descripcion: 'ONU Fibra ZTE F660', cantidad: 1, precioUnitario: 3500, productoId: p12.id }] },
      { noOT: 'OT-0002', clienteId: c02.id, tecnicoId: empTec1.id, tipoOT: 'ISP',    estado: 'Completada', latitud: '18.4751', longitud: '-69.8840', notasTecnicas: 'Instalación WISP 50MB — backbone empresarial.',       lineas: [{ descripcion: 'Radio MikroTik SXTsq5', cantidad: 2, precioUnitario: 9800, productoId: p11.id }, { descripcion: 'Router MikroTik hAP ac3', cantidad: 1, precioUnitario: 8500, productoId: p01.id }] },
      { noOT: 'OT-0003', clienteId: c03.id, tecnicoId: empTec2.id, tipoOT: 'CCTV',   estado: 'Completada', latitud: '18.4771', longitud: '-69.9120', notasTecnicas: 'Instalación 4 cámaras IP + NVR.',                     lineas: [{ descripcion: 'Cámara Domo Hikvision', cantidad: 4, precioUnitario: 4800, productoId: p04.id }, { descripcion: 'NVR Hikvision 4CH', cantidad: 1, precioUnitario: 9500, productoId: p06.id }] },
      { noOT: 'OT-0004', clienteId: c06.id, tecnicoId: empTec2.id, tipoOT: 'CCTV',   estado: 'Completada', latitud: '18.4758', longitud: '-69.9357', notasTecnicas: 'Sistema CCTV banco — 8 cámaras domo IP.',              lineas: [{ descripcion: 'Cámara Domo Hikvision', cantidad: 8, precioUnitario: 4800, productoId: p04.id }, { descripcion: 'DVR Dahua 8CH', cantidad: 1, precioUnitario: 14500, productoId: p14.id }] },
      { noOT: 'OT-0005', clienteId: c07.id, tecnicoId: empTec2.id, tipoOT: 'CCTV',   estado: 'EnProceso',  latitud: '18.4744', longitud: '-69.8837', notasTecnicas: 'Hotel — 12 cámaras exteriores. Pendiente cableado.',   lineas: [{ descripcion: 'Cámara Bala Dahua 4MP', cantidad: 6, precioUnitario: 5200, productoId: p05.id }, { descripcion: 'DVR Dahua 8CH', cantidad: 1, precioUnitario: 14500, productoId: p14.id }] },
      { noOT: 'OT-0006', clienteId: c04.id, tecnicoId: empTec1.id, tipoOT: 'ISP',    estado: 'Completada', latitud: '18.4682', longitud: '-69.9465', notasTecnicas: 'Residencial Bella Vista — WISP 10MB.',                 lineas: [{ descripcion: 'ONU Fibra ZTE F660', cantidad: 1, precioUnitario: 3500, productoId: p12.id }] },
      { noOT: 'OT-0007', clienteId: c08.id, tecnicoId: empTec1.id, tipoOT: 'ISP',    estado: 'Pendiente',  latitud: '19.4481', longitud: '-70.7012', notasTecnicas: 'Nueva instalación — coordinar acceso al techo.',       lineas: [{ descripcion: 'Antena Ubiquiti NanoBeam', cantidad: 1, precioUnitario: 12500, productoId: p10.id }] },
      { noOT: 'OT-0008', clienteId: c10.id, tecnicoId: empTec1.id, tipoOT: 'ISP',    estado: 'Pendiente',  latitud: '18.4888', longitud: '-69.9010', notasTecnicas: 'Supermercado — 3 APs + switch central.',               lineas: [{ descripcion: 'Switch TP-Link 8P', cantidad: 2, precioUnitario: 3200, productoId: p02.id }, { descripcion: 'Router MikroTik hAP ac3', cantidad: 1, precioUnitario: 8500, productoId: p01.id }] },
      { noOT: 'OT-0009', clienteId: c05.id, tecnicoId: empTec1.id, tipoOT: 'ISP',    estado: 'Completada', latitud: '19.4520', longitud: '-70.6968', notasTecnicas: 'WISP Santiago 25MB — instalación en vivienda.',        lineas: [{ descripcion: 'ONU Fibra ZTE F660', cantidad: 1, precioUnitario: 3500, productoId: p12.id }, { descripcion: 'Router MikroTik hAP ac3', cantidad: 1, precioUnitario: 8500, productoId: p01.id }] },
      { noOT: 'OT-0010', clienteId: c09.id, tecnicoId: empTec2.id, tipoOT: 'CCTV',   estado: 'Completada', latitud: '18.4862', longitud: '-69.9598', notasTecnicas: 'CCTV residencial — 2 cámaras exteriores + DVR.',       lineas: [{ descripcion: 'Cámara Bala Dahua 4MP', cantidad: 2, precioUnitario: 5200, productoId: p05.id }, { descripcion: 'NVR Hikvision 4CH', cantidad: 1, precioUnitario: 9500, productoId: p06.id }] },
      { noOT: 'OT-0011', clienteId: c02.id, tecnicoId: empTec1.id, tipoOT: 'General', estado: 'EnProceso',  latitud: '18.4752', longitud: '-69.8843', notasTecnicas: 'Upgrading WISP 50MB → 100MB. Cambio de radio.',        lineas: [{ descripcion: 'Radio MikroTik SXTsq5', cantidad: 1, precioUnitario: 9800, productoId: p11.id }] },
      { noOT: 'OT-0012', clienteId: c06.id, tecnicoId: empTec2.id, tipoOT: 'CCTV',   estado: 'Pendiente',  latitud: '18.4760', longitud: '-69.9350', notasTecnicas: 'Expansión CCTV banco — 4 cámaras adicionales.',        lineas: [{ descripcion: 'Cámara Domo Hikvision', cantidad: 4, precioUnitario: 4800, productoId: p04.id }] },
      { noOT: 'OT-0013', clienteId: c03.id, tecnicoId: empTec1.id, tipoOT: 'General', estado: 'Pendiente',  latitud: '18.4768', longitud: '-69.9125', notasTecnicas: 'Cableado estructurado — 20 puntos red Cat6.',          lineas: [{ descripcion: 'Cable UTP Cat6 305m', cantidad: 2, precioUnitario: 7200, productoId: p13.id }, { descripcion: 'Patch Cord Cat6 2m', cantidad: 20, precioUnitario: 180, productoId: p03.id }] },
    ]
    for (const ot of otData) {
      const { lineas, ...otRest } = ot
      const existing = await prisma.ordenTrabajo.findFirst({ where: { noOT: otRest.noOT } })
      if (!existing) {
        const created = await prisma.ordenTrabajo.create({ data: { ...otRest, lineas: { create: lineas } } })
        ots.push(created)
      } else ots.push(existing)
    }
    console.log(`  ✓ OTs (${ots.length})`)
  } else {
    ots = await prisma.ordenTrabajo.findMany({ take: 13, where: { deletedAt: null }, orderBy: { createdAt: 'asc' } })
    console.log(`  ↷ OTs ya existen (${otCount}) — saltando`)
  }

  // ─── 10. Facturas históricas + Cotizaciones ───────────────────────────────
  const factCount = await prisma.factura.count({ where: { esCotizacion: false } })
  const cotCount  = await prisma.factura.count({ where: { esCotizacion: true  } })

  if (factCount < 15) {
    const nextFiscal = () => { seqFiscal++; return { ncf: `B01${pad(seqFiscal)}`, noFactura: `FAC2026${pad(seqFiscal)}` } }
    const nextCF     = () => { seqCF++;     return { ncf: `B02${pad(seqCF)}`,     noFactura: `FAC2026CF${pad(seqCF)}`   } }

    const facturas = [
      { ...nextFiscal(), clienteId: c01.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Fiscal',           itbis: true,  sub: 16000, fechaEmision: dAgo(180), fechaPago: dAgo(175), lineas: [{ descripcion: 'Instalación LAN 8 puntos',         cantidad: 1, precioUnitario: 16000 }] },
      { ...nextCF(),     clienteId: c04.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Consumidor Final', itbis: false, sub: 1500,  fechaEmision: dAgo(175), fechaPago: dAgo(174), lineas: [{ descripcion: 'Plan Fibra 10 Mbps',               cantidad: 1, precioUnitario: 1500  }] },
      { ...nextFiscal(), clienteId: c02.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Fiscal',           itbis: true,  sub: 28100, fechaEmision: dAgo(150), fechaPago: dAgo(145), lineas: [{ descripcion: 'Radio MikroTik SXTsq5 ×2 + Router',  cantidad: 1, precioUnitario: 28100 }] },
      { ...nextCF(),     clienteId: c05.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Consumidor Final', itbis: false, sub: 2400,  fechaEmision: dAgo(148), fechaPago: dAgo(147), lineas: [{ descripcion: 'Soporte Técnico 2h',               cantidad: 2, precioUnitario: 1200  }] },
      { ...nextFiscal(), clienteId: c06.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Fiscal',           itbis: true,  sub: 38400, fechaEmision: dAgo(120), fechaPago: dAgo(115), lineas: [{ descripcion: 'CCTV 8 Cámaras + DVR',            cantidad: 1, precioUnitario: 38400 }] },
      { ...nextCF(),     clienteId: c08.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Consumidor Final', itbis: false, sub: 3500,  fechaEmision: dAgo(118), fechaPago: dAgo(117), lineas: [{ descripcion: 'Instalación WISP',                 cantidad: 1, precioUnitario: 3500  }] },
      { ...nextFiscal(), clienteId: c10.id, estado: EstadoFactura.Pagada,  tipoNcf: 'Fiscal',           itbis: true,  sub: 22000, fechaEmision: dAgo(90),  fechaPago: dAgo(85),  lineas: [{ descripcion: 'Instalación WISP Multi-AP',       cantidad: 1, precioUnitario: 22000 }] },
      { ...nextCF(),     clienteId: c09.id, estado: EstadoFactura.Vencida, tipoNcf: 'Consumidor Final', itbis: false, sub: 1500,  fechaEmision: dAgo(88),  fechaPago: null,       lineas: [{ descripcion: 'Plan Fibra 10 Mbps',              cantidad: 1, precioUnitario: 1500  }] },
      { ...nextFiscal(), clienteId: c07.id, estado: EstadoFactura.Emitida, tipoNcf: 'Fiscal',           itbis: true,  sub: 32000, fechaEmision: dAgo(45),  fechaPago: null,       lineas: [{ descripcion: 'CCTV Hotel fase 1',               cantidad: 1, precioUnitario: 32000 }] },
      { ...nextCF(),     clienteId: c03.id, estado: EstadoFactura.Emitida, tipoNcf: 'Consumidor Final', itbis: false, sub: 28000, fechaEmision: dAgo(20),  fechaPago: null,       lineas: [{ descripcion: 'Instalación CCTV 4CH completa',   cantidad: 1, precioUnitario: 28000 }] },
      // Additional: more Vencidas + Emitidas
      { ...nextFiscal(), clienteId: c01.id, estado: EstadoFactura.Vencida, tipoNcf: 'Fiscal',           itbis: true,  sub: 7000,  fechaEmision: dAgo(75),  fechaPago: null,       lineas: [{ descripcion: 'Mantenimiento preventivo Q1',     cantidad: 2, precioUnitario: 3500  }] },
      { ...nextCF(),     clienteId: c05.id, estado: EstadoFactura.Vencida, tipoNcf: 'Consumidor Final', itbis: false, sub: 1500,  fechaEmision: dAgo(70),  fechaPago: null,       lineas: [{ descripcion: 'Plan Fibra 10 Mbps',              cantidad: 1, precioUnitario: 1500  }] },
      { ...nextFiscal(), clienteId: c03.id, estado: EstadoFactura.Vencida, tipoNcf: 'Fiscal',           itbis: true,  sub: 3500,  fechaEmision: dAgo(65),  fechaPago: null,       lineas: [{ descripcion: 'Soporte Técnico 3h',              cantidad: 3, precioUnitario: 1200  }] },
      { ...nextFiscal(), clienteId: c06.id, estado: EstadoFactura.Emitida, tipoNcf: 'Fiscal',           itbis: true,  sub: 4500,  fechaEmision: dAgo(15),  fechaPago: null,       lineas: [{ descripcion: 'Mantenimiento preventivo mensual', cantidad: 1, precioUnitario: 4500  }] },
      { ...nextCF(),     clienteId: c04.id, estado: EstadoFactura.Emitida, tipoNcf: 'Consumidor Final', itbis: false, sub: 1500,  fechaEmision: dAgo(10),  fechaPago: null,       lineas: [{ descripcion: 'Plan Fibra 10 Mbps',              cantidad: 1, precioUnitario: 1500  }] },
    ]

    for (const f of facturas) {
      const { lineas, itbis: hasItbis, sub, ...fRest } = f
      const itbisAmt = hasItbis ? Math.round(sub * 0.18 * 100) / 100 : 0
      const existing = await prisma.factura.findFirst({ where: { noFactura: fRest.noFactura } })
      if (!existing) {
        await prisma.factura.create({
          data: {
            ...fRest,
            subtotal: sub,
            itbis:    itbisAmt,
            total:    Math.round((sub + itbisAmt) * 100) / 100,
            fechaVence: new Date(fRest.fechaEmision.getTime() + 30 * 86_400_000),
            lineas: { createMany: { data: lineas.map(l => ({ ...l, productoId: null, descuentoPorcentaje: 0, descuentoMonto: 0 })) } },
          },
        })
      }
    }

    await prisma.configuracionNCF.update({ where: { tipoNcf: 'Fiscal'          }, data: { secuenciaActual: seqFiscal } })
    await prisma.configuracionNCF.update({ where: { tipoNcf: 'Consumidor Final' }, data: { secuenciaActual: seqCF    } })
    console.log('  ✓ Facturas históricas (15) — Pagada/Emitida/Vencida')
  } else {
    console.log(`  ↷ Facturas ya existen (${factCount}) — saltando`)
  }

  if (cotCount < 10) {
    const cotSeqStart = (await prisma.configuracionNCF.findFirst({ where: { tipoNcf: 'COT' } }))?.secuenciaActual ?? 1
    let cotSeq = cotSeqStart

    const cots = [
      { clienteId: c02.id, sub: 28000, itbis: true,  lineas: [{ descripcion: 'Instalación CCTV 8 Cámaras + mano obra', cantidad: 1, precioUnitario: 15000 }, { descripcion: 'Disco Duro NVR 2TB', cantidad: 1, precioUnitario: 5000 }, { descripcion: 'Cable Coaxial RG59 + conectores', cantidad: 1, precioUnitario: 8000 }], fechaEmision: dAgo(30) },
      { clienteId: c06.id, sub: 67000, itbis: true,  lineas: [{ descripcion: 'Sistema CCTV 16 cámaras HD + NVR', cantidad: 1, precioUnitario: 67000 }], fechaEmision: dAgo(25) },
      { clienteId: c07.id, sub: 42000, itbis: true,  lineas: [{ descripcion: 'CCTV Hotel fase 2 (8 cámaras PTZ)', cantidad: 1, precioUnitario: 42000 }], fechaEmision: dAgo(18) },
      { clienteId: c10.id, sub: 36500, itbis: true,  lineas: [{ descripcion: 'Infraestructura red LAN + certificación', cantidad: 1, precioUnitario: 36500 }], fechaEmision: dAgo(10) },
      { clienteId: c04.id, sub: 8500,  itbis: true,  lineas: [{ descripcion: 'Reparación Motherboard + reemplazo capacitores', cantidad: 1, precioUnitario: 3500 }, { descripcion: 'Memoria RAM 8GB DDR4', cantidad: 1, precioUnitario: 3200 }, { descripcion: 'Instalación OS + drivers', cantidad: 1, precioUnitario: 1800 }], fechaEmision: dAgo(5) },
      { clienteId: c01.id, sub: 18000, itbis: true,  lineas: [{ descripcion: 'Cerco Eléctrico Básico 6 metros', cantidad: 1, precioUnitario: 18000 }], fechaEmision: dAgo(22) },
      { clienteId: c03.id, sub: 9500,  itbis: true,  lineas: [{ descripcion: 'Rack 12U + patch panel + organización', cantidad: 1, precioUnitario: 9500 }], fechaEmision: dAgo(15) },
      { clienteId: c05.id, sub: 5400,  itbis: true,  lineas: [{ descripcion: 'Recuperación de datos HDD dañado', cantidad: 1, precioUnitario: 4500 }, { descripcion: 'Diagnóstico equipo PC', cantidad: 1, precioUnitario: 600 }, { descripcion: 'Informe técnico', cantidad: 1, precioUnitario: 300 }], fechaEmision: dAgo(8) },
      { clienteId: c08.id, sub: 12000, itbis: true,  lineas: [{ descripcion: 'Instalación cableado estructurado 20 puntos', cantidad: 1, precioUnitario: 12000 }], fechaEmision: dAgo(12) },
      { clienteId: c09.id, sub: 3500,  itbis: false, lineas: [{ descripcion: 'Mantenimiento preventivo CCTV trimestral', cantidad: 1, precioUnitario: 3500 }], fechaEmision: dAgo(3) },
    ]

    for (const c of cots) {
      cotSeq++
      const noFactura = `COT-${String(cotSeq).padStart(4, '0')}`
      const existing = await prisma.factura.findFirst({ where: { noFactura } })
      if (!existing) {
        const itbisAmt = c.itbis ? Math.round(c.sub * 0.18 * 100) / 100 : 0
        await prisma.factura.create({
          data: {
            noFactura, clienteId: c.clienteId, estado: EstadoFactura.Borrador,
            subtotal: c.sub, itbis: itbisAmt, total: Math.round((c.sub + itbisAmt) * 100) / 100,
            esCotizacion: true, fechaEmision: c.fechaEmision,
            fechaVence: new Date(c.fechaEmision.getTime() + 30 * 86_400_000),
            notas: `Cotización POS — ${c.lineas.length} línea(s)`,
            lineas: { createMany: { data: c.lineas.map(l => ({ ...l, productoId: null, descuentoPorcentaje: 0, descuentoMonto: 0 })) } },
          },
        })
      }
    }
    await prisma.$executeRaw`UPDATE "ConfiguracionNCF" SET "secuenciaActual" = ${cotSeq} WHERE "tipoNcf" = 'COT'`
    console.log('  ✓ Cotizaciones (10)')
  } else {
    console.log(`  ↷ Cotizaciones ya existen (${cotCount}) — saltando`)
  }

  // ─── 11. Suplidores (5) ───────────────────────────────────────────────────
  const supCount = await prisma.suplidor.count()
  if (supCount < 5) {
    const supData = [
      { noSuplidor: 'SUP-0001', razonSocial: 'Securit Solutions DR S.R.L.',    nombreComercial: 'SecuritDR',   rnc: '131111111', direccion: 'C/ 27 de Febrero 88',       sector: 'Zona Industrial',  provincia: 'Distrito Nacional', latitud: '18.4850', longitud: '-69.9200', nombreContacto: 'Patricia Lora',    cargo: 'Directora',      telefonoPrincipal: '809-555-2001', email: 'plora@securitdr.do',    actividad: 'Importadora de cámaras CCTV, DVR/NVR y accesorios de seguridad', limiteCredito: 250000, diasCredito: 45, activo: true },
      { noSuplidor: 'SUP-0002', razonSocial: 'Compuworld SRL',                  nombreComercial: 'Compuworld',  rnc: '131222222', direccion: 'Av. Máximo Gómez 12',       sector: 'Cristo Rey',       provincia: 'Distrito Nacional', latitud: '18.4865', longitud: '-69.9605', nombreContacto: 'Sandra Méndez',    cargo: 'Compradora',     telefonoPrincipal: '809-555-2002', email: 'smendez@compuworld.do',  actividad: 'Repuestos PC, discos duros, memorias, fuentes de poder y laptops', limiteCredito: 180000, diasCredito: 30, activo: true },
      { noSuplidor: 'SUP-0003', razonSocial: 'Cable & Access RD S.A.S.',        nombreComercial: 'CableAccess', rnc: '131333333', direccion: 'Av. Tiradentes 150',        sector: 'Naco',             provincia: 'Distrito Nacional', latitud: '18.4760', longitud: '-69.9350', nombreContacto: 'Héctor Abreu',     cargo: 'Gerente Ventas', telefonoPrincipal: '809-555-2003', email: 'habreu@cableaccess.do',  actividad: 'Cable coaxial, baluns, conectores BNC y materiales de instalación', limiteCredito: 120000, diasCredito: 30, activo: true },
      { noSuplidor: 'SUP-0004', razonSocial: 'Tech Redes y Seguridad S.R.L.',   nombreComercial: 'TechRedes',   rnc: '131444444', direccion: 'Av. John F. Kennedy 245',    sector: 'Los Prados',       provincia: 'Distrito Nacional', latitud: '18.4950', longitud: '-69.9150', nombreContacto: 'Manuel Castillo',  cargo: 'Jefe Técnico',   telefonoPrincipal: '809-555-2004', email: 'mcastillo@techredes.do', actividad: 'Equipos de redes, switches, access points y herramientas eléctricas', limiteCredito: 150000, diasCredito: 30, activo: true },
      { noSuplidor: 'SUP-0005', razonSocial: 'Impactec Norte S.R.L.',           nombreComercial: 'ImpactecN',   rnc: '231111111', direccion: 'Calle del Sol 112',         sector: 'Centro',           provincia: 'Santiago',          latitud: '19.4520', longitud: '-70.6975', nombreContacto: 'Ramón Gutiérrez',  cargo: 'Gerente',        telefonoPrincipal: '809-555-2005', email: 'rgutierrez@impactec.do', actividad: 'Distribuidor regional de repuestos electrónicos y cámaras CCTV',   limiteCredito: 100000, diasCredito: 30, activo: true },
    ]
    for (const s of supData) {
      const existing = await prisma.suplidor.findFirst({ where: { noSuplidor: s.noSuplidor } })
      if (!existing) await prisma.suplidor.create({ data: s })
    }
    console.log('  ✓ Suplidores (5)')
  } else {
    console.log(`  ↷ Suplidores ya existen (${supCount}) — saltando`)
  }

  // ─── 12. Prospectos (5) ───────────────────────────────────────────────────
  const proCount = await prisma.prospecto.count()
  if (proCount < 5) {
    const proData = [
      { nombre: 'Clínica Bella Vista',     telefono: '809-444-0202', servicioInteresado: 'CCTV 16 Cámaras',          origen: 'Referido',  estado: 'Negociación', latitud: '18.4678', longitud: '-69.9460', notas: 'CCTV para salas de espera, quirófanos y parqueo. Presupuesto aprobado ~$65K.' },
      { nombre: 'Rafael Herrera',          telefono: '829-444-0101', servicioInteresado: 'Reparación Laptop',         origen: 'WhatsApp',  estado: 'Interesado',  latitud: '18.4788', longitud: '-69.9400', notas: 'Laptop no enciende luego de caída. Trae equipo esta semana.' },
      { nombre: 'Luis Victorino',          telefono: '849-444-0404', servicioInteresado: 'Cerco Eléctrico + CCTV',   origen: 'Instagram', estado: 'Contactado',  latitud: '18.4755', longitud: '-69.9358', notas: 'Villa en Naco. Quiere cerco eléctrico perimetral y CCTV 8 cámaras.' },
      { nombre: 'Colmado La Altagracia',   telefono: '809-444-0303', servicioInteresado: 'CCTV 4 Cámaras',           origen: 'Facebook',  estado: 'Nuevo',       latitud: '18.4752', longitud: '-69.8843', notas: 'Local pequeño en Zona Colonial. Busca sistema económico interior/exterior.' },
      { nombre: 'Escuela San Judas',       telefono: '809-444-0505', servicioInteresado: 'CCTV + Redes LAN',         origen: 'WhatsApp',  estado: 'Perdido',     latitud: '19.4515', longitud: '-70.6965', notas: 'Proyecto Santiago. Presupuesto insuficiente en esta ronda.' },
    ]
    for (const p of proData) {
      await prisma.prospecto.create({ data: p })
    }
    console.log('  ✓ Prospectos (5)')
  } else {
    console.log(`  ↷ Prospectos ya existen (${proCount}) — saltando`)
  }

  // ─── 13. Asistencia — 7 días historial ───────────────────────────────────
  const asisCount = await prisma.asistencia.count()
  if (asisCount < 40) {
    const emps = [empTec1, empTec2, empVend, empSup]
    const records = []

    for (let d = 7; d >= 1; d--) {
      const base = dAgo(d)
      const dateOnly = new Date(base.getFullYear(), base.getMonth(), base.getDate())

      for (const emp of emps) {
        // Skip random days for realistic attendance (10% absence rate)
        if (Math.random() < 0.1) continue

        const entradaH = 7 + Math.floor(Math.random() * 2)   // 7 or 8 AM
        const entradaM = Math.floor(Math.random() * 60)
        const salidaH  = 16 + Math.floor(Math.random() * 3)  // 16-18
        const salidaM  = Math.floor(Math.random() * 60)

        const entrada = new Date(dateOnly)
        entrada.setHours(entradaH, entradaM, 0, 0)

        const salida = new Date(dateOnly)
        salida.setHours(salidaH, salidaM, 0, 0)

        records.push({ empleadoId: emp.id, tipo: TipoAsistencia.Entrada, fechaHora: entrada })
        records.push({ empleadoId: emp.id, tipo: TipoAsistencia.Salida,  fechaHora: salida  })
      }
    }

    if (records.length > 0) {
      // Reset sequence to avoid ID conflicts when re-running after partial inserts
      await prisma.$executeRaw`SELECT setval(pg_get_serial_sequence('"Asistencia"', 'id'), COALESCE((SELECT MAX(id) FROM "Asistencia"), 0) + 1, false)`
      await prisma.asistencia.createMany({ data: records, skipDuplicates: true })
    }
    console.log(`  ✓ Asistencia 7 días (${records.length} registros, ${emps.length} empleados)`)
  } else {
    console.log(`  ↷ Asistencia ya tiene ${asisCount} registros — saltando`)
  }

  // ─── Final summary ────────────────────────────────────────────────────────
  const [fClientes, fProds, fItems, fFacts, fCots, fOTs, fSvcs, fMovs, fEmps, fSups, fPros, fAsis] = await Promise.all([
    prisma.cliente.count(),
    prisma.producto.count(),
    prisma.itemCatalogo.count(),
    prisma.factura.count({ where: { esCotizacion: false } }),
    prisma.factura.count({ where: { esCotizacion: true  } }),
    prisma.ordenTrabajo.count({ where: { deletedAt: null } }),
    prisma.servicio.count(),
    prisma.movimientoInventario.count(),
    prisma.empleado.count({ where: { deletedAt: null } }),
    prisma.suplidor.count(),
    prisma.prospecto.count(),
    prisma.asistencia.count(),
  ])

  console.log('\n══ RESUMEN FINAL ══════════════════════════════════════')
  console.log(`  Clientes     : ${fClientes}`)
  console.log(`  Suplidores   : ${fSups}`)
  console.log(`  Prospectos   : ${fPros}`)
  console.log(`  Empleados    : ${fEmps}`)
  console.log(`  Asistencia   : ${fAsis} registros`)
  console.log(`  Productos    : ${fProds}`)
  console.log(`  ItemCatalogo : ${fItems}`)
  console.log(`  Servicios    : ${fSvcs}`)
  console.log(`  OTs activas  : ${fOTs}`)
  console.log(`  Facturas     : ${fFacts}`)
  console.log(`  Cotizaciones : ${fCots}`)
  console.log(`  Kardex movs  : ${fMovs}`)
  console.log('═══════════════════════════════════════════════════════\n')
}

main()
  .catch(e => { console.error('\n[MEGA-SEED ERROR]', e.message, e.stack); process.exit(1) })
  .finally(() => prisma.$disconnect())
