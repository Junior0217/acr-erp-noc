#!/usr/bin/env node
/**
 * THE GREAT PURGE & REALISTIC SEED
 *
 * Borra TODOS los datos transaccionales de Ventas e Inventario y siembra
 * categorías, productos físicos e items de catálogo realistas para ACR Networks.
 *
 * Ejecutar:
 *   node prisma/seed-purge-realistic.js
 *   (NO usa el seed por default de Prisma — es un script standalone idempotente)
 *
 * SEGURIDAD: confirma con CONFIRM_PURGE=1 antes de borrar. Sin la flag aborta.
 */
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CONFIRM = process.env.CONFIRM_PURGE === '1' || process.argv.includes('--yes')

async function ensureSchema() {
  // Asegura columnas + tablas nuevas si la migración no se ha aplicado todavía.
  // Idempotente (IF NOT EXISTS).
  const stmts = [
    `ALTER TABLE "EmpresaPerfil" ADD COLUMN IF NOT EXISTS "maxDescuentoCajero" INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE "EmpresaPerfil" ADD COLUMN IF NOT EXISTS "pinSupervisor" TEXT NOT NULL DEFAULT '1234'`,
    `ALTER TABLE "EmpresaPerfil" ADD COLUMN IF NOT EXISTS "condicionesDefault" JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE "Producto"      ADD COLUMN IF NOT EXISTS "costoPromedio" DECIMAL(12,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE "Producto"      ADD COLUMN IF NOT EXISTS "descripcion"   TEXT`,
    `ALTER TABLE "Producto"      ADD COLUMN IF NOT EXISTS "imagenUrl"     TEXT`,
    `ALTER TABLE "Factura"       ADD COLUMN IF NOT EXISTS "etapaPipeline" TEXT NOT NULL DEFAULT 'Borrador'`,
    `ALTER TABLE "Factura"       ADD COLUMN IF NOT EXISTS "pagos"         JSONB`,
    `ALTER TABLE "Factura"       ADD COLUMN IF NOT EXISTS "snapshot"      JSONB`,
    `ALTER TABLE "Factura"       ADD COLUMN IF NOT EXISTS "pdfUrl"        TEXT`,
    `ALTER TABLE "Factura"       ADD COLUMN IF NOT EXISTS "condiciones"   JSONB`,
    `ALTER TABLE "ItemCatalogo"  ADD COLUMN IF NOT EXISTS "imagenUrl"     TEXT`,
    `ALTER TABLE "ItemCatalogo"  ADD COLUMN IF NOT EXISTS "productoId"    INTEGER`,
    `ALTER TABLE "ItemCatalogo"  ADD COLUMN IF NOT EXISTS "codigo"        TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ItemCatalogo_codigo_key" ON "ItemCatalogo"("codigo")`,
    `CREATE INDEX IF NOT EXISTS "Factura_etapaPipeline_idx" ON "Factura"("etapaPipeline")`,
    `CREATE TABLE IF NOT EXISTS "AuditCaja" (
       "id" SERIAL PRIMARY KEY, "tipo" TEXT NOT NULL, "empleadoId" INTEGER, "facturaId" TEXT,
       "monto" DECIMAL(12,2), "descPct" DECIMAL(5,2), "detalle" TEXT, "ip" TEXT, "ua" TEXT,
       "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AuditCaja_tipo_idx"      ON "AuditCaja"("tipo")`,
    `CREATE INDEX IF NOT EXISTS "AuditCaja_createdAt_idx" ON "AuditCaja"("createdAt")`,
    `CREATE TABLE IF NOT EXISTS "ProductoSerial" (
       "id" SERIAL PRIMARY KEY,
       "productoId" INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
       "serie" TEXT NOT NULL, "estado" TEXT NOT NULL DEFAULT 'Disponible',
       "ubicacion" TEXT, "facturaId" TEXT, "garantiaHasta" TIMESTAMP, "notas" TEXT,
       "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ProductoSerial_productoId_serie_key" ON "ProductoSerial"("productoId","serie")`,
    `CREATE TABLE IF NOT EXISTS "ReservaInventario" (
       "id" SERIAL PRIMARY KEY,
       "productoId" INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
       "facturaId" TEXT, "cantidad" INTEGER NOT NULL, "expiraEn" TIMESTAMP NOT NULL,
       "liberada" BOOLEAN NOT NULL DEFAULT false, "motivo" TEXT,
       "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS "ProductoBundle" (
       "id" SERIAL PRIMARY KEY,
       "padreId" INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
       "hijoId"  INTEGER NOT NULL REFERENCES "Producto"("id") ON DELETE CASCADE,
       "score" INTEGER NOT NULL DEFAULT 1, "motivo" TEXT,
       "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ProductoBundle_padreId_hijoId_key" ON "ProductoBundle"("padreId","hijoId")`,
  ]
  console.log('🧰 ensureSchema — aplicando ALTER/CREATE IF NOT EXISTS...')
  for (const s of stmts) {
    try { await prisma.$executeRawUnsafe(s) } catch (e) { console.error('   ⚠ ', e.message?.slice(0, 100)) }
  }
  console.log('   ✅ schema verificado')
}

