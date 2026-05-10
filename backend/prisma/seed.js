require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const bcrypt           = require('bcryptjs')
const PERMISSIONS_MAP  = require('../shared/permissions.map.js')
const prisma           = new PrismaClient()

async function ensureServicio(clienteId, planId, data) {
  const e = await prisma.servicio.findFirst({ where: { clienteId, planId } })
  if (e) return e
  return prisma.servicio.create({ data: { clienteId, planId, ...data } })
}

const ALL_PERM_KEYS   = PERMISSIONS_MAP.map(p => p.key)
const ALL_PERMISOS    = ['sistema:owner', ...ALL_PERM_KEYS]
const ADMIN_PERMISOS  = ALL_PERM_KEYS
const TECH_PERMISOS   = ['dashboard:ver', 'inventario:ver', 'servicios:ver', 'servicios:crear', 'rrhh:ver', 'rrhh:asistencia']

async function main() {
  console.log('Iniciando seed ACR Networks...')

  const passwordHash = await bcrypt.hash('P4$$w0rd', 12)

  // ── Roles ─────────────────────────────────────────────────────────────────
  const [rolPropietario, rolTecRedes, rolTecCCTV] = await Promise.all([
    prisma.rol.upsert({
      where:  { nombre: 'Propietario' },
      update: { permisos: ALL_PERMISOS, activo: true },
      create: { nombre: 'Propietario', descripcion: 'Acceso total al sistema. Propietario único.', permisos: ALL_PERMISOS, activo: true },
    }),
    prisma.rol.upsert({
      where:  { nombre: 'Técnico Redes' },
      update: { permisos: TECH_PERMISOS, activo: true },
      create: { nombre: 'Técnico Redes', descripcion: 'Técnico de campo: WISP y redes estructuradas.', permisos: TECH_PERMISOS, activo: true },
    }),
    prisma.rol.upsert({
      where:  { nombre: 'Técnico CCTV' },
      update: { permisos: ADMIN_PERMISOS, activo: true },
      create: { nombre: 'Técnico CCTV', descripcion: 'Técnico CCTV & Seguridad Electrónica. Acceso administrativo.', permisos: ADMIN_PERMISOS, activo: true },
    }),
  ])
  console.log('  ✅ Roles (3)')

  // ── Empleados ──────────────────────────────────────────────────────────────
  const carmelo = await prisma.empleado.upsert({
    where:  { email: 'crosario@acrnetworks.do' },
    update: { passwordHash, roles: { set: [{ id: rolPropietario.id }] } },
    create: { nombre: 'Carmelo J. Rosario', cargo: 'Propietario / Técnico Senior', email: 'crosario@acrnetworks.do', passwordHash, roles: { connect: [{ id: rolPropietario.id }] } },
  })
  const gerald = await prisma.empleado.upsert({
    where:  { email: 'gerald.maister@acrnetworks.do' },
    update: { passwordHash, roles: { set: [{ id: rolTecCCTV.id }] } },
    create: { nombre: 'Gerald Maister', cargo: 'Técnico CCTV & Seguridad', email: 'gerald.maister@acrnetworks.do', passwordHash, roles: { connect: [{ id: rolTecCCTV.id }] } },
  })
  const rafael = await prisma.empleado.upsert({
    where:  { email: 'rafael.sanchez@acrnetworks.do' },
    update: { passwordHash, roles: { set: [{ id: rolTecRedes.id }] } },
    create: { nombre: 'Rafael A. Sánchez', cargo: 'Técnico Senior Fibra', email: 'rafael.sanchez@acrnetworks.do', passwordHash, roles: { connect: [{ id: rolTecRedes.id }] } },
  })
  console.log('  ✅ Empleados (3)')

  // ── Categorías ────────────────────────────────────────────────────────────
  const [catRedes, catCCTV, catFibra, catPCs] = await Promise.all([
    prisma.categoria.upsert({ where: { nombre: 'Redes y Switching'       }, update: {}, create: { nombre: 'Redes y Switching'       } }),
    prisma.categoria.upsert({ where: { nombre: 'Videovigilancia (CCTV)'  }, update: {}, create: { nombre: 'Videovigilancia (CCTV)'  } }),
    prisma.categoria.upsert({ where: { nombre: 'Fibra Óptica'            }, update: {}, create: { nombre: 'Fibra Óptica'            } }),
    prisma.categoria.upsert({ where: { nombre: 'Equipos de Cómputo'      }, update: {}, create: { nombre: 'Equipos de Cómputo'      } }),
  ])
  console.log('  ✅ Categorías (4)')

  // ── Productos ─────────────────────────────────────────────────────────────
  const [olt, ont, mikrotik, ubiquiti, camDahua, nvrDahua, fibra, dell, connSC, cat6] = await Promise.all([
    prisma.producto.upsert({ where: { sku: 'GPON-OLT-ZTE-C320'       }, update: {}, create: { sku: 'GPON-OLT-ZTE-C320',       nombre: 'OLT GPON ZTE C320 8-Puerto',                     precio: 45000, stockActual: 2,  categoriaId: catFibra.id  } }),
    prisma.producto.upsert({ where: { sku: 'GPON-ONT-ZTE-F601'       }, update: {}, create: { sku: 'GPON-ONT-ZTE-F601',       nombre: 'ONT ZTE F601 GPON 4-Puerto LAN',                 precio: 850,   stockActual: 25, categoriaId: catFibra.id  } }),
    prisma.producto.upsert({ where: { sku: 'NET-MK-RB750GR3'         }, update: {}, create: { sku: 'NET-MK-RB750GR3',         nombre: 'Router MikroTik hEX RB750Gr3',                   precio: 3200,  stockActual: 15, categoriaId: catRedes.id  } }),
    prisma.producto.upsert({ where: { sku: 'NET-UBQ-USW-8-60W'       }, update: {}, create: { sku: 'NET-UBQ-USW-8-60W',       nombre: 'Switch Ubiquiti UniFi 8-Porto 60W PoE',          precio: 4500,  stockActual: 8,  categoriaId: catRedes.id  } }),
    prisma.producto.upsert({ where: { sku: 'CCTV-DAH-IPC-HDW2849H'   }, update: {}, create: { sku: 'CCTV-DAH-IPC-HDW2849H',   nombre: 'Cámara Dahua IP 4MP IPC-HDW2849H',               precio: 2800,  stockActual: 12, categoriaId: catCCTV.id   } }),
    prisma.producto.upsert({ where: { sku: 'CCTV-DAH-NVR2108HS'      }, update: {}, create: { sku: 'CCTV-DAH-NVR2108HS',      nombre: 'NVR Dahua 8 Canales NVR2108HS-8P-4KS2',         precio: 7500,  stockActual: 4,  categoriaId: catCCTV.id   } }),
    prisma.producto.upsert({ where: { sku: 'FO-DROP-2H-1000M'        }, update: {}, create: { sku: 'FO-DROP-2H-1000M',        nombre: 'Bobina Fibra Drop 2 Hilos SM G657A1 1000m',      precio: 12000, stockActual: 3,  categoriaId: catFibra.id  } }),
    prisma.producto.upsert({ where: { sku: 'PC-DELL-LAT5440-I5'      }, update: {}, create: { sku: 'PC-DELL-LAT5440-I5',      nombre: 'Laptop Dell Latitude 5440 i5-1345U 16GB 512SSD', precio: 38000, stockActual: 2,  categoriaId: catPCs.id    } }),
    prisma.producto.upsert({ where: { sku: 'FO-CONN-SCAPC-X10'       }, update: {}, create: { sku: 'FO-CONN-SCAPC-X10',       nombre: 'Conector SC/APC Fusión Pack×10',                  precio: 180,   stockActual: 50, categoriaId: catFibra.id  } }),
    prisma.producto.upsert({ where: { sku: 'NET-CAB-UTP6-305M'       }, update: {}, create: { sku: 'NET-CAB-UTP6-305M',       nombre: 'Cable UTP Cat6 Caja 305m Legrand',               precio: 3800,  stockActual: 7,  categoriaId: catRedes.id  } }),
  ])
  console.log('  ✅ Productos (10)')

  // ── Clientes ──────────────────────────────────────────────────────────────
  const [servicorp, pedro, lucia, carlos] = await Promise.all([
    prisma.cliente.upsert({
      where: { noCliente: 'CLI-001' }, update: {},
      create: {
        noCliente: 'CLI-001', razonSocial: 'ServiCorp, S.R.L.', nombreComercial: 'ServiCorp',
        rnc: '101123456', tipoEmpresa: 'SRL', tipoCliente: 'Corporativo',
        nombreContacto: 'Luis', apellidoContacto: 'Fernández', cargo: 'Gerente TI',
        direccion: 'Av. Winston Churchill #45, Torre Empresarial 3, P.8',
        sector: 'Piantini', provincia: 'Santo Domingo', telefonoPrincipal: '8094561234',
        email: 'ti@servicorp.do', itbis: true, tipoNcf: 'Crédito Fiscal',
        limiteCredito: 150000, diasCredito: 30, latitud: '18.4717', longitud: '-69.9419', activo: true,
      },
    }),
    prisma.cliente.upsert({
      where: { noCliente: 'CLI-002' }, update: {},
      create: {
        noCliente: 'CLI-002', razonSocial: 'Pedro Antonio Martínez', tipoEmpresa: 'Persona Física',
        tipoCliente: 'Residencial', cedula: '00112345678', nombreContacto: 'Pedro', apellidoContacto: 'Martínez',
        direccion: 'C/ Josefa Pérez de Troncoso #12, Los Prados', sector: 'Los Prados',
        provincia: 'Santo Domingo', telefonoPrincipal: '8297651234', email: 'pedro.mtz@gmail.com',
        itbis: false, tipoNcf: 'Consumidor Final', activo: true, latitud: '18.4961', longitud: '-69.9352',
      },
    }),
    prisma.cliente.upsert({
      where: { noCliente: 'CLI-003' }, update: {},
      create: {
        noCliente: 'CLI-003', razonSocial: 'Lucía M. Jiménez de Sánchez', tipoEmpresa: 'Persona Física',
        tipoCliente: 'Residencial', cedula: '00123456789', nombreContacto: 'Lucía', apellidoContacto: 'Jiménez',
        direccion: 'Res. Las Américas, Bl. C, Apto. 204', sector: 'Las Américas',
        provincia: 'Santo Domingo', telefonoPrincipal: '8499871234', email: 'lucia.jimenez@gmail.com',
        itbis: false, tipoNcf: 'Consumidor Final', activo: true, latitud: '18.4561', longitud: '-69.9002',
      },
    }),
    prisma.cliente.upsert({
      where: { noCliente: 'CLI-004' }, update: {},
      create: {
        noCliente: 'CLI-004', razonSocial: 'Carlos Tejeda Vargas', tipoEmpresa: 'Persona Física',
        tipoCliente: 'Residencial', cedula: '00134567890', nombreContacto: 'Carlos', apellidoContacto: 'Tejeda',
        direccion: 'Av. Independencia #220, San Carlos', sector: 'San Carlos',
        provincia: 'Santo Domingo', telefonoPrincipal: '8093452345', email: 'ctejeda@hotmail.com',
        itbis: false, tipoNcf: 'Consumidor Final', activo: true, latitud: '18.4801', longitud: '-69.9098',
      },
    }),
  ])
  console.log('  ✅ Clientes (4)')

  // ── Suplidores ────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.suplidor.upsert({
      where: { noSuplidor: 'SUP-001' }, update: {},
      create: {
        noSuplidor: 'SUP-001', razonSocial: 'Importadora TelRed, S.R.L.', nombreComercial: 'TelRed',
        rnc: '101456789', actividad: 'Importación y Distribución de Equipos de Telecomunicaciones',
        direccion: 'Av. Luperón KM 6.5, Zona Industrial Herrera', sector: 'Herrera',
        provincia: 'Santo Domingo Oeste', telefonoPrincipal: '8094567890',
        nombreContacto: 'Mario Rodríguez', email: 'ventas@telred.do',
        limiteCredito: 300000, diasCredito: 60, activo: true,
      },
    }),
    prisma.suplidor.upsert({
      where: { noSuplidor: 'SUP-002' }, update: {},
      create: {
        noSuplidor: 'SUP-002', razonSocial: 'Fibra & Más, S.R.L.', nombreComercial: 'Fibra & Más',
        rnc: '101789012', actividad: 'Distribución de Materiales de Fibra Óptica y Cableado Estructurado',
        direccion: 'C/ Padre Castellanos #88, Los Mameyes', sector: 'Los Mameyes',
        provincia: 'Santo Domingo Este', telefonoPrincipal: '8298765432',
        nombreContacto: 'Yolanda Peralta', email: 'info@fibraymas.do',
        limiteCredito: 200000, diasCredito: 45, activo: true,
      },
    }),
  ])
  console.log('  ✅ Suplidores (2)')

  // ── Planes ────────────────────────────────────────────────────────────────
  let planWISP = await prisma.plan.findFirst({ where: { nombre: 'WISP Residencial 50MB' } })
  if (!planWISP) {
    planWISP = await prisma.plan.create({
      data: {
        nombre: 'WISP Residencial 50MB', tipo: 'WISP',
        precioMensualBase: 1200, precioInstalBase: 3500, activo: true,
        plantillaEquipos: { create: [{ productoId: mikrotik.id, cantidad: 1 }, { productoId: ont.id, cantidad: 1 }] },
      },
    })
  }
  let planCCTV = await prisma.plan.findFirst({ where: { nombre: 'Monitoreo CCTV Básico 4 Cámaras' } })
  if (!planCCTV) {
    planCCTV = await prisma.plan.create({
      data: {
        nombre: 'Monitoreo CCTV Básico 4 Cámaras', tipo: 'CCTV',
        precioMensualBase: 1800, precioInstalBase: 15000, activo: true,
        plantillaEquipos: { create: [{ productoId: camDahua.id, cantidad: 4 }, { productoId: nvrDahua.id, cantidad: 1 }] },
      },
    })
  }
  console.log('  ✅ Planes (2)')

  // ── Servicios ─────────────────────────────────────────────────────────────
  const servicioServiCorp = await ensureServicio(servicorp.id, planWISP.id, {
    estado: 'Activo', precioMensual: 2500, precioInstalacion: 5000,
    direccionInstalacion: 'Av. Winston Churchill #45, Torre Empresarial 3, P.8',
    latitud: '18.4717', longitud: '-69.9419',
  })
  const servicioPedro = await ensureServicio(pedro.id, planWISP.id, {
    estado: 'Activo', precioMensual: 1200, precioInstalacion: 3500,
    direccionInstalacion: 'C/ Josefa Pérez de Troncoso #12, Los Prados',
    latitud: '18.4961', longitud: '-69.9352',
  })
  const servicioLucia = await ensureServicio(lucia.id, planCCTV.id, {
    estado: 'Activo', precioMensual: 1800, precioInstalacion: 15000,
    direccionInstalacion: 'Res. Las Américas, Bl. C, Apto. 204',
    latitud: '18.4561', longitud: '-69.9002',
  })
  const servicioCarlos = await ensureServicio(carlos.id, planWISP.id, {
    estado: 'EnInstalacion', precioMensual: 1200, precioInstalacion: 3500,
    direccionInstalacion: 'Av. Independencia #220, San Carlos',
    latitud: '18.4801', longitud: '-69.9098',
  })
  console.log('  ✅ Servicios (4)')

  // ── Órdenes + Movimientos ─────────────────────────────────────────────────
  if (!await prisma.ordenInstalacion.findFirst({ where: { servicioId: servicioPedro.id } })) {
    await prisma.$transaction(async (tx) => {
      const o = await tx.ordenInstalacion.create({
        data: {
          servicioId: servicioPedro.id, tipo: 'Instalacion', tecnicoId: carmelo.id,
          estado: 'Completada', completadaEn: new Date(Date.now() - 7 * 86400_000),
          notas: 'Instalación completada. SNR: -25 dBm. Velocidad confirmada 50 Mbps downstream.',
          detalles: { create: [{ productoId: mikrotik.id, cantidad: 1 }, { productoId: ont.id, cantidad: 1 }] },
        },
      })
      await tx.producto.update({ where: { id: mikrotik.id }, data: { stockActual: { decrement: 1 } } })
      await tx.producto.update({ where: { id: ont.id },      data: { stockActual: { decrement: 1 } } })
      await tx.movimientoInventario.createMany({ data: [
        { productoId: mikrotik.id, tipo: 'Salida', cantidad: 1, ordenInstalacionId: o.id },
        { productoId: ont.id,      tipo: 'Salida', cantidad: 1, ordenInstalacionId: o.id },
      ]})
    })
  }
  if (!await prisma.ordenInstalacion.findFirst({ where: { servicioId: servicioLucia.id } })) {
    await prisma.$transaction(async (tx) => {
      const o = await tx.ordenInstalacion.create({
        data: {
          servicioId: servicioLucia.id, tipo: 'Instalacion', tecnicoId: gerald.id,
          estado: 'Completada', completadaEn: new Date(Date.now() - 3 * 86400_000),
          notas: 'Sistema CCTV instalado. 4 cámaras IP + NVR. Acceso remoto DMSS configurado.',
          detalles: { create: [{ productoId: camDahua.id, cantidad: 4 }, { productoId: nvrDahua.id, cantidad: 1 }] },
        },
      })
      await tx.producto.update({ where: { id: camDahua.id }, data: { stockActual: { decrement: 4 } } })
      await tx.producto.update({ where: { id: nvrDahua.id }, data: { stockActual: { decrement: 1 } } })
      await tx.movimientoInventario.createMany({ data: [
        { productoId: camDahua.id, tipo: 'Salida', cantidad: 4, ordenInstalacionId: o.id },
        { productoId: nvrDahua.id, tipo: 'Salida', cantidad: 1, ordenInstalacionId: o.id },
      ]})
    })
  }
  if (!await prisma.ordenInstalacion.findFirst({ where: { servicioId: servicioCarlos.id } })) {
    await prisma.ordenInstalacion.create({
      data: {
        servicioId: servicioCarlos.id, tipo: 'Instalacion', tecnicoId: rafael.id,
        estado: 'Pendiente', notas: 'Verificar acceso al edificio con el administrador.',
        detalles: { create: [{ productoId: mikrotik.id, cantidad: 1 }, { productoId: ont.id, cantidad: 1 }] },
      },
    })
  }
  if (!await prisma.ordenInstalacion.findFirst({ where: { servicioId: servicioServiCorp.id } })) {
    await prisma.ordenInstalacion.create({
      data: {
        servicioId: servicioServiCorp.id, tipo: 'Instalacion', tecnicoId: carmelo.id,
        estado: 'Pendiente', notas: 'Instalación corporativa piso 8. Coordinar con Gerente TI Luis Fernández.',
        detalles: { create: [
          { productoId: mikrotik.id, cantidad: 1 },
          { productoId: ont.id,      cantidad: 2 },
          { productoId: ubiquiti.id, cantidad: 1 },
        ]},
      },
    })
  }
  console.log('  ✅ Órdenes + movimientos de inventario')

  // ── Asistencia (muestra histórica) ────────────────────────────────────────
  if (!await prisma.asistencia.findFirst()) {
    const hoy  = new Date()
    const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1)
    const d = (base, h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0)
    await prisma.asistencia.createMany({ data: [
      { empleadoId: carmelo.id, tipo: 'Entrada', fechaHora: d(ayer, 8, 15) },
      { empleadoId: carmelo.id, tipo: 'Salida',  fechaHora: d(ayer, 17, 30) },
      { empleadoId: gerald.id,  tipo: 'Entrada', fechaHora: d(ayer, 8, 0) },
      { empleadoId: gerald.id,  tipo: 'Salida',  fechaHora: d(ayer, 18, 10) },
      { empleadoId: rafael.id,  tipo: 'Entrada', fechaHora: d(ayer, 7, 45) },
      { empleadoId: rafael.id,  tipo: 'Salida',  fechaHora: d(ayer, 17, 0) },
      { empleadoId: carmelo.id, tipo: 'Entrada', fechaHora: d(hoy, 8, 5) },
      { empleadoId: gerald.id,  tipo: 'Entrada', fechaHora: d(hoy, 7, 58) },
    ]})
  }
  console.log('  ✅ Asistencia de muestra')

  console.log('\n🎉 Seed completado. Sistema listo para usar.')
}

main()
  .catch(e => { console.error('❌ Error en seed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
