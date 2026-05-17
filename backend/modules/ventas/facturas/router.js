/**
 * backend/modules/ventas/facturas/router.js
 *
 * Auto-extraido de routes/ventas.js (Stage 4 split DDD).
 * Factory recibe deps + helpers compartidos del modulo padre.
 */

const express   = require('express');
const { z }     = require('zod');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const QRCode    = require('qrcode');
const util      = require('util');
const { authenticator } = require('otplib');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');
const { wrapJWT, unwrapJWT, encryptTOTP, decryptTOTP, PORTAL_JWT_SECRET } = require('../../../shared/jwt-crypto');
let archiver = null; try { archiver = require('archiver'); } catch {}

function makeRateLimitStore() { return undefined; }

const stripTags = v => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;
const descripcionEstructuradaSchema = z.object({
  v:         z.literal(1),
  titulo:    z.string().min(1).max(200),
  bullets:   z.array(z.string().min(1).max(200)).max(30).default([]),
  imagenUrl: z.string().max(500).nullable().optional(),
});
const descripcionFlexSchema = z.union([
  z.string().max(2000),
  descripcionEstructuradaSchema,
]).nullable().optional();
function descripcionToRaw(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.v === 1) {
    return JSON.stringify({
      v: 1,
      titulo:    String(value.titulo ?? '').slice(0, 200),
      bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
      imagenUrl: value.imagenUrl ? String(value.imagenUrl).slice(0, 500) : null,
    });
  }
  return null;
}

function createFacturasRouter(deps) {
  const router = express.Router();

  const {
    prisma, auditReq, middlewares = {}, schemas = {}, helpers = {}, limiters = {},
    twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
    generarSiguienteCodigo, generarPdfDeFactura, buildPdfData, subirPdfAlStorage,
    invalidarPdfCache, renderPdfDoc, generarPdfDocumento, persistirVerifyHash,
    facturaVerifyHash, PUBLIC_VERIFY_BASE, emailTransporter, sendFacturaPDF,
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt,
    supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, OT_FOTOS_BUCKET,
    KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
    detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
    signPortalToken, NIVEL_PROPIETARIO_ABSOLUTO, protegerPropietario,
    SECUENCIA_DEFAULTS,
    nextNomenclatura, buildFacturaPDFBuffer,
  } = deps;
  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTPEstricto, vaultCooldownGuard,
  } = middlewares;
  const {
    passwordSchema, empleadoSchema, asistenciaSchema,
    clienteSchema, suplidorSchema, prospectoSchema,
  } = schemas;
  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, getClientIp, reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
    nullStr, optIdent, emptyStr, optCedulaRD,
  } = helpers;
  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) ==================================