async function purge() {
  console.log('🧹 PURGE — borrando tablas de Ventas + Inventario...')
  // Orden importante: respetar FKs (cascade donde aplica, otros manual).
  // Capa 1: líneas/movimientos (refs a Factura/Orden/Producto)
  await prisma.lineaFactura.deleteMany({})
  await prisma.lineaCarrito.deleteMany({})
  await prisma.lineaOrdenTrabajo.deleteMany({})
  await prisma.detalleOrden.deleteMany({})
  await prisma.movimientoInventario.deleteMany({})
  try { await prisma.reservaInventario.deleteMany({}) } catch {}
  try { await prisma.productoSerial.deleteMany({})    } catch {}
  try { await prisma.productoBundle.deleteMany({})    } catch {}
  // Capa 2: facturas + ordenes (refs a Cliente)
  await prisma.factura.deleteMany({})
  await prisma.ordenTrabajo.deleteMany({})
  await prisma.ordenInstalacion.deleteMany({})
  // Capa 3: relaciones de Producto que no son cascade
  await prisma.plantillaEquipo.deleteMany({})
  await prisma.activoCliente.deleteMany({})
  try { await prisma.equipoPrestamo.deleteMany({}) } catch {}
  // Capa 4: catálogo + producto + categoria
  await prisma.itemCatalogo.deleteMany({})
  await prisma.producto.deleteMany({})
  await prisma.categoria.deleteMany({})
  await prisma.configuracionNCF.deleteMany({})
  try { await prisma.auditCaja.deleteMany({}) } catch {}
  console.log('   ✅ tablas vacías')
}

async function seedEmpresa() {
  console.log('🏢 EmpresaPerfil + condicionesDefault...')
  await prisma.empresaPerfil.upsert({
    where:  { id: 1 },
    update: {
      condicionesDefault: {
        validez:  'Válida por 15 días calendario desde la emisión.',
        pago:     '50% al iniciar trabajos · 50% contra entrega.',
        entrega:  '5 a 10 días laborables tras anticipo.',
        garantia: '1 año sobre instalación · 6 meses sobre red y configuración.',
      },
      pinSupervisor:      process.env.PIN_INICIAL ?? '1234',
      maxDescuentoCajero: 15,
    },
    create: {
      id: 1, rnc: '131-12345-6',
      razonSocial:      'ACR Networks & Solutions, S.R.L.',
      nombreComercial:  'ACR Networks',
      direccion:        'Av. Winston Churchill #1099, Torre Caribbean Plaza',
      sector:           'Piantini', provincia: 'Distrito Nacional', pais: 'República Dominicana',
      telefono:         '829-555-0100',
      email:            'info@acrnetworks.do',
      website:          'https://acrnetworks.do',
      eslogan:          'Proveedor WISP · CCTV · Redes · Seguridad Electrónica',
      tipoEmpresa:      'SRL',
      representanteNombre:   'Carmelo',
      representanteApellido: 'Rosario',
      representanteCargo:    'Presidente',
      condicionesDefault: {
        validez:  'Válida por 15 días calendario desde la emisión.',
        pago:     '50% al iniciar trabajos · 50% contra entrega.',
        entrega:  '5 a 10 días laborables tras anticipo.',
        garantia: '1 año sobre instalación · 6 meses sobre red y configuración.',
      },
      pinSupervisor:      process.env.PIN_INICIAL ?? '1234',
      maxDescuentoCajero: 15,
    },
  })
  console.log('   ✅ Empresa lista')
}

