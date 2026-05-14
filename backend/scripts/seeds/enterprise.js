#!/usr/bin/env node
'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') })
const { PrismaClient, TipoServicio, TipoFacturacion, TipoItem, EstadoFactura } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('Seeding enterprise data...')

  // ─── Categoria ───────────────────────────────────────────────────────────────
  const [catRed, catCCTV, catWisp] = await Promise.all([
    prisma.categoria.upsert({ where: { nombre: 'Redes' },       update: {}, create: { nombre: 'Redes' } }),
    prisma.categoria.upsert({ where: { nombre: 'CCTV' },        update: {}, create: { nombre: 'CCTV' } }),
    prisma.categoria.upsert({ where: { nombre: 'WISP' },        update: {}, create: { nombre: 'WISP' } }),
  ])
  console.log('  ✓ Categorias')

  // ─── Planes ──────────────────────────────────────────────────────────────────
  const [planFibra10, planFibra25, planFibra50] = await Promise.all([
    prisma.plan.create({ data: { nombre: 'Fibra 10 Mbps', tipo: TipoServicio.WISP, precioMensualBase: 1500, precioInstalBase: 3000 } }),
    prisma.plan.create({ data: { nombre: 'Fibra 25 Mbps', tipo: TipoServicio.WISP, precioMensualBase: 2500, precioInstalBase: 3500 } }),
    prisma.plan.create({ data: { nombre: 'Fibra 50 Mbps', tipo: TipoServicio.WISP, precioMensualBase: 4000, precioInstalBase: 4500 } }),
  ])
  console.log('  ✓ Planes')

  // ─── Productos (Inventario) ───────────────────────────────────────────────────
  const [router, switch8, patchCord, camDomo, camBala, nvrHikvision, hdmi50m] = await Promise.all([
    prisma.producto.create({ data: { sku: 'NET-RTR-001', nombre: 'Router MikroTik hAP ac3', precio: 8500, stockActual: 12, categoriaId: catRed.id, tipoItem: TipoItem.ARTICULO } }),
    prisma.producto.create({ data: { sku: 'NET-SW-008',  nombre: 'Switch TP-Link 8 Puertos', precio: 3200, stockActual: 20, categoriaId: catRed.id, tipoItem: TipoItem.ARTICULO } }),
    prisma.producto.create({ data: { sku: 'NET-PC-002',  nombre: 'Patch Cord Cat6 2m',       precio:  180, stockActual: 150, categoriaId: catRed.id, tipoItem: TipoItem.ARTICULO } }),
    prisma.producto.create({ data: { sku: 'CAM-DOMO-01', nombre: 'Cámara Domo Hikvision 2MP', precio: 4800, stockActual: 8,  categoriaId: catCCTV.id, tipoItem: TipoItem.ARTICULO } }),
    prisma.producto.create({ data: { sku: 'CAM-BALA-01', nombre: 'Cámara Bala Dahua 4MP',     precio: 5200, stockActual: 6,  categoriaId: catCCTV.id, tipoItem: TipoItem.ARTICULO } }),
    prisma.producto.create({ data: { sku: 'CAM-NVR-004', nombre: 'NVR Hikvision 4CH',         precio: 9500, stockActual: 4,  categoriaId: catCCTV.id, tipoItem: TipoItem.ARTICULO } }),
    prisma.producto.create({ data: { sku: 'NET-HDMI-50', nombre: 'Cable HDMI 50m',             precio: 1100, stockActual: 30, categoriaId: catRed.id,  tipoItem: TipoItem.ARTICULO } }),
  ])
  console.log('  ✓ Productos (7)')

  // ─── ItemCatalogo (POS / Servicios) ──────────────────────────────────────────
  await Promise.all([
    prisma.itemCatalogo.create({ data: { nombre: 'Plan Fibra 10 Mbps',    descripcion: 'Servicio WISP mensual 10 Mbps', tipo: TipoFacturacion.Recurrente, categoria: TipoServicio.WISP,    precio: 1500, tipoItem: TipoItem.SERVICIO } }),
    prisma.itemCatalogo.create({ data: { nombre: 'Plan Fibra 25 Mbps',    descripcion: 'Servicio WISP mensual 25 Mbps', tipo: TipoFacturacion.Recurrente, categoria: TipoServicio.WISP,    precio: 2500, tipoItem: TipoItem.SERVICIO } }),
    prisma.itemCatalogo.create({ data: { nombre: 'Plan Fibra 50 Mbps',    descripcion: 'Servicio WISP mensual 50 Mbps', tipo: TipoFacturacion.Recurrente, categoria: TipoServicio.WISP,    precio: 4000, tipoItem: TipoItem.SERVICIO } }),
    prisma.itemCatalogo.create({ data: { nombre: 'Instalación CCTV 4CH',  descripcion: 'Instalación básica 4 cámaras',  tipo: TipoFacturacion.VentaUnica,  categoria: TipoServicio.CCTV,    precio: 8000, tipoItem: TipoItem.SERVICIO } }),
    prisma.itemCatalogo.create({ data: { nombre: 'Soporte Técnico / Hora', descripcion: 'Visita técnica por hora',      tipo: TipoFacturacion.Servicio,    categoria: TipoServicio.SoporteTecnico, precio: 1200, tipoItem: TipoItem.SERVICIO } }),
    prisma.itemCatalogo.create({ data: { nombre: 'Configuración Router',  descripcion: 'Config y hardening de router',  tipo: TipoFacturacion.Servicio,    categoria: TipoServicio.Redes,   precio: 2000, tipoItem: TipoItem.SERVICIO } }),
    prisma.itemCatalogo.create({ data: { nombre: 'Certificación Cableado', descripcion: 'Certificación cat6',           tipo: TipoFacturacion.Servicio,    categoria: TipoServicio.Redes,   precio: 4500, tipoItem: TipoItem.SERVICIO } }),
  ])
  console.log('  ✓ ItemCatalogo (7)')

  // ─── Clientes ────────────────────────────────────────────────────────────────
  const [cliCorp1, cliCorp2, cliCorp3, cliRes1, cliRes2] = await Promise.all([
    prisma.cliente.create({ data: {
      noCliente: 'CLI-0001', razonSocial: 'Distribuidora Don Pepe S.R.L.', tipoEmpresa: 'SRL',
      rnc: '101234567', nombreContacto: 'Pedro', apellidoContacto: 'Martínez', cargo: 'Gerente',
      direccion: 'Av. Winston Churchill 123', sector: 'Piantini', provincia: 'Distrito Nacional',
      telefonoPrincipal: '809-555-0101', email: 'pepe@donpepe.do',
      tipoCliente: 'Corporativo', itbis: true, tipoNcf: 'Fiscal',
    }}),
    prisma.cliente.create({ data: {
      noCliente: 'CLI-0002', razonSocial: 'Tech Solutions RD S.A.S.', tipoEmpresa: 'SAS',
      rnc: '101345678', nombreContacto: 'María', apellidoContacto: 'Pérez', cargo: 'CEO',
      direccion: 'C/ El Conde 45, Of. 3', sector: 'Zona Colonial', provincia: 'Distrito Nacional',
      telefonoPrincipal: '809-555-0202', email: 'mperez@techrd.do',
      tipoCliente: 'Corporativo', itbis: true, tipoNcf: 'Fiscal',
    }}),
    prisma.cliente.create({ data: {
      noCliente: 'CLI-0003', razonSocial: 'Constructora Rivera S.R.L.', tipoEmpresa: 'SRL',
      rnc: '101456789', nombreContacto: 'Carlos', apellidoContacto: 'Rivera', cargo: 'Director',
      direccion: 'Av. Independencia 889', sector: 'Gazcue', provincia: 'Distrito Nacional',
      telefonoPrincipal: '809-555-0303', email: 'crivera@rivera.do',
      tipoCliente: 'Corporativo', itbis: true, tipoNcf: 'Fiscal',
    }}),
    prisma.cliente.create({ data: {
      noCliente: 'CLI-0004', razonSocial: 'Ana González', tipoEmpresa: 'Persona Física',
      nombreContacto: 'Ana', apellidoContacto: 'González',
      cedula: '001-1234567-8',
      direccion: 'C/ Las Flores 12, Apto 3', sector: 'Bella Vista', provincia: 'Distrito Nacional',
      telefonoPrincipal: '829-555-0404', email: 'ana.gonzalez@gmail.com',
      tipoCliente: 'Residencial', itbis: false, tipoNcf: 'Consumidor Final',
    }}),
    prisma.cliente.create({ data: {
      noCliente: 'CLI-0005', razonSocial: 'José Ramírez', tipoEmpresa: 'Persona Física',
      nombreContacto: 'José', apellidoContacto: 'Ramírez',
      cedula: '001-9876543-2',
      direccion: 'Calle 3 #45, Los Pinos', sector: 'Los Pinos', provincia: 'Santiago',
      telefonoPrincipal: '849-555-0505', email: 'jose.ramirez@hotmail.com',
      tipoCliente: 'Residencial', itbis: false, tipoNcf: 'Consumidor Final',
    }}),
  ])
  console.log('  ✓ Clientes (5)')

  // ─── Órdenes de Trabajo ───────────────────────────────────────────────────────
  const ot1 = await prisma.ordenTrabajo.create({ data: {
    noOT: 'OT-0001',
    clienteId: cliCorp1.id,
    tipoOT: 'Instalacion',
    estado: 'Completada',
    notasTecnicas: 'Instalación de red LAN + 4 cámaras en oficina.',
    lineas: { create: [
      { descripcion: 'Instalación LAN 8 puntos',   cantidad: 1, precioUnitario: 12000 },
      { descripcion: 'Cámara Domo Hikvision 2MP',  cantidad: 4, precioUnitario: 4800, productoId: camDomo.id },
    ]},
  }})

  const ot2 = await prisma.ordenTrabajo.create({ data: {
    noOT: 'OT-0002',
    clienteId: cliRes1.id,
    tipoOT: 'SoporteTecnico',
    estado: 'Pendiente',
    notasTecnicas: 'Router sin internet — revisar configuración PPPoE.',
    lineas: { create: [
      { descripcion: 'Soporte Técnico / Hora', cantidad: 2, precioUnitario: 1200 },
    ]},
  }})
  console.log('  ✓ OTs (2)')

  // ─── NCF config ───────────────────────────────────────────────────────────────
  await prisma.configuracionNCF.deleteMany({ where: { tipoNcf: { in: ['Crédito Fiscal', 'Comprobante de Fiscal'] } } })
  await prisma.configuracionNCF.upsert({
    where: { tipoNcf: 'Fiscal' },
    update: {},
    create: { prefijo: 'B01', tipoNcf: 'Fiscal', tipoDescripcion: 'Crédito Fiscal', secuenciaActual: 0, limite: 9999999, activo: true },
  })
  await prisma.configuracionNCF.upsert({
    where: { tipoNcf: 'Consumidor Final' },
    update: {},
    create: { prefijo: 'B02', tipoNcf: 'Consumidor Final', tipoDescripcion: 'Consumidor Final', secuenciaActual: 0, limite: 9999999, activo: true },
  })

  // ─── Facturas pagadas ─────────────────────────────────────────────────────────
  const sub1 = 12000 + 4 * 4800  // 31200
  const itb1 = Math.round(sub1 * 0.18 * 100) / 100  // 5616
  const tot1 = sub1 + itb1  // 36816

  await prisma.factura.create({ data: {
    noFactura: 'F-0001',
    clienteId: cliCorp1.id,
    ordenId: ot1.id,
    estado: EstadoFactura.Pagada,
    subtotal: sub1,
    itbis: itb1,
    total: tot1,
    tipoNcf: 'Fiscal',
    fechaEmision: new Date('2026-05-01'),
    fechaPago: new Date('2026-05-03'),
    lineas: { create: [
      { descripcion: 'Instalación LAN 8 puntos',  cantidad: 1, precioUnitario: 12000, productoId: null },
      { descripcion: 'Cámara Domo Hikvision 2MP', cantidad: 4, precioUnitario:  4800, productoId: camDomo.id },
    ]},
  }})

  const sub2 = 2 * 1200  // 2400
  const tot2 = sub2  // no ITBIS (residencial)

  await prisma.factura.create({ data: {
    noFactura: 'F-0002',
    clienteId: cliRes1.id,
    ordenId: ot2.id,
    estado: EstadoFactura.Pagada,
    subtotal: sub2,
    itbis: 0,
    total: tot2,
    tipoNcf: 'Consumidor Final',
    fechaEmision: new Date('2026-05-05'),
    fechaPago: new Date('2026-05-05'),
    lineas: { create: [
      { descripcion: 'Soporte Técnico / Hora', cantidad: 2, precioUnitario: 1200, productoId: null },
    ]},
  }})
  console.log('  ✓ Facturas pagadas (2)')

  console.log('Seed complete.')
  console.log(`  Clientes: 5  |  Productos: 7  |  ItemCatalogo: 7  |  OTs: 2  |  Facturas: 2`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