// ─── Reversión Admin (God Mode) — solo sistema:owner ──────────────────────────
// Permite revertir una factura Pagada/Anulada de vuelta a Borrador en caso de
// error humano. Restaura stock si la factura tenía líneas de Producto físico.
// SIEMPRE registra un AuditCaja tipo factura:revertida con quién, cuándo, motivo.
router.post('/facturas/:id/revertir', verificarJWT, billingLimiter, requerirPermiso('sistema:owner'), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const motivo = String(req.body?.motivo ?? '').slice(0, 500)
    if (!motivo || motivo.length < 10) {
      return res.status(400).json({ error: 'Motivo requerido (mínimo 10 caracteres) para reversión.', code: 'MOTIVO_REQUIRED' })
    }
    const existing = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { lineas: { include: { producto: { select: { id: true, tipoItem: true } } } } },
    })
    if (!existing) return res.status(404).json({ error: 'Factura no encontrada.' })
    if (!['Pagada', 'Anulada'].includes(existing.estado)) {
      return res.status(409).json({ error: `No se puede revertir factura en estado ${existing.estado}.` })
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // Si la factura estaba Pagada, restauramos stock de líneas físicas (la salida
      // había ocurrido al emitir). Si estaba Anulada, NO restauramos (el stock ya
      // volvió cuando se anuló, o nunca se descontó si la factura no llegó a Pagada).
      let stockRestaurado = 0
      if (existing.estado === 'Pagada') {
        for (const l of existing.lineas) {
          if (l.productoId && l.producto?.tipoItem !== 'SERVICIO' && Number(l.cantidad) > 0) {
            await tx.producto.update({
              where: { id: l.productoId },
              data:  { stockActual: { increment: l.cantidad } },
            })
            await tx.movimientoInventario.create({
              data: { productoId: l.productoId, tipo: 'Entrada', cantidad: l.cantidad },
            })
            stockRestaurado++
          }
        }
      }
      const updated = await tx.factura.update({
        where: { id: existing.id },
        data:  { estado: 'Borrador', fechaPago: null, pdfUrl: null, pdfInvalidatedAt: new Date() },
      })
      return { updated, stockRestaurado }
    })

    auditReq('factura:revertida_god_mode', req, { facturaId: existing.id, estadoAnterior: existing.estado, motivo, stockRestaurado: resultado.stockRestaurado })
    // Append-only audit con hash chain — la reversión es operación crítica que
    // exige trazabilidad inmutable verificable post-facto.
    await appendAuditCaja({
      tipo:       'factura_revertida',
      empleadoId: req.user?.sub ?? null,
      facturaId:  existing.id,
      monto:      Number(existing.total),
      detalle:    `God Mode: ${existing.estado} → Borrador. Stock restaurado: ${resultado.stockRestaurado}. Motivo: ${motivo}`,
      ip:         req.ip,
      ua:         (req.headers['user-agent'] ?? '').slice(0, 200),
    }).catch(() => {})
    res.json({ ok: true, factura: resultado.updated, stockRestaurado: resultado.stockRestaurado })
  } catch (e) {
    console.error('[FACTURA REVERTIR]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Notas de Crédito (DGII B04) ──────────────────────────────────────────────
// Emite una Nota de Crédito que ANULA por completo una factura origen y revierte
// su impacto (stock + estado). El documento resultante es una Factura con:
//   - esNotaCredito = true
//   - facturaOrigenId apuntando a la factura modificada
//   - ncf  = secuencia DGII B04 (auto-upsert si la fila ConfiguracionNCF no existe)
//   - noFactura = secuencia interna 'NC-000001' vía generarSiguienteCodigo('notaCredito')
//   - subtotal/itbis/total como NEGATIVOS conceptuales (almacenamos positivos pero
//     el PDF imprime "Nota de Crédito" y la factura origen queda Anulada).
//
// Autorización:
//   - Permiso 'factura:anular' o 'sistema:owner'.
//   - pinSupervisor (EmpresaPerfil.pinSupervisor) obligatorio en body.
//   - motivo mínimo 10 caracteres (queda en motivoNotaModificatoria + AuditCaja).
//
// El stock se RESTAURA solo si la factura origen estaba en 'Pagada' (mismo
// criterio que /revertir): si estaba Emitida, el stock nunca salió.
const notaCreditoSchema = z.object({
  motivo:        z.string().min(10, 'Motivo de mínimo 10 caracteres.').max(500),
  pinSupervisor: z.string().min(4).max(8).regex(/^\d+$/, 'PIN solo dígitos.'),
})

router.post('/facturas/:id/nota-credito', verificarJWT, billingLimiter, async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const puedeAnular = permisos.includes('sistema:owner') || permisos.includes('factura:anular')
    if (!puedeAnular) {
      auditReq('nc:denied_perm', req, { facturaId: req.params.id })
      return res.status(403).json({ error: 'Emitir Nota de Crédito requiere permiso "factura:anular".', code: 'NC_PERMISSION' })
    }

    const parsed = notaCreditoSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos.' })
    }
    const { motivo, pinSupervisor } = parsed.data

    const empCfg = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } })
    const pinReal = empCfg?.pinSupervisor ?? '1234'
    if (pinSupervisor !== pinReal) {
      auditReq('nc:pin_fail', req, { facturaId: req.params.id })
      return res.status(401).json({ error: 'PIN de supervisor inválido.', code: 'NC_PIN_INVALID' })
    }

    const origen = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { lineas: { include: { producto: { select: { id: true, tipoItem: true } } } } },
    })
    if (!origen)                         return res.status(404).json({ error: 'Factura origen no encontrada.' })
    if (origen.esCotizacion)             return res.status(409).json({ error: 'No se puede emitir NC sobre una cotización.' })
    if (origen.esNotaCredito)            return res.status(409).json({ error: 'No se puede emitir NC sobre otra Nota de Crédito.' })
    if (origen.esNotaDebito)             return res.status(409).json({ error: 'No se puede emitir NC sobre una Nota de Débito (emite NC contra la factura original).' })
    if (origen.estado === 'Anulada')     return res.status(409).json({ error: 'La factura origen ya está Anulada.' })
    if (origen.estado === 'Borrador')    return res.status(409).json({ error: 'La factura origen aún está en Borrador, no requiere NC.' })

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Secuencia NCF B04 — atomic upsert + increment.
      //    Si la fila no existe, la creamos con prefijo B04 / límite 99,999,999.
      await tx.$executeRaw`
        INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
        VALUES ('B04', 'Nota de Crédito', 'Notas de Crédito (DGII B04)', 0, 99999999, true, NOW(), NOW())
        ON CONFLICT ("tipoNcf") DO NOTHING
      `
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = 'Nota de Crédito'
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
        RETURNING *
      `
      if (!rows || rows.length === 0) {
        throw Object.assign(new Error('Secuencia NCF B04 agotada o inactiva. Revisa Configuración > Secuencias NCF.'), { status: 422 })
      }
      const seq        = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncfNC      = `${rows[0].prefijo}${seq}`
      const noFacturaNC = await generarSiguienteCodigo('notaCredito', tx)

      // 2. Restaurar stock SOLO si la origen estaba Pagada (la salida había ocurrido).
      let stockRestaurado = 0
      if (origen.estado === 'Pagada') {
        for (const l of origen.lineas) {
          if (l.productoId && l.producto?.tipoItem !== 'SERVICIO' && Number(l.cantidad) > 0) {
            await tx.producto.update({ where: { id: l.productoId }, data: { stockActual: { increment: l.cantidad } } })
            await tx.movimientoInventario.create({ data: { productoId: l.productoId, tipo: 'Entrada', cantidad: l.cantidad } })
            stockRestaurado++
          }
        }
      }

      // 3. Crear la Nota de Crédito como Factura(esNotaCredito=true).
      //    Copia las mismas líneas de la origen (totales idénticos en magnitud).
      //    El estado inicial es 'Emitida' — no requiere flujo de cobro.
      const nc = await tx.factura.create({
        data: {
          noFactura:         noFacturaNC,
          clienteId:         origen.clienteId,
          ordenId:           origen.ordenId,
          empleadoId:        req.user?.sub ?? null,
          estado:            'Emitida',
          subtotal:          origen.subtotal,
          itbis:             origen.itbis,
          total:             origen.total,
          ncf:               ncfNC,
          tipoNcf:           'Nota de Crédito',
          fechaEmision:      new Date(),
          fechaVence:        null,
          esNotaCredito:           true,
          facturaOrigenId:         origen.id,
          motivoNotaModificatoria: motivo,
          notas:                   `Anula a ${origen.noFactura}${origen.ncf ? ` (NCF ${origen.ncf})` : ''}. Motivo: ${motivo}`,
          lineas: {
            create: origen.lineas.map(l => ({
              productoId:          l.productoId ?? null,
              descripcion:         l.descripcion,
              cantidad:            l.cantidad,
              precioUnitario:      l.precioUnitario,
              descuentoPorcentaje: l.descuentoPorcentaje,
              descuentoMonto:      l.descuentoMonto,
            })),
          },
        },
      })

      // 4. Anular la factura origen + invalidar cache PDF.
      const origenAnulada = await tx.factura.update({
        where: { id: origen.id },
        data:  { estado: 'Anulada', pdfUrl: null, pdfInvalidatedAt: new Date() },
      })

      return { nc, origenAnulada, stockRestaurado }
    })

    invalidarPdfCache(resultado.nc.id).catch(() => {})
    invalidarPdfCache(resultado.origenAnulada.id).catch(() => {})

    auditReq('nc:emitida', req, {
      ncId:          resultado.nc.id,
      ncfNC:         resultado.nc.ncf,
      origenId:      origen.id,
      ncfOrigen:     origen.ncf,
      total:         Number(origen.total),
      stockRestaurado: resultado.stockRestaurado,
      motivo,
    })
    await appendAuditCaja({
      tipo:       'nota_credito_emitida',
      empleadoId: req.user?.sub ?? null,
      facturaId:  resultado.nc.id,
      monto:      Number(origen.total),
      detalle:    `NC ${resultado.nc.ncf} anula a ${origen.noFactura} (NCF ${origen.ncf ?? '—'}). Stock restaurado: ${resultado.stockRestaurado}. Motivo: ${motivo}`,
      ip:         req.ip,
      ua:         (req.headers['user-agent'] ?? '').slice(0, 200),
    }).catch(() => {})

    res.status(201).json({
      ok: true,
      notaCredito: resultado.nc,
      origen:      resultado.origenAnulada,
      stockRestaurado: resultado.stockRestaurado,
    })
  } catch (e) {
    console.error('[NC EMITIR]', e.status ?? 500, e.message)
    res.status(e.status ?? 500).json({ error: e.message ?? 'Error interno emitiendo Nota de Crédito.' })
  }
})

// ─── Notas de Débito (DGII B03) ──────────────────────────────────────────────
// Emite una Nota de Débito que AÑADE un cargo adicional contra una factura
// origen (penalidad, interés por mora, ajuste de precio al alza). A diferencia
// de la NC:
//   - NO restaura inventario (no hubo devolución física de mercancía).
//   - NO anula la factura origen — solo la vincula vía facturaOrigenId.
//   - El monto a cobrar es INPUT del usuario (no copia los totales del origen).
//   - Una sola línea descriptiva con el motivo + monto.
//
// El estado inicial es 'Emitida' — el cliente debe pagarla como un cargo extra.
const notaDebitoSchema = z.object({
  motivo:        z.string().min(10, 'Motivo de mínimo 10 caracteres.').max(500),
  pinSupervisor: z.string().min(4).max(8).regex(/^\d+$/, 'PIN solo dígitos.'),
  monto:         z.number().positive('El monto debe ser positivo.').max(99999999),
  aplicarItbis:  z.boolean().optional().default(false),
})

router.post('/facturas/:id/nota-debito', verificarJWT, billingLimiter, async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    // Usa el mismo permiso 'factura:anular' (umbral correcto para emitir
    // comprobantes modificatorios fiscales). Si quieres separarlo a futuro,
    // crea 'factura:nota_debito'.
    const puede = permisos.includes('sistema:owner') || permisos.includes('factura:anular')
    if (!puede) {
      auditReq('nd:denied_perm', req, { facturaId: req.params.id })
      return res.status(403).json({ error: 'Emitir Nota de Débito requiere permiso "factura:anular".', code: 'ND_PERMISSION' })
    }

    const parsed = notaDebitoSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos.' })
    }
    const { motivo, pinSupervisor, monto, aplicarItbis } = parsed.data

    const empCfg = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } })
    const pinReal = empCfg?.pinSupervisor ?? '1234'
    if (pinSupervisor !== pinReal) {
      auditReq('nd:pin_fail', req, { facturaId: req.params.id })
      return res.status(401).json({ error: 'PIN de supervisor inválido.', code: 'ND_PIN_INVALID' })
    }

    const origen = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      select:  { id: true, noFactura: true, ncf: true, clienteId: true, ordenId: true, estado: true, esCotizacion: true, esNotaCredito: true, esNotaDebito: true },
    })
    if (!origen)                      return res.status(404).json({ error: 'Factura origen no encontrada.' })
    if (origen.esCotizacion)          return res.status(409).json({ error: 'No se puede emitir ND sobre una cotización.' })
    if (origen.esNotaCredito)         return res.status(409).json({ error: 'No se puede emitir ND sobre una Nota de Crédito.' })
    if (origen.esNotaDebito)          return res.status(409).json({ error: 'No se puede emitir ND sobre otra Nota de Débito.' })
    if (origen.estado === 'Anulada')  return res.status(409).json({ error: 'La factura origen está Anulada, no admite ajustes.' })
    if (origen.estado === 'Borrador') return res.status(409).json({ error: 'La factura origen aún está en Borrador, no requiere ND.' })

    // Totales del ND: subtotal = monto neto, itbis 18% opcional, total = subtotal + itbis.
    const subtotal = Math.round(Number(monto) * 100) / 100
    const itbis    = aplicarItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
    const total    = Math.round((subtotal + itbis) * 100) / 100

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Secuencia NCF B03 — atomic upsert + increment.
      await tx.$executeRaw`
        INSERT INTO "ConfiguracionNCF" ("prefijo", "tipoNcf", "tipoDescripcion", "secuenciaActual", "limite", "activo", "createdAt", "updatedAt")
        VALUES ('B03', 'Nota de Débito', 'Notas de Débito (DGII B03)', 0, 99999999, true, NOW(), NOW())
        ON CONFLICT ("tipoNcf") DO NOTHING
      `
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = 'Nota de Débito'
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
        RETURNING *
      `
      if (!rows || rows.length === 0) {
        throw Object.assign(new Error('Secuencia NCF B03 agotada o inactiva. Revisa Configuración > Secuencias NCF.'), { status: 422 })
      }
      const seq         = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncfND       = `${rows[0].prefijo}${seq}`
      const noFacturaND = await generarSiguienteCodigo('notaDebito', tx)

      // 2. Crear la Nota de Débito como Factura(esNotaDebito=true) con UNA línea
      //    descriptiva del cargo. NO toca inventario ni anula la factura origen.
      const nd = await tx.factura.create({
        data: {
          noFactura:               noFacturaND,
          clienteId:               origen.clienteId,
          ordenId:                 origen.ordenId,
          empleadoId:              req.user?.sub ?? null,
          estado:                  'Emitida',
          subtotal,
          itbis,
          total,
          ncf:                     ncfND,
          tipoNcf:                 'Nota de Débito',
          fechaEmision:            new Date(),
          fechaVence:              new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          esNotaDebito:            true,
          facturaOrigenId:         origen.id,
          motivoNotaModificatoria: motivo,
          notas:                   `Cargo adicional contra ${origen.noFactura}${origen.ncf ? ` (NCF ${origen.ncf})` : ''}. Motivo: ${motivo}`,
          lineas: {
            create: [{
              descripcion:    `Ajuste / Cargo adicional · ${motivo}`,
              cantidad:       1,
              precioUnitario: subtotal,
            }],
          },
        },
      })

      return { nd, stockRestaurado: 0 }
    })

    invalidarPdfCache(resultado.nd.id).catch(() => {})

    auditReq('nd:emitida', req, {
      ndId:      resultado.nd.id,
      ncfND:     resultado.nd.ncf,
      origenId:  origen.id,
      ncfOrigen: origen.ncf,
      monto:     total,
      motivo,
    })
    await appendAuditCaja({
      tipo:       'nota_debito_emitida',
      empleadoId: req.user?.sub ?? null,
      facturaId:  resultado.nd.id,
      monto:      total,
      detalle:    `ND ${resultado.nd.ncf} carga RD$${total.toFixed(2)} contra ${origen.noFactura} (NCF ${origen.ncf ?? '—'}). Motivo: ${motivo}`,
      ip:         req.ip,
      ua:         (req.headers['user-agent'] ?? '').slice(0, 200),
    }).catch(() => {})

    res.status(201).json({ ok: true, notaDebito: resultado.nd })
  } catch (e) {
    console.error('[ND EMITIR]', e.status ?? 500, e.message)
    res.status(e.status ?? 500).json({ error: e.message ?? 'Error interno emitiendo Nota de Débito.' })
  }
})