async function seedNcfConfig() {
  console.log('🧾 ConfiguracionNCF...')
  const configs = [
    { prefijo: 'B01', tipoNcf: 'Fiscal',            tipoDescripcion: 'Comprobante con NCF Fiscal',     secuenciaActual: 1, limite: 9999999, activo: true },
    { prefijo: 'B02', tipoNcf: 'Consumidor Final',  tipoDescripcion: 'Comprobante a Consumidor Final', secuenciaActual: 1, limite: 9999999, activo: true },
    { prefijo: 'B14', tipoNcf: 'Regimen Especial',  tipoDescripcion: 'Régimen Especial',               secuenciaActual: 1, limite: 9999999, activo: true },
    { prefijo: 'B15', tipoNcf: 'Gubernamental',     tipoDescripcion: 'Gubernamental',                  secuenciaActual: 1, limite: 9999999, activo: true },
  ]
  for (const c of configs) {
    await prisma.configuracionNCF.upsert({
      where:  { tipoNcf: c.tipoNcf },
      update: { prefijo: c.prefijo, tipoDescripcion: c.tipoDescripcion, activo: true },
      create: c,
    })
  }
  console.log(`   ✅ ${configs.length} secuencias NCF`)
}

async function seedCategorias() {
  console.log('📂 Categorías...')
  const cats = ['WISP', 'CCTV', 'Redes', 'Fibra Óptica', 'Equipos de Cómputo', 'Mano de Obra']
  const out = {}
  for (const nombre of cats) {
    const c = await prisma.categoria.upsert({
      where:  { nombre },
      update: {},
      create: { nombre },
    })
    out[nombre] = c
  }
  console.log(`   ✅ ${cats.length} categorías`)
  return out
}

async function seedProductos(cats) {
  console.log('📦 Productos físicos (inventario)...')
  const data = [
    { sku: 'MK-HAPAX2',       nombre: 'Router MikroTik hAP ax² (RBD52G-5HacD2HnD)', precio: 7500,  costoPromedio: 5200, stockActual: 12, stockMinimo: 3, categoria: 'WISP',  descripcion: 'Router WiFi 6 dual-band\n- 5 puertos GbE\n- WiFi 6 802.11ax 1.2Gbps\n- RouterOS v7\n- POE-in/out' },
    { sku: 'UB-LB-AC',        nombre: 'Ubiquiti LiteBeam 5AC Gen2',                 precio: 4800,  costoPromedio: 3100, stockActual: 25, stockMinimo: 6, categoria: 'WISP',  descripcion: 'CPE PTMP 5GHz airMAX ac\n- 23 dBi\n- 450+ Mbps real\n- POE 24V incluido' },
    { sku: 'HK-DS-2CD2T47',   nombre: 'Hikvision DS-2CD2T47G2-L 4MP ColorVu',       precio: 6200,  costoPromedio: 4100, stockActual: 32, stockMinimo: 8, categoria: 'CCTV',  descripcion: 'Bullet IP 4MP ColorVu 24/7 a color\n- IR 60m\n- Audio 2-way\n- microSD slot' },
    { sku: 'HK-NVR-7616',     nombre: 'Hikvision NVR DS-7616NI-K2/16P 16CH POE',    precio: 28500, costoPromedio: 19800, stockActual: 6,  stockMinimo: 2, categoria: 'CCTV',  descripcion: 'NVR 16 canales 4K\n- 16 puertos POE+\n- 2 bahías HDD\n- H.265+\n- App HikConnect' },
    { sku: 'WD-PURPLE-4TB',   nombre: 'WD Purple 4TB Disco para Vigilancia',        precio: 5200,  costoPromedio: 3600, stockActual: 18, stockMinimo: 5, categoria: 'CCTV',  descripcion: 'HDD optimizado CCTV 24/7\n- 4TB SATA\n- AllFrame AI\n- 3 años garantía WD' },
    { sku: 'CABLE-UTP-CAT6',  nombre: 'Cable UTP Cat6 Bobina 305m AMP/Comm CCA',   precio: 4500,  costoPromedio: 2900, stockActual: 14, stockMinimo: 4, categoria: 'Redes', descripcion: 'Bobina 305m UTP Cat6\n- CCA · 23 AWG\n- Forro PVC azul\n- Certificación CMR' },
    { sku: 'SW-MK-CRS328',    nombre: 'MikroTik CRS328-24P-4S+RM Switch 24 POE',    precio: 28000, costoPromedio: 19500, stockActual: 4,  stockMinimo: 2, categoria: 'Redes', descripcion: 'Switch administrable 24P GbE + 4 SFP+\n- POE+ 802.3at 500W\n- RouterOS/SwitchOS\n- 1U rack' },
    { sku: 'PATCH-24P',       nombre: 'Patch Panel Cat6 24 puertos 1U',             precio: 2800,  costoPromedio: 1700, stockActual: 9,  stockMinimo: 3, categoria: 'Redes', descripcion: 'Panel 24P Cat6 keystone\n- 1U rack 19"\n- Certificación TIA-568\n- Etiquetable' },
    { sku: 'ONT-HG8245',      nombre: 'ONT Huawei HG8245H GPON',                    precio: 3200,  costoPromedio: 2200, stockActual: 22, stockMinimo: 6, categoria: 'Fibra Óptica', descripcion: 'ONT GPON dual-band\n- 4 puertos GbE\n- WiFi 5\n- VoIP' },
    { sku: 'FUSION-12F',      nombre: 'Cassette Fusión 12F SC/APC',                  precio: 1800,  costoPromedio: 1100, stockActual: 16, stockMinimo: 4, categoria: 'Fibra Óptica', descripcion: 'Cassette de fusión 12 fibras SC/APC\n- Caja resistente IP54\n- Splice tray incluido' },
  ]
  const productos = {}
  for (const p of data) {
    const cat = cats[p.categoria]
    if (!cat) continue
    const prod = await prisma.producto.upsert({
      where:  { sku: p.sku },
      update: { nombre: p.nombre, precio: p.precio, costoPromedio: p.costoPromedio, stockActual: p.stockActual, stockMinimo: p.stockMinimo, descripcion: p.descripcion },
      create: {
        sku: p.sku, nombre: p.nombre, precio: p.precio, costoPromedio: p.costoPromedio,
        stockActual: p.stockActual, stockMinimo: p.stockMinimo,
        descripcion: p.descripcion,
        categoriaId: cat.id, tipoItem: 'ARTICULO',
      },
    })
    productos[p.sku] = prod
  }
  console.log(`   ✅ ${data.length} productos físicos`)
  return productos
}

