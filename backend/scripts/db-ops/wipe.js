#!/usr/bin/env node
'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') })
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('Wiping transactional data (Empleado/Rol preserved)...')

  await prisma.lineaCarrito.deleteMany()
  console.log('  ✓ LineaCarrito')

  await prisma.carritoTemp.deleteMany()
  console.log('  ✓ CarritoTemp')

  await prisma.lineaFactura.deleteMany()
  console.log('  ✓ LineaFactura')

  await prisma.factura.deleteMany()
  console.log('  ✓ Factura')

  await prisma.lineaOrdenTrabajo.deleteMany()
  console.log('  ✓ LineaOrdenTrabajo')

  await prisma.ordenTrabajo.deleteMany()
  console.log('  ✓ OrdenTrabajo')

  await prisma.detalleOrden.deleteMany()
  console.log('  ✓ DetalleOrden')

  await prisma.movimientoInventario.deleteMany()
  console.log('  ✓ MovimientoInventario')

  await prisma.ordenInstalacion.deleteMany()
  console.log('  ✓ OrdenInstalacion')

  await prisma.servicio.deleteMany()
  console.log('  ✓ Servicio')

  await prisma.plantillaEquipo.deleteMany()
  console.log('  ✓ PlantillaEquipo')

  await prisma.producto.deleteMany()
  console.log('  ✓ Producto')

  await prisma.itemCatalogo.deleteMany()
  console.log('  ✓ ItemCatalogo')

  await prisma.cliente.deleteMany({ where: { noCliente: { not: 'CF-0001' } } })
  console.log('  ✓ Cliente (CF-0001 preserved)')

  await prisma.plan.deleteMany()
  console.log('  ✓ Plan')

  await prisma.prospecto.deleteMany()
  console.log('  ✓ Prospecto')

  await prisma.auditLog.deleteMany()
  console.log('  ✓ AuditLog')

  await prisma.suplidor.deleteMany()
  console.log('  ✓ Suplidor')

  console.log('Done.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