// ─── Audit hash chain helpers + verify endpoint ──────────────────────────────
// Cada INSERT a AuditCaja debería pasar por appendAuditCaja() para mantener
// la cadena. El secret rotable AUDIT_SECRET protege contra reescritura post-facto.
const AUDIT_SECRET = process.env.AUDIT_SECRET ?? process.env.JWT_SECRET ?? 'change-me-audit-secret'

function _canonicalizar(row) {
  const safe = {
    tipo: row.tipo ?? '',
    empleadoId: row.empleadoId ?? null,
    facturaId: row.facturaId ?? null,
    monto: row.monto != null ? String(row.monto) : null,
    descPct: row.descPct != null ? String(row.descPct) : null,
    detalle: row.detalle ?? '',
    ip: row.ip ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  }
  return JSON.stringify(safe, Object.keys(safe).sort())
}

async function appendAuditCaja(data) {
  // Lee el último hash conocido para encadenar.
  const last = await prisma.auditCaja.findFirst({
    where:   { hash: { not: null } },
    orderBy: { id: 'desc' },
    select:  { hash: true },
  })
  const prevHash = last?.hash ?? 'GENESIS'
  const payload  = _canonicalizar({ ...data, createdAt: data.createdAt ?? new Date() })
  const hash     = crypto.createHmac('sha256', AUDIT_SECRET).update(payload + '|' + prevHash).digest('hex')
  return prisma.auditCaja.create({ data: { ...data, prevHash, hash } })
}