async function seedCatalogo(productos) {
  console.log('🛒 Items de Catálogo (vitrina comercial)...')

  const items = [
    {
      codigo: 'SRV-0001',
      nombre: 'Suministro e Instalación de Sistema CCTV 16 Cámaras IP Hikvision 4K',
      descripcion: '16 cámaras IP 4K Hikvision\n- NVR 16CH\n- Disco 4TB\n- Cableado UTP Cat6\n- Configuración DDNS\n- Acceso móvil iOS/Android\n- 1 año de garantía',
      tipo: 'VentaUnica', categoria: 'CCTV', tipoItem: 'SERVICIO',
      precio: 85000, costo: 60000,
      productoSku: null,
    },
    {
      codigo: 'SRV-0002',
      nombre: 'Mantenimiento, Configuración e Instalación de Red LAN — 12 puntos Cat6',
      descripcion: 'Cableado estructurado Cat6\n- 12 puntos\n- Patch panel 24p\n- Switch administrable 24p\n- Certificación\n- Documentación técnica',
      tipo: 'VentaUnica', categoria: 'Redes', tipoItem: 'SERVICIO',
      precio: 22000, costo: 13500,
      productoSku: null,
    },
    {
      codigo: 'REC-0001',
      nombre: 'Plan WISP Residencial 25/25 Mbps',
      descripcion: 'Plan internet inalámbrico residencial\n- 25 Mbps simétricos\n- IP dinámica\n- Soporte 24/7\n- Sin contrato de permanencia',
      tipo: 'Recurrente', categoria: 'WISP', tipoItem: 'SERVICIO',
      precio: 1500, costo: 400,
      productoSku: null,
    },
    {
      codigo: 'REC-0002',
      nombre: 'Plan WISP Empresarial 100/100 Mbps Dedicado',
      descripcion: 'Internet dedicado para PyME\n- 100 Mbps simétricos\n- IP fija\n- SLA 99.5%\n- Soporte prioritario',
      tipo: 'Recurrente', categoria: 'WISP', tipoItem: 'SERVICIO',
      precio: 7500, costo: 1800,
      productoSku: null,
    },
    {
      codigo: 'ART-0001',
      nombre: 'Cámara IP Hikvision 4MP ColorVu (suministro individual)',
      descripcion: 'Cámara IP bullet 4MP ColorVu\n- IR 60m + audio\n- Compatible con NVR Hikvision/Dahua',
      tipo: 'VentaUnica', categoria: 'CCTV', tipoItem: 'ARTICULO',
      precio: 7800, costo: 4500,
      productoSku: 'HK-DS-2CD2T47',
    },
    {
      codigo: 'ART-0002',
      nombre: 'Router MikroTik hAP ax² — Suministro',
      descripcion: 'Router WiFi 6 dual-band para residencia o pyme\n- 5 puertos GbE\n- POE-in/out\n- RouterOS v7',
      tipo: 'VentaUnica', categoria: 'WISP', tipoItem: 'ARTICULO',
      precio: 8900, costo: 5800,
      productoSku: 'MK-HAPAX2',
    },
    {
      codigo: 'SRV-0003',
      nombre: 'Visita Técnica Diagnóstico (1 hora)',
      descripcion: 'Visita técnica especializada\n- 1 hora de servicio\n- Diagnóstico documentado\n- Recomendación escrita',
      tipo: 'Servicio', categoria: 'SoporteTecnico', tipoItem: 'SERVICIO',
      precio: 1500, costo: 600,
      productoSku: null,
    },
  ]

  for (const it of items) {
    const prod = it.productoSku ? productos[it.productoSku] : null
    await prisma.itemCatalogo.upsert({
      where:  { codigo: it.codigo },
      update: {
        nombre: it.nombre, descripcion: it.descripcion,
        tipo: it.tipo, categoria: it.categoria, tipoItem: it.tipoItem,
        precio: it.precio, costo: it.costo,
        productoId: prod?.id ?? null,
      },
      create: {
        codigo: it.codigo, nombre: it.nombre, descripcion: it.descripcion,
        tipo: it.tipo, categoria: it.categoria, tipoItem: it.tipoItem,
        precio: it.precio, costo: it.costo,
        productoId: prod?.id ?? null,
        activo: true,
      },
    })
  }
  console.log(`   ✅ ${items.length} items de catálogo`)
}

