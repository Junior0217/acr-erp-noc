/**
 * backend/modules/ventas/_cron.js
 *
 * CRON jobs propios del modulo ventas. Idempotente — solo registra una vez.
 */

const cron = require('node-cron');

let _registered = false;

module.exports = function registerVentasCron(deps, lib) {
  if (_registered) return;
  _registered = true;
  const { prisma, auditReq, generarPdfDeFactura, subirPdfAlStorage, sendFacturaPDF, emailTransporter } = deps;
  const { buildFacturaPDFBuffer, nextNomenclatura } = lib;

// ─── WISP Auto-Biller Cron ────────────────────────────────────────────────────

async function billarOTsISP() {
  const hoy = new Date()
  const diaHoy = hoy.getDate()
  console.log(`[CRON WISP] Iniciando facturación automática para día de corte: ${diaHoy}`)
  let facturadas = 0, errores = 0

  try {
    // Fetch ISP OTs activas cuyo diaCorte en metadatos == hoy
    const ots = await prisma.$queryRaw`
      SELECT ot.id, ot."clienteId", ot.metadatos
      FROM   "OrdenTrabajo" ot
      WHERE  ot."tipoOT" = 'ISP'
        AND  ot."estado"  = 'Activo'
        AND  (
          (ot.metadatos->>'diaCorte')::int = ${diaHoy}
          OR ot."diaCorte" = ${diaHoy}
        )
    `

    for (const ot of ots) {
      try {
        await prisma.$transaction(async (tx) => {
          // Idempotency — no double-bill same OT same day
          const existing = await tx.factura.findFirst({
            where: {
              ordenId:      ot.id,
              fechaEmision: { gte: new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) },
            },
          })
          if (existing) return

          const otFull = await tx.ordenTrabajo.findUnique({
            where:   { id: ot.id },
            include: { cliente: true, lineas: true },
          })
          if (!otFull || !otFull.lineas.length) return

          const tipoNcf = otFull.cliente.tipoNcf ?? 'Consumidor Final'
          const rows = await tx.$queryRaw`
            UPDATE "ConfiguracionNCF"
            SET    "secuenciaActual" = "secuenciaActual" + 1
            WHERE  "tipoNcf"         = ${tipoNcf}
              AND  "activo"          = true
              AND  "secuenciaActual" < "limite"
              AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
            RETURNING *
          `
          if (!rows || rows.length === 0) throw new Error(`Sin NCF disponible para tipo ${tipoNcf}`)

          const seq       = String(rows[0].secuenciaActual).padStart(8, '0')
          const ncf       = `${rows[0].prefijo}${seq}`
          const noFactura = await generarSiguienteCodigo('factura', tx)
          const subtotal  = otFull.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0)
          const itbis     = otFull.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
          const total     = Math.round((subtotal + itbis) * 100) / 100

          return tx.factura.create({
            data: {
              noFactura,
              clienteId:  otFull.clienteId,
              ordenId:    otFull.id,
              estado:     'Emitida',
              subtotal,
              itbis,
              total,
              ncf,
              tipoNcf,
              fechaVence: new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000),
            },
          })
        }).then(async (facturaCreada) => {
          // Hash post-commit: persistirVerifyHash usa el prisma global y necesita
          // que la row ya esté visible para findUnique (read committed).
          if (facturaCreada?.id) await persistirVerifyHash(facturaCreada)
        })
        facturadas++
      } catch (err) {
        errores++
        console.error(`[CRON WISP] Error en OT ${ot.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[CRON WISP] Error fatal:', err.message)
  }

  console.log(`[CRON WISP] Completado. Facturadas: ${facturadas}, Errores: ${errores}`)
}

cron.schedule('5 0 * * *', billarOTsISP, { timezone: 'America/Santo_Domingo' })

async function billarMoras() {
  const hoy = new Date()
  console.log(`[CRON MORA] Revisando facturas vencidas al ${hoy.toLocaleDateString('es-DO')}`)
  try {
    // Fetch ISP OT IPs before bulk update so we can sync MikroTik after
    const afectadas = await prisma.factura.findMany({
      where: { estado: 'Emitida', fechaVence: { lt: hoy } },
      select: { id: true, orden: { select: { tipoOT: true, metadatos: true } } },
    })

    const { count } = await prisma.factura.updateMany({
      where: { estado: 'Emitida', fechaVence: { lt: hoy } },
      data:  { estado: 'Vencida' },
    })
    if (count > 0) console.log(`[CRON MORA] ${count} factura(s) marcadas como Vencida.`)

    // Sync MikroTik for each ISP client that just went moroso
    setImmediate(async () => {
      for (const f of afectadas) {
        if (f.orden?.tipoOT === 'ISP') {
          const ip = f.orden.metadatos?.ip
          if (ip) await syncMikrotik(ip, 'moroso').catch(e => console.error('[MIKROTIK MORA]', e.message))
        }
      }
    })
  } catch (err) {
    console.error('[CRON MORA] Error:', err.message)
  }
}

cron.schedule('10 0 * * *', billarMoras, { timezone: 'America/Santo_Domingo' })



// ─── Pre-render asíncrono de PDFs (latencia cero) ────────────────────────────
// Cada 5 min escanea facturas/cotizaciones de los últimos 7 días con pdfUrl IS NULL
// y las renderiza en background. Cuando el usuario clickea "Ver PDF" después,
// el cache hit es 100% — Puppeteer ni se invoca, redirect directo a Supabase.
//
// Guardrails:
//   - Lock single-flight (_pdfCronRunning) evita overlap si el render se demora.
//   - Cap por corrida (15 documentos máx) — evita saturar Render Free Tier.
//   - Concurrency 2 dentro de la corrida — el page pool tiene 2 páginas idle.
//   - Skip si SUPABASE_STORAGE no configurado (sin destino válido).
let _pdfCronRunning = false
const PDF_PRERENDER_BATCH    = 15
const PDF_PRERENDER_CONCURRENCY = 2

// H11: máximo 5 intentos por factura para evitar romper el batch entero por una
// fila tóxica (data corruption, assets gigantes, infinite-loop en HTML inválido).
const PDF_PRERENDER_MAX_ATTEMPTS = 5

async function prerenderPdfsBatch() {
  if (_pdfCronRunning) return
  if (!supabase)       return
  _pdfCronRunning = true
  const t0 = Date.now()
  let ok = 0, fail = 0, skipped = 0
  try {
    const desde = new Date(Date.now() - 7 * 86_400_000)
    const candidatos = await prisma.factura.findMany({
      where:  {
        pdfUrl: null,
        deletedAt: null,
        fechaEmision: { gte: desde },
        // H11: excluye filas que ya rebasaron el umbral de intentos.
        pdfRenderAttempts: { lt: PDF_PRERENDER_MAX_ATTEMPTS },
      },
      select: { id: true, esCotizacion: true, noFactura: true, pdfRenderAttempts: true },
      orderBy: [{ pdfRenderAttempts: 'asc' }, { fechaEmision: 'desc' }],
      take:   PDF_PRERENDER_BATCH,
    })
    if (candidatos.length === 0) return

    async function renderOne(c) {
      try {
        const f = await prisma.factura.findUnique({
          where:   { id: c.id },
          include: {
            cliente:       true,
            lineas:        { include: { producto: { select: { sku: true, nombre: true } } } },
            facturaOrigen: { select: { noFactura: true, ncf: true, tipoNcf: true } },
          },
        })
        if (!f || f.deletedAt) return
        // M8: snapshot del timestamp de invalidación ANTES de rendrir.
        const invalidatedAtBefore = f.pdfInvalidatedAt
        const data    = await buildPdfData(f)
        const tipo    = f.esCotizacion ? 'cotizacion'
                       : f.esNotaCredito ? 'nota-credito'
                       : f.esNotaDebito  ? 'nota-debito'
                       : 'factura'
        const html    = renderPdfDoc({ tipo, numero: f.noFactura, ...data })
        const pdfBuf  = await generarPdfDocumento(html)

        // M8: re-check pdfInvalidatedAt — si cambió mid-flight, otra ruta mutó
        // la factura y nuestro PDF es OBSOLETO. Descartar sin subir/persistir.
        const reFetch = await prisma.factura.findUnique({
          where: { id: f.id },
          select: { pdfInvalidatedAt: true, deletedAt: true },
        })
        if (reFetch?.deletedAt) return
        if (reFetch?.pdfInvalidatedAt && (!invalidatedAtBefore || reFetch.pdfInvalidatedAt > invalidatedAtBefore)) {
          console.warn(`[PDF CRON] ${c.noFactura} invalidated mid-render — descartando.`)
          return
        }

        const url = await subirPdfAlStorage(pdfBuf, f)
        if (url) {
          // Render OK: pdfUrl set, attempts no se incrementa (queda donde estaba).
          // updateMany con WHERE pdfInvalidatedAt sin cambio -> CAS final atómico.
          const r = await prisma.factura.updateMany({
            where: {
              id: f.id,
              OR: [
                { pdfInvalidatedAt: null },
                { pdfInvalidatedAt: invalidatedAtBefore ?? new Date(0) },
              ],
            },
            data: { pdfUrl: url },
          })
          if (r.count === 0) {
            console.warn(`[PDF CRON] ${c.noFactura} CAS rechazó update — invalidación tardía.`)
          }
          ok++
        } else {
          // Upload falló pero el render OK - cuenta como fail e incrementa attempts.
          await prisma.factura.update({ where: { id: f.id }, data: { pdfRenderAttempts: (c.pdfRenderAttempts ?? 0) + 1 } }).catch(() => {})
          fail++
        }
      } catch (e) {
        console.error(`[PDF CRON] ${c.noFactura} (attempt ${(c.pdfRenderAttempts ?? 0) + 1}/${PDF_PRERENDER_MAX_ATTEMPTS}):`, e.message)
        // Incrementa contador: el siguiente batch puede saltarse esta fila si supera el umbral.
        await prisma.factura.update({
          where: { id: c.id },
          data:  { pdfRenderAttempts: (c.pdfRenderAttempts ?? 0) + 1 },
        }).catch(() => {})
        if ((c.pdfRenderAttempts ?? 0) + 1 >= PDF_PRERENDER_MAX_ATTEMPTS) {
          console.warn(`[PDF CRON] ${c.noFactura} ALCANZÓ ${PDF_PRERENDER_MAX_ATTEMPTS} intentos. Excluida hasta reset manual.`)
          skipped++
        }
        fail++
      }
    }

    // Worker pool simple: N workers tomando del cursor.
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(PDF_PRERENDER_CONCURRENCY, candidatos.length) }, async () => {
        while (cursor < candidatos.length) {
          const idx = cursor++
          await renderOne(candidatos[idx])
        }
      })
    )

    console.log(`[PDF CRON] batch ${candidatos.length} docs en ${Date.now() - t0}ms · ok=${ok} fail=${fail} dead=${skipped}`)
  } catch (e) {
    console.error('[PDF CRON]', e.message)
  } finally {
    _pdfCronRunning = false
  }
}

// */5 * * * *  →  cada 5 min en TZ de RD.
cron.schedule('*/5 * * * *', prerenderPdfsBatch, { timezone: 'America/Santo_Domingo' })



};