// Endpoint verificación integridad: recorre las últimas N filas, recalcula hash
// y reporta cualquier inconsistencia. Solo owner. Coste O(N) — usa take limitado.
router.get('/auditoria/caja/verify', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10), 5000)
    const rows = await prisma.auditCaja.findMany({
      orderBy: { id: 'asc' },
      take:    limit,
    })
    let prev = 'GENESIS'
    let roto = null
    for (const r of rows) {
      if (!r.hash) continue   // filas legacy pre-chain
      const expected = crypto.createHmac('sha256', AUDIT_SECRET).update(_canonicalizar(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex')
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }
        break
      }
      prev = r.hash
    }
    res.json({ ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto })
  } catch (e) {
    console.error('[AUDIT VERIFY]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Verifica integridad de AuditLog (mismo principio que AuditCaja). Filas legacy
// pre-chain (hash=null) se omiten. Coste O(N) — se acota con limit.
router.get('/auditoria/log/verify', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10), 5000)
    const rows = await prisma.auditLog.findMany({
      orderBy: { id: 'asc' },
      take:    limit,
    })
    let prev = 'GENESIS'
    let roto = null
    for (const r of rows) {
      if (!r.hash) continue
      const expected = crypto.createHmac('sha256', AUDIT_SECRET).update(_canonicalizarLog(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex')
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }
        break
      }
      prev = r.hash
    }
    res.json({ ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto })
  } catch (e) {
    console.error('[AUDIT LOG VERIFY]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})


// ─── Facturas ────────────────────────────────────────────────────────────────

router.post('/facturas', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  const { ordenId, forzarCredito } = req.body
  if (!ordenId) return res.status(400).json({ error: 'ordenId requerido.' })
  try {
    // ── CONTROL DE CREDITO (pre-transacción para fail rápido) ────────────────
    const otPre = await prisma.ordenTrabajo.findUnique({
      where:   { id: ordenId },
      include: { lineas: true, cliente: { select: { id: true, razonSocial: true, limiteCredito: true } } },
    })
    if (otPre && otPre.cliente && Number(otPre.cliente.limiteCredito) > 0) {
      const totalNueva = otPre.lineas.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0) * 1.18
      const deudaActual = await prisma.factura.aggregate({
        _sum:  { total: true },
        where: {
          clienteId:    otPre.cliente.id,
          deletedAt:    null,
          esCotizacion: false,
          estado:       { in: ['Emitida', 'Vencida'] },
        },
      })
      const deuda  = Number(deudaActual._sum.total ?? 0)
      const limite = Number(otPre.cliente.limiteCredito)
      if (deuda + totalNueva > limite) {
        const perms = Array.isArray(req.user?.permisos) ? req.user.permisos : []
        const puedeForzar = perms.includes('ventas:forzar_credito') || perms.includes('sistema:owner')
        if (!puedeForzar || !forzarCredito) {
          auditReq('factura:credito_bloqueado', req, { clienteId: otPre.cliente.id, deuda, limite, intento: totalNueva })
          return res.status(422).json({
            error: `Crédito excedido: ${otPre.cliente.razonSocial} debe RD$${deuda.toFixed(0)} de RD$${limite.toFixed(0)} permitidos. Esta factura suma RD$${totalNueva.toFixed(0)}.`,
            code:  'CREDIT_LIMIT_EXCEEDED',
            puedeForzar,
            detalle: { deudaActual: deuda, limiteCredito: limite, montoIntentado: totalNueva },
          })
        }
        // Owner forzó: auditar el bypass
        auditReq('factura:credito_forzado', req, { clienteId: otPre.cliente.id, deuda, limite, monto: totalNueva })
      }
    }

    const factura = await prisma.$transaction(async (tx) => {
      // 1. OT + líneas + cliente
      const ot = await tx.ordenTrabajo.findUnique({
        where:   { id: ordenId },
        include: { cliente: true, lineas: true, facturas: { select: { id: true } } },
      })
      if (!ot || ot.deletedAt)       throw Object.assign(new Error('Orden no encontrada.'),        { status: 404 })
      if (ot.facturas.length > 0)    throw Object.assign(new Error('Esta orden ya tiene factura.'), { status: 409 })
      if (ot.estado === 'Cancelada') throw Object.assign(new Error('No se puede facturar una OT cancelada.'), { status: 422 })

      // 2. Tipo NCF del cliente
      const tipoNcf = ot.cliente.tipoNcf ?? 'Consumidor Final'

      // 3. UPDATE atómico — acquire exclusive row lock, increment counter
      const rows = await tx.$queryRaw`
        UPDATE "ConfiguracionNCF"
        SET    "secuenciaActual" = "secuenciaActual" + 1
        WHERE  "tipoNcf"         = ${tipoNcf}
          AND  "activo"          = true
          AND  "secuenciaActual" < "limite"
          AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
        RETURNING *
      `
      if (!rows || rows.length === 0)
        throw Object.assign(
          new Error(`Sin secuencia NCF disponible para tipo "${tipoNcf}". Verifica la configuración.`),
          { status: 422 }
        )

      // 4. NCF (DGII compliance) + noFactura (interno auto-secuenciador del owner).
      const seq       = String(rows[0].secuenciaActual).padStart(8, '0')
      const ncf       = `${rows[0].prefijo}${seq}`
      // noFactura ahora usa el secuenciador centralizado configurable por owner.
      // NCF sigue su lógica DGII independiente (no se mezclan responsabilidades).
      const noFactura = await generarSiguienteCodigo('factura', tx)

      // 5. Cálculo de totales — EXCLUYE líneas marcadas como consumoInterno
      // (materiales gastados en instalación que NO se facturan al cliente).
      // El descuento real de stock para esas líneas ocurre al cerrar la OT.
      const lineasFacturables = ot.lineas.filter(l => !l.consumoInterno)
      const subtotal = lineasFacturables.reduce((s, l) => s + Number(l.precioUnitario) * l.cantidad, 0)
      const itbis    = ot.cliente.itbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
      const total    = Math.round((subtotal + itbis) * 100) / 100

      // 6. Crear Factura en estado Emitida
      const f = await tx.factura.create({
        data: {
          noFactura,
          clienteId:  ot.clienteId,
          ordenId:    ot.id,
          empleadoId: req.user?.sub ?? null,
          estado:     'Emitida',
          subtotal,
          itbis,
          total,
          ncf,
          tipoNcf,
          fechaVence: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      })

      // 7. Marcar OT como Completada + estaFacturada
      await tx.ordenTrabajo.update({
        where: { id: ordenId },
        data:  { estado: 'Completada', completadaEn: new Date(), estaFacturada: true },
      })

      return tx.factura.findUnique({
        where:   { id: f.id },
        include: { cliente: { select: { email: true, razonSocial: true } }, orden: { include: { lineas: true } } },
      })
    })

    // Hash lifecycle: persistimos verifyHash SYNCHRONOUSLY antes de responder.
    // Cualquier PDF/QR generado después leerá un row que ya tiene el hash final.
    await persistirVerifyHash(factura)
    auditReq('factura:emitir', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total) })
    res.status(201).json(factura)

    // Fire-and-forget PDF email
    setImmediate(async () => {
      try {
        const pdfBuf = await buildFacturaPDFBuffer(factura)
        await sendFacturaPDF(factura, pdfBuf)
      } catch (e) { console.error('[EMAIL FF]', e.message) }
    })
  } catch (e) {
    const status = e.status ?? 500
    const msg    = e.status ? e.message : 'Error al generar la factura.'
    res.status(status).json({ error: msg })
  }
})




  return router;
}

module.exports = createFacturasRouter;