async function seedBundles(productos) {
  console.log('🔗 Bundles (cross-sell)...')
  // Si vendes una cámara → sugiere NVR + disco. NVR → disco. hAP → cable UTP.
  const pairs = [
    { padre: 'HK-DS-2CD2T47', hijo: 'HK-NVR-7616',    score: 9, motivo: 'NVR requerido para grabar la cámara' },
    { padre: 'HK-NVR-7616',   hijo: 'WD-PURPLE-4TB',  score: 10, motivo: 'Disco HDD vigilancia 24/7' },
    { padre: 'HK-NVR-7616',   hijo: 'CABLE-UTP-CAT6', score: 7, motivo: 'Cableado para cámaras IP' },
    { padre: 'MK-HAPAX2',     hijo: 'CABLE-UTP-CAT6', score: 6, motivo: 'Cable para extender la red' },
    { padre: 'SW-MK-CRS328',  hijo: 'PATCH-24P',      score: 8, motivo: 'Patch panel para rack' },
    { padre: 'SW-MK-CRS328',  hijo: 'CABLE-UTP-CAT6', score: 7, motivo: 'Cable UTP para puntos de red' },
  ]
  let n = 0
  for (const b of pairs) {
    const padre = productos[b.padre]; const hijo = productos[b.hijo]
    if (!padre || !hijo) continue
    await prisma.productoBundle.upsert({
      where:  { padreId_hijoId: { padreId: padre.id, hijoId: hijo.id } },
      update: { score: b.score, motivo: b.motivo },
      create: { padreId: padre.id, hijoId: hijo.id, score: b.score, motivo: b.motivo },
    })
    n++
  }
  console.log(`   ✅ ${n} bundles cross-sell`)
}

