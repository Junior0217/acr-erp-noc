/**
 * Reconciliación anti-fraude diaria.
 *
 * Cruza Kardex (MovimientoInventario) vs OrdenTrabajo vs Factura y detecta:
 *   - ROBO_EQUIPO:        Salida del Kardex SIN OT que la justifique.
 *   - FUGA_EFECTIVO:      OT cerrada hace > 7 días sin Factura emitida.
 *   - DISCREPANCIA_STOCK: Producto.stockActual no coincide con suma de movimientos.
 *
 * Registra incidencias en IncidenciaReconciliacion.
 * Idempotente: usa datos JSON para detectar duplicados antes de insertar.
 *
 * Uso:
 *   node backend/scripts/reconciliar.js
 *   node backend/scripts/reconciliar.js --days=14   (ventana de revisión)
 *   node backend/scripts/reconciliar.js --silent
 */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const args = process.argv.slice(2)
const daysArg = args.find(a => a.startsWith('--days='))
const VENTANA_DIAS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30
const SILENT = args.includes('--silent')
const DRY_RUN = args.includes('--dry-run')
const log = (...a) => { if (!SILENT) console.log(...a) }

const desde = new Date(Date.now() - VENTANA_DIAS * 86_400_000)

async function dejaHuella(tipo, hashKey) {
  // Evita insertar la misma incidencia dos veces dentro de la ventana.
  const existing = await p.incidenciaReconciliacion.findFirst({
    where: {
      tipo,
      resueltoEn: null,
      createdAt:  { gte: desde },
      datos:      { path: ['_hash'], equals: hashKey },
    },
  })
  return !!existing
}

async function registrarIncidencia({ tipo, severidad = 'ALTA', descripcion, datos, hashKey }) {
  if (await dejaHuella(tipo, hashKey)) return false
  if (DRY_RUN) { log(`  [DRY] ${tipo} :: ${descripcion}`); return true }
  await p.incidenciaReconciliacion.create({
    data: { tipo, severidad, descripcion, datos: { ...datos, _hash: hashKey } },
  })
  return true
}

// ── 1. ROBO_EQUIPO: Salidas de Kardex sin OT que las justifique ─────────────
async function detectarRobos() {
  log('\n► ROBO_EQUIPO (Kardex Salida sin OT)')
  const salidas = await p.movimientoInventario.findMany({
    where: { tipo: 'Salida', fecha: { gte: desde }, ordenInstalacionId: null },
    include: { producto: { select: { sku: true, nombre: true } } },
  })

  // Verifica también que no exista una OrdenTrabajo cerrada con ese producto en la misma fecha
  let detectadas = 0
  for (const mov of salidas) {
    const tieneOT = await p.lineaOrdenTrabajo.findFirst({
      where: {
        productoId: mov.productoId,
        cantidad:   { gte: mov.cantidad },
        orden: {
          estado:    { in: ['Cerrada', 'EnProceso'] },
          createdAt: { gte: new Date(mov.fecha.getTime() - 2 * 86_400_000), lte: new Date(mov.fecha.getTime() + 2 * 86_400_000) },
        },
      },
    })
    if (tieneOT) continue
    const inserted = await registrarIncidencia({
      tipo: 'ROBO_EQUIPO',
      severidad: 'CRITICA',
      descripcion: `Salida de "${mov.producto.nombre}" (${mov.cantidad} unid.) del Kardex sin OT vinculada el ${mov.fecha.toISOString().slice(0, 10)}.`,
      datos: { movimientoId: mov.id, productoId: mov.productoId, sku: mov.producto.sku, cantidad: mov.cantidad, fecha: mov.fecha },
      hashKey: `mov-${mov.id}`,
    })
    if (inserted) detectadas++
  }
  log(`  ✓ ${detectadas} incidencia(s) nueva(s) registrada(s).`)
}

// ── 2. FUGA_EFECTIVO: OTs cerradas hace > 7 días sin Factura ────────────────
async function detectarFugas() {
  log('\n► FUGA_EFECTIVO (OT cerrada > 7 días sin Factura)')
  const limite = new Date(Date.now() - 7 * 86_400_000)
  const ots = await p.ordenTrabajo.findMany({
    where: {
      deletedAt:    null,
      estado:       'Cerrada',
      estaFacturada: false,
      completadaEn: { lt: limite, gte: desde },
    },
    select: { id: true, noOT: true, completadaEn: true, cliente: { select: { razonSocial: true } }, tecnico: { select: { nombre: true } } },
  })
  let detectadas = 0
  for (const ot of ots) {
    const inserted = await registrarIncidencia({
      tipo: 'FUGA_EFECTIVO',
      severidad: 'ALTA',
      descripcion: `OT ${ot.noOT} (cliente ${ot.cliente?.razonSocial}) cerrada el ${ot.completadaEn?.toISOString().slice(0, 10)} SIN factura emitida. Técnico: ${ot.tecnico?.nombre ?? 'sin asignar'}.`,
      datos: { otId: ot.id, noOT: ot.noOT, tecnico: ot.tecnico?.nombre, cliente: ot.cliente?.razonSocial, cerradaEn: ot.completadaEn },
      hashKey: `ot-${ot.id}`,
    })
    if (inserted) detectadas++
  }
  log(`  ✓ ${detectadas} incidencia(s) nueva(s) registrada(s).`)
}

// ── 3. DISCREPANCIA_STOCK: stockActual != suma de movimientos ──────────────
async function detectarDiscrepancias() {
  log('\n► DISCREPANCIA_STOCK (Producto.stockActual vs Kardex)')
  const productos = await p.producto.findMany({
    select: { id: true, sku: true, nombre: true, stockActual: true, movimientos: { select: { tipo: true, cantidad: true } } },
  })
  let detectadas = 0
  for (const prod of productos) {
    const entradas = prod.movimientos.filter(m => m.tipo === 'Entrada').reduce((s, m) => s + m.cantidad, 0)
    const salidas  = prod.movimientos.filter(m => m.tipo === 'Salida').reduce((s, m) => s + m.cantidad, 0)
    const balance  = entradas - salidas
    if (balance === prod.stockActual) continue
    const inserted = await registrarIncidencia({
      tipo: 'DISCREPANCIA_STOCK',
      severidad: Math.abs(balance - prod.stockActual) > 5 ? 'CRITICA' : 'MEDIA',
      descripcion: `Producto "${prod.nombre}" (${prod.sku}): stockActual=${prod.stockActual}, balance Kardex=${balance}, diferencia=${prod.stockActual - balance}.`,
      datos: { productoId: prod.id, sku: prod.sku, stockActual: prod.stockActual, balanceKardex: balance },
      hashKey: `prod-${prod.id}-${prod.stockActual}-${balance}`,
    })
    if (inserted) detectadas++
  }
  log(`  ✓ ${detectadas} incidencia(s) nueva(s) registrada(s).`)
}

;(async () => {
  log(`══ RECONCILIACION ACR (ventana ${VENTANA_DIAS} días, desde ${desde.toISOString().slice(0, 10)})`)
  if (DRY_RUN) log('  [MODO DRY-RUN: nada se persiste]')
  await detectarRobos()
  await detectarFugas()
  await detectarDiscrepancias()
  const pendientes = await p.incidenciaReconciliacion.count({ where: { resueltoEn: null } })
  log(`\n══ TOTAL incidencias pendientes en sistema: ${pendientes}`)
  await p.$disconnect()
})().catch(e => { console.error('[RECONCILIAR ERROR]', e); process.exit(1) })