async function ensureClientes() {
  console.log('👥 Clientes (idempotente)...')
  const lista = [
    { noCliente: 'CLI-001', razonSocial: 'ServiCorp, S.R.L.', rnc: '101123456', tipoEmpresa: 'SRL', tipoCliente: 'Corporativo', nombreContacto: 'Luis', apellidoContacto: 'Fernández', telefonoPrincipal: '8094561234', email: 'ti@servicorp.do', direccion: 'Av. Winston Churchill #45', sector: 'Piantini', provincia: 'Santo Domingo', itbis: true, tipoNcf: 'Crédito Fiscal', limiteCredito: 150000, activo: true },
    { noCliente: 'CLI-002', razonSocial: 'Pedro Antonio Martínez', tipoEmpresa: 'Persona Física', tipoCliente: 'Residencial', cedula: '00112345678', nombreContacto: 'Pedro', apellidoContacto: 'Martínez', telefonoPrincipal: '8297651234', email: 'pedro.mtz@gmail.com', direccion: 'C/ Josefa #12', sector: 'Los Prados', provincia: 'Santo Domingo', itbis: false, tipoNcf: 'Consumidor Final', activo: true },
    { noCliente: 'CLI-003', razonSocial: 'Lucía M. Jiménez', tipoEmpresa: 'Persona Física', tipoCliente: 'Residencial', cedula: '00123456789', nombreContacto: 'Lucía', apellidoContacto: 'Jiménez', telefonoPrincipal: '8499871234', email: 'lucia.jimenez@gmail.com', direccion: 'Res. Las Américas, Bl. C', sector: 'Las Américas', provincia: 'Santo Domingo', itbis: false, tipoNcf: 'Consumidor Final', activo: true },
    { noCliente: 'CLI-004', razonSocial: 'Carlos Tejeda Vargas', tipoEmpresa: 'Persona Física', tipoCliente: 'Residencial', cedula: '00134567890', nombreContacto: 'Carlos', apellidoContacto: 'Tejeda', telefonoPrincipal: '8093452345', email: 'ctejeda@hotmail.com', direccion: 'Av. Independencia #220', sector: 'San Carlos', provincia: 'Santo Domingo', itbis: false, tipoNcf: 'Consumidor Final', activo: true },
    { noCliente: 'CLI-005', razonSocial: 'Distribuidora La Esperanza', rnc: '131987654', tipoEmpresa: 'SRL', tipoCliente: 'PYME', nombreContacto: 'Mariana', apellidoContacto: 'Polanco', telefonoPrincipal: '8095552233', email: 'compras@laesperanza.do', direccion: 'C/ El Conde #102', sector: 'Zona Colonial', provincia: 'Distrito Nacional', itbis: true, tipoNcf: 'Crédito Fiscal', limiteCredito: 75000, activo: true },
  ]
  const map = {}
  for (const c of lista) {
    const cli = await prisma.cliente.upsert({
      where: { noCliente: c.noCliente }, update: { activo: true },
      create: c,
    })
    map[c.noCliente] = cli
  }
  console.log(`   ✅ ${lista.length} clientes`)
  return map
}

async function seedKardex(productos) {
  console.log('📊 Kardex inicial (Entradas para justificar stockActual)...')
  let n = 0
  for (const sku of Object.keys(productos)) {
    const p = productos[sku]
    if (p.stockActual > 0) {
      await prisma.movimientoInventario.create({
        data: { productoId: p.id, tipo: 'Entrada', cantidad: p.stockActual, fecha: new Date(Date.now() - 30 * 86_400_000) },
      })
      n++
    }
  }
  console.log(`   ✅ ${n} entradas de kardex`)
}

async function seedCotizaciones(clientes) {
  console.log('📝 Cotizaciones distribuidas en Kanban...')
  const items = await prisma.itemCatalogo.findMany({ orderBy: { codigo: 'asc' } })
  if (items.length === 0) { console.log('   ⚠ Sin items, skip'); return }
  const itemCCTV = items.find(i => i.codigo === 'SRV-0001') || items[0]
  const itemRed  = items.find(i => i.codigo === 'SRV-0002') || items[1] || items[0]
  const itemWisp = items.find(i => i.codigo === 'REC-0001') || items[0]

  const cliArr = Object.values(clientes)
  const samples = [
    { cli: cliArr[0], etapa: 'Borrador',    itm: itemCCTV, qty: 1, dias: 1  },
    { cli: cliArr[1], etapa: 'Enviada',     itm: itemRed,  qty: 1, dias: 3  },
    { cli: cliArr[2], etapa: 'Negociacion', itm: itemCCTV, qty: 1, dias: 5  },
    { cli: cliArr[3], etapa: 'Negociacion', itm: itemWisp, qty: 1, dias: 7  },
    { cli: cliArr[4], etapa: 'Aceptada',    itm: itemCCTV, qty: 1, dias: 8  },
    { cli: cliArr[0], etapa: 'Aceptada',    itm: itemRed,  qty: 2, dias: 9  },
    { cli: cliArr[1], etapa: 'Perdida',     itm: itemCCTV, qty: 1, dias: 15 },
  ]
  let n = 0
  for (const s of samples) {
    if (!s.cli) continue
    const monto = Number(s.itm.precio) * s.qty
    const itbis = Math.round(monto * 0.18 * 100) / 100
    const total = Math.round((monto + itbis) * 100) / 100
    const fecha = new Date(Date.now() - s.dias * 86_400_000)
    const año = fecha.getFullYear()
    const seq = String(1000 + n).padStart(4, '0')
    await prisma.factura.create({
      data: {
        noFactura: `COT${año}-${seq}`,
        clienteId: s.cli.id,
        estado: 'Borrador', esCotizacion: true,
        etapaPipeline: s.etapa,
        subtotal: monto, itbis, total,
        tipoNcf: 'Consumidor Final',
        fechaEmision: fecha,
        fechaVence: new Date(fecha.getTime() + 15 * 86_400_000),
        notas: `Cotización demo · etapa ${s.etapa}`,
        condicionesDefault: undefined,
        lineas: { create: [{
          descripcion: s.itm.nombre, cantidad: s.qty,
          precioUnitario: Number(s.itm.precio),
        }] },
      },
    })
    n++
  }
  console.log(`   ✅ ${n} cotizaciones (${[...new Set(samples.map(s => s.etapa))].join(', ')})`)
}

async function seedFacturas(clientes) {
  console.log('💰 Facturas reales (varios estados + NCF)...')
  const items = await prisma.itemCatalogo.findMany({ orderBy: { codigo: 'asc' } })
  if (items.length === 0) return
  const cliArr = Object.values(clientes)

  // Consume secuencias NCF
  const ncfCfg = await prisma.configuracionNCF.findMany()
  const nextNcf = async (tipo) => {
    const cfg = ncfCfg.find(c => c.tipoNcf === tipo)
    if (!cfg) return null
    const seq = cfg.secuenciaActual
    cfg.secuenciaActual += 1
    await prisma.configuracionNCF.update({ where: { id: cfg.id }, data: { secuenciaActual: cfg.secuenciaActual } })
    return `${cfg.prefijo}${String(seq).padStart(8, '0')}`
  }

  const samples = [
    { cli: cliArr[0], itm: items[1], qty: 1, estado: 'Pagada',   tipoNcf: 'Crédito Fiscal',     dias: 25, applyItbis: true  },
    { cli: cliArr[0], itm: items[0], qty: 1, estado: 'Emitida',  tipoNcf: 'Crédito Fiscal',     dias: 6,  applyItbis: true  },
    { cli: cliArr[1], itm: items[2], qty: 1, estado: 'Pagada',   tipoNcf: 'Consumidor Final',   dias: 20, applyItbis: false },
    { cli: cliArr[2], itm: items[5] || items[0], qty: 1, estado: 'Pagada',   tipoNcf: 'Consumidor Final',   dias: 12, applyItbis: false },
    { cli: cliArr[3], itm: items[2], qty: 1, estado: 'Vencida',  tipoNcf: 'Consumidor Final',   dias: 45, applyItbis: false },
    { cli: cliArr[4], itm: items[1], qty: 1, estado: 'Anulada',  tipoNcf: 'Crédito Fiscal',     dias: 10, applyItbis: true  },
    { cli: cliArr[4], itm: items[0], qty: 1, estado: 'Emitida',  tipoNcf: 'Crédito Fiscal',     dias: 2,  applyItbis: true  },
  ]
  let n = 0
  for (const s of samples) {
    if (!s.cli || !s.itm) continue
    const monto = Number(s.itm.precio) * s.qty
    const itbis = s.applyItbis ? Math.round(monto * 0.18 * 100) / 100 : 0
    const total = Math.round((monto + itbis) * 100) / 100
    const fecha = new Date(Date.now() - s.dias * 86_400_000)
    const año = fecha.getFullYear()
    const ncf = await nextNcf(s.tipoNcf)
    const seq = String(2000 + n).padStart(4, '0')
    await prisma.factura.create({
      data: {
        noFactura: `FAC${año}-${seq}`,
        clienteId: s.cli.id,
        estado: s.estado, esCotizacion: false,
        etapaPipeline: 'Convertida',
        subtotal: monto, itbis, total,
        ncf, tipoNcf: s.tipoNcf,
        fechaEmision: fecha,
        fechaVence: new Date(fecha.getTime() + 30 * 86_400_000),
        fechaPago: s.estado === 'Pagada' ? new Date(fecha.getTime() + 7 * 86_400_000) : null,
        notas: `Factura demo seed · ${s.estado}`,
        lineas: { create: [{
          descripcion: s.itm.nombre, cantidad: s.qty,
          precioUnitario: Number(s.itm.precio),
        }] },
      },
    })
    n++
  }
  console.log(`   ✅ ${n} facturas`)
}

async function seedOTs(clientes) {
  console.log('🔧 Órdenes de Trabajo...')
  const cliArr = Object.values(clientes)
  // Toma el primer empleado disponible como técnico genérico.
  const tecnico = await prisma.empleado.findFirst()
  const samples = [
    { cli: cliArr[0], tipoOT: 'CCTV',           estado: 'Pendiente', notas: 'Instalación CCTV 16 cámaras' },
    { cli: cliArr[1], tipoOT: 'ISP',            estado: 'EnProceso', notas: 'Migración WISP 25Mbps → 100Mbps' },
    { cli: cliArr[2], tipoOT: 'Reparacion',     estado: 'Completada', notas: 'Reparación router MikroTik' },
    { cli: cliArr[3], tipoOT: 'CercoElectrico', estado: 'Pendiente', notas: 'Cotizado cerco 4 zonas' },
    { cli: cliArr[4], tipoOT: 'VentaDirecta',   estado: 'EnProceso', notas: 'Despacho switch + cableado' },
  ]
  let n = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (!s.cli) continue
    const año = new Date().getFullYear()
    await prisma.ordenTrabajo.create({
      data: {
        noOT: `OT${año}-${String(3000 + i).padStart(4, '0')}`,
        clienteId: s.cli.id,
        tecnicoId: tecnico?.id ?? null,
        tipoOT:    s.tipoOT,
        estado:    s.estado,
        notasTecnicas: s.notas,
        metadatos: {},
        fechaVencimientoSLA: new Date(Date.now() + (s.estado === 'Pendiente' ? 7 : 0) * 86_400_000),
        completadaEn: s.estado === 'Completada' ? new Date(Date.now() - 2 * 86_400_000) : null,
      },
    })
    n++
  }
  console.log(`   ✅ ${n} órdenes de trabajo`)
}

async function main() {
  if (!CONFIRM) {
    console.error('⛔  ABORT — corre con CONFIRM_PURGE=1 (variable env) o --yes (flag).')
    console.error('   Ejemplo:  CONFIRM_PURGE=1 node prisma/seed-purge-realistic.js')
    process.exit(1)
  }
  console.log('───────────────────────────────────────────────')
  console.log('ACR ERP · GREAT PURGE & REALISTIC SEED')
  console.log('───────────────────────────────────────────────')
  const t0 = Date.now()
  await ensureSchema()
  await purge()
  await seedEmpresa()
  await seedNcfConfig()
  const cats      = await seedCategorias()
  const productos = await seedProductos(cats)
  await seedCatalogo(productos)
  await seedBundles(productos)
  const clientes = await ensureClientes()
  await seedKardex(productos)
  await seedCotizaciones(clientes)
  await seedFacturas(clientes)
  await seedOTs(clientes)
  console.log(`───────────────────────────────────────────────`)
  console.log(`✅ SEED OK en ${Date.now() - t0}ms`)
  console.log(`   PIN supervisor inicial: ${process.env.PIN_INICIAL ?? '1234'}`)
  console.log(`   Cambiar PIN en /empresa después del primer login.`)
}

main()
  .catch(e => { console.error('❌ SEED FAIL', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
