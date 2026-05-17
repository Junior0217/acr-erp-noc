/**
 * backend/modules/ventas/pos/router.js
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


function createPosRouter(deps) {
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
    verifyLimiter, empresaPublicLimiter, bulkPdfLimiter, } = limiters;

  // === ROUTES (extraidas del monolito) ==================================
// ─── POS — Venta directa desde ItemCatalogo ───────────────────────────────────

// Línea POS acepta DOS modos:
//   1) itemCatalogoId (UUID): venta desde el catálogo comercial (ItemCatalogo).
//   2) productoId    (Int) : venta DIRECTA de inventario físico (Producto) — usado
//      por el banner de cross-sell que sugiere productos no atados a un item.
// Exactly-one-of validado abajo con .refine.
const lineaPOSCatalogoSchema = z.object({
  itemCatalogoId:      z.string().uuid().optional(),
  productoId:          z.number().int().positive().optional(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
}).refine(
  l => (l.itemCatalogoId && !l.productoId) || (!l.itemCatalogoId && l.productoId),
  { message: 'Cada línea debe traer itemCatalogoId (UUID) o productoId (Int), no ambos.' }
)

const pagoMetodoSchema = z.object({
  metodo: z.enum(['Efectivo', 'Transferencia', 'Tarjeta', 'Cheque', 'Otro']),
  // M4: tope mínimo defensivo. positive() ya rechaza 0/negativo pero acepta 1e-12;
  // 0.01 es 1 centavo, el mínimo monetario real en DOP/USD. Bloquea pagos basura.
  monto:  z.number().min(0.01, 'Monto debe ser ≥ RD$0.01.').max(10_000_000, 'Monto excesivo.'),
  refer:  z.string().max(60).optional().nullable(),
})

const posVentaSchema = z.object({
  // Rigor Enterprise: clienteId OBLIGATORIO en TODA venta POS (cotización o
  // factura). Cero walk-in / nombre libre — la trazabilidad fiscal y CRM
  // requiere relación dura con tabla Cliente. nombreTemporal eliminado.
  clienteId:           z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente).' }),
  tipoNcf:             z.string().optional(),
  applyItbis:          z.boolean().optional().default(true),
  diasVence:           z.number().int().min(0).max(365).optional().default(30),
  esCotizacion:        z.boolean().optional().default(false),
  descuentoGlobalPct:  z.number().min(0).max(100).optional().default(0),
  descuentoGlobalMonto:z.number().min(0).optional().default(0),
  pinSupervisor:       z.string().max(20).optional(),         // requerido si desc > 15%
  pagos:               z.array(pagoMetodoSchema).max(20, 'Máximo 20 métodos de pago por factura.').optional(),  // null = no desglosado (legacy). H8: cap anti-DoS
  lineas:              z.array(lineaPOSCatalogoSchema).min(1),
  // Override per-documento de condiciones comerciales y notas. La UI las
  // togglea con PIN supervisor; el shape {incluir:false, texto:...} oculta
  // la fila en el PDF. Si campo viene undefined, mergeCondiciones cae al
  // default de EmpresaPerfil.condicionesDefault.
  condicionesOverride: z.object({
    validez:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    pago:     z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    entrega:  z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
    garantia: z.object({ incluir: z.boolean(), texto: z.string().max(500).nullable().optional() }).optional(),
  }).optional(),
  notasOverride: z.string().max(2000).nullable().optional(),
})

// Validación previa del PIN supervisor sin emitir factura. La UI lo usa para
// desbloquear los inputs de descuento (global y por línea) en el carrito y
// POS. La verificación real al emitir sigue ocurriendo en /api/pos/venta,
// este endpoint solo confirma "el PIN es correcto, deja al cajero seguir".
const pinVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  keyGenerator: (req) => req.user?.sub ? `pin:${req.user.sub}` : reqFingerprint(req),
  store: makeRateLimitStore(),
  skipSuccessfulRequests: true,
  message: { valid: false, error: 'Demasiados intentos de PIN. Espera 5 minutos.' },
})
router.post('/pos/verificar-pin', verificarJWT, pinVerifyLimiter, async (req, res) => {
  try {
    const pin = String(req.body?.pin ?? '').trim()
    if (!/^\d{4,12}$/.test(pin)) {
      return res.status(400).json({ valid: false, error: 'PIN debe contener 4-12 dígitos.' })
    }
    const empCfg = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true } })
    const pinReal = empCfg?.pinSupervisor ?? '1234'
    // Comparación con timingSafeEqual evita timing-attacks por longitud.
    const a = Buffer.from(pin.padEnd(16, '\0'))
    const b = Buffer.from(String(pinReal).padEnd(16, '\0'))
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
    if (!ok) {
      auditReq('pos:pin_invalid', req)
      return res.status(401).json({ valid: false, error: 'PIN inválido.' })
    }
    auditReq('pos:pin_ok', req)
    return res.json({ valid: true })
  } catch (e) {
    console.error('[POS verificar-pin]', e.message)
    return res.status(500).json({ valid: false, error: 'Error de verificación.' })
  }
})

router.post('/pos/venta', verificarJWT, billingLimiter, async (req, res) => {
  try {
    const { clienteId: inputClienteId, tipoNcf: tipoNcfOverride, applyItbis, diasVence, esCotizacion, descuentoGlobalPct, descuentoGlobalMonto, pinSupervisor, pagos, lineas, condicionesOverride, notasOverride } = posVentaSchema.parse(req.body)
    const permReq = esCotizacion ? 'pos:cotizar' : 'pos:facturar'
    const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    if (!permisos.includes('sistema:owner') && !permisos.includes(permReq))
      return res.status(403).json({ error: `Se requiere permiso "${permReq}".` })

    // ─── Pre-fetch precios DB para gate de PIN basado en % EFECTIVO ─────────
    // C2/C5: el cliente NO puede sobreescribir precioUnitario salvo que tenga
    // permiso 'pos:override_precio'. Calculamos subtotalBruto desde DB para
    // que el gate PIN considere tanto % global como descuentoMonto (efectivo).
    const puedeOverridePrecio = permisos.includes('sistema:owner') || permisos.includes('pos:override_precio')
    const isOwner = permisos.includes('sistema:owner')
    const empCfg  = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { pinSupervisor: true, maxDescuentoCajero: true } })
    const maxDescuentoCajero = Number(empCfg?.maxDescuentoCajero ?? 15)

    const _pidsForGate = [...new Set(lineas.filter(l => l.productoId).map(l => l.productoId))]
    const _iidsForGate = [...new Set(lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))]
    const [_prodGate, _itemGate] = await Promise.all([
      _pidsForGate.length ? prisma.producto.findMany({ where: { id: { in: _pidsForGate } }, select: { id: true, nombre: true, precio: true, stockActual: true, tipoItem: true } }) : [],
      _iidsForGate.length ? prisma.itemCatalogo.findMany({
        where: { id: { in: _iidsForGate } },
        select: {
          id: true, nombre: true, precio: true, productoId: true, esBundle: true,
          producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
          componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
        },
      }) : [],
    ])
    const _pMapGate = Object.fromEntries(_prodGate.map(p => [p.id, Number(p.precio)]))
    const _iMapGate = Object.fromEntries(_itemGate.map(i => [i.id, Number(i.precio)]))
    const _itemFullMap = Object.fromEntries(_itemGate.map(i => [i.id, i]))

    // M10 + Bundles: pre-flight stock check expandiendo bundles. Cada línea se
    // explota a {productoId, cantidad} (bundle multiplica componentes × line.qty)
    // y se agrega antes de comparar contra stockActual. Esto evita falsos OK
    // cuando dos líneas distintas pegan al mismo producto físico (ej. 2 kits CCTV
    // que comparten el mismo modelo de cámara).
    const _stockMapDirect = Object.fromEntries(_prodGate.map(p => [p.id, p]))
    if (!esCotizacion) {
      const requeridos = {}   // productoId -> cantidad total requerida
      const nombresPorPid = {} // para mensajes amistosos
      for (const l of lineas) {
        if (l.productoId) {
          const p = _stockMapDirect[l.productoId]
          if (!p || p.tipoItem === 'SERVICIO') continue
          requeridos[p.id] = (requeridos[p.id] ?? 0) + l.cantidad
          nombresPorPid[p.id] = p.nombre
        } else if (l.itemCatalogoId) {
          const it = _itemFullMap[l.itemCatalogoId]
          if (!it) continue
          // Bundle: explota a componentes.
          if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
            for (const c of it.componentes) {
              if (!c.producto || c.producto.tipoItem === 'SERVICIO') continue
              const cantTotal = c.cantidad * l.cantidad
              requeridos[c.productoId] = (requeridos[c.productoId] ?? 0) + cantTotal
              nombresPorPid[c.productoId] = c.producto.nombre
            }
          } else if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
            requeridos[it.productoId] = (requeridos[it.productoId] ?? 0) + l.cantidad
            nombresPorPid[it.productoId] = it.producto?.nombre ?? it.nombre
          }
        }
      }
      // Verificar disponibilidad por producto (un solo query por chunk).
      const pidsRequeridos = Object.keys(requeridos).map(Number)
      if (pidsRequeridos.length > 0) {
        const stockActuales = await prisma.producto.findMany({
          where:  { id: { in: pidsRequeridos } },
          select: { id: true, nombre: true, stockActual: true },
        })
        for (const p of stockActuales) {
          const req = requeridos[p.id]
          if (Number(p.stockActual) < req) {
            return res.status(422).json({
              error: `Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${req} (incluye expansión de bundles).`,
              code:  'STOCK_INSUFICIENTE',
              productoId: p.id,
            })
          }
        }
      }
    }
    let _subtotalBrutoGate = 0
    for (const l of lineas) {
      const precioBase = l.productoId
        ? (puedeOverridePrecio && l.precioUnitario != null ? Number(l.precioUnitario) : (_pMapGate[l.productoId] ?? 0))
        : (puedeOverridePrecio && l.precioUnitario != null ? Number(l.precioUnitario) : (_iMapGate[l.itemCatalogoId] ?? 0))
      _subtotalBrutoGate += totalLinea(precioBase, l.descuentoPorcentaje ?? 0, l.descuentoMonto ?? 0, l.cantidad)
    }
    const _descMontoEfectivo = _subtotalBrutoGate > 0 ? Math.min(descuentoGlobalMonto, _subtotalBrutoGate) : 0
    const _descMontoComoPct  = _subtotalBrutoGate > 0 ? (_descMontoEfectivo / _subtotalBrutoGate) * 100 : 0
    const descEfectivoPct    = Math.max(descuentoGlobalPct, _descMontoComoPct)

    if (!isOwner && !esCotizacion && descEfectivoPct > maxDescuentoCajero) {
      const pinReal = empCfg?.pinSupervisor ?? '1234'
      if (!pinSupervisor || pinSupervisor !== pinReal) {
        auditReq('pos:descuento_pin_fail', req, { descuentoPctEfectivo: descEfectivoPct.toFixed(2), max: maxDescuentoCajero })
        try {
          await prisma.auditCaja.create({ data: {
            tipo: 'descuento_rechazado', empleadoId: req.user?.sub ?? null,
            descPct: Math.round(descEfectivoPct * 100) / 100,
            detalle: `Cajero intentó descuento efectivo ${descEfectivoPct.toFixed(2)}% (límite ${maxDescuentoCajero}%) sin PIN válido`,
            ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
          }})
        } catch {}
        return res.status(403).json({
          error: `Descuento efectivo ${descEfectivoPct.toFixed(2)}% excede ${maxDescuentoCajero}%. Requiere PIN de supervisor.`,
          code:  'PIN_REQUIRED',
        })
      }
      auditReq('pos:descuento_pin_ok', req, { descuentoPctEfectivo: descEfectivoPct.toFixed(2), max: maxDescuentoCajero })
      try {
        await prisma.auditCaja.create({ data: {
          tipo: 'descuento_pin', empleadoId: req.user?.sub ?? null,
          descPct: Math.round(descEfectivoPct * 100) / 100,
          detalle: `PIN supervisor validó descuento efectivo ${descEfectivoPct.toFixed(2)}% (límite ${maxDescuentoCajero}%)`,
          ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
        }})
      } catch {}
    }

    const factura = await prisma.$transaction(async (tx) => {
      // 1. Resolve client — DEBE ser un Cliente real de DB. Sin walk-in / sin upsert
      // de "Consumidor Final" fantasma. Si no llega clienteId, Zod ya rechazó la
      // petición; este findUnique es la última barrera ante un UUID inexistente.
      const cliente = await tx.cliente.findUnique({ where: { id: inputClienteId } })
      if (!cliente) throw Object.assign(new Error('Cliente no encontrado en la base de datos.'), { status: 404 })

      // 2. Carga ItemCatalogos + Productos físicos según lo que traiga cada línea.
      const itemIds = [...new Set(lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))]
      const prodIds = [...new Set(lineas.filter(l => l.productoId).map(l => l.productoId))]
      const [items, prods] = await Promise.all([
        itemIds.length ? tx.itemCatalogo.findMany({
          where: { id: { in: itemIds } },
          // descripcion + producto.sku necesarios para snapshot fiel al PDF.
          select: { id: true, nombre: true, descripcion: true, precio: true, tipoItem: true, stock: true, productoId: true,
                    producto: { select: { sku: true } } },
        }) : [],
        prodIds.length ? tx.producto.findMany({
          where: { id: { in: prodIds } },
          select: { id: true, sku: true, nombre: true, descripcion: true, precio: true, stockActual: true },
        }) : [],
      ])
      const iMap = Object.fromEntries(items.map(i => [i.id, i]))
      const pMap = Object.fromEntries(prods.map(p => [p.id, p]))
      for (const l of lineas) {
        if (l.itemCatalogoId && !iMap[l.itemCatalogoId]) throw Object.assign(new Error(`Item catálogo ${l.itemCatalogoId} no encontrado.`), { status: 404 })
        if (l.productoId     && !pMap[l.productoId])     throw Object.assign(new Error(`Producto ${l.productoId} no encontrado.`), { status: 404 })
      }

      // 3. Build enriched lines + totals.
      // CRÍTICO: la descripcion enriquecida (markdown title + bullets) DEBE viajar
      // como snapshot al LineaFactura. Si solo guardamos item.nombre, el PDF
      // pierde el detalle (Smart Markdown necesita el texto largo para parsear).
      // Formato: si hay descripción rica -> "**título**\n descripción", el parser
      // del PDF la reconoce como heading + body automáticamente.
      const composeDesc = (titulo, descripcion) => {
        const desc = (descripcion ?? '').trim()
        if (!desc) return titulo
        // Formato estructurado v=1: lo pasamos íntegro (el renderer PDF lo entiende).
        // Si el JSON no trae titulo propio, sobreescribimos con el del producto.
        if (desc.length > 1 && desc[0] === '{') {
          try {
            const obj = JSON.parse(desc)
            if (obj && obj.v === 1) {
              if (!obj.titulo || !obj.titulo.trim()) obj.titulo = titulo
              return JSON.stringify(obj)
            }
          } catch {}
        }
        return `**${titulo}**\n${desc}`
      }
      const lineasEnriquecidas = lineas.map(l => {
        if (l.productoId) {
          const p = pMap[l.productoId]
          // C2: precio autoritativo DB. Cliente solo puede override si tiene 'pos:override_precio'.
          const pu = (puedeOverridePrecio && l.precioUnitario != null)
            ? Number(l.precioUnitario)
            : Number(p.precio)
          return {
            descripcion: composeDesc(p.nombre, p.descripcion),
            cantidad: l.cantidad, precioUnitario: pu,
            productoId:  p.id,                  // -> Factura.lineas.producto.sku flows to PDF
            descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
            descuentoMonto:      l.descuentoMonto ?? 0,
            _isProducto: true,
          }
        }
        const item = iMap[l.itemCatalogoId]
        const pu = (puedeOverridePrecio && l.precioUnitario != null)
          ? Number(l.precioUnitario)
          : Number(item.precio)
        return {
          descripcion: composeDesc(item.nombre, item.descripcion),
          cantidad: l.cantidad, precioUnitario: pu,
          // Si el ItemCatalogo está atado a un Producto físico, copia productoId
          // para que el PDF tire el SKU del producto vinculado.
          productoId:  item.productoId ?? null,
          descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
          descuentoMonto:      l.descuentoMonto ?? 0,
        }
      })
      const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100
      const globalDesc    = descuentoGlobalPct > 0 ? Math.round(subtotalBruto * (descuentoGlobalPct / 100) * 100) / 100 : Math.min(descuentoGlobalMonto, subtotalBruto)
      const subtotal      = Math.round((subtotalBruto - globalDesc) * 100) / 100
      const itbisAmt      = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
      const total         = Math.round((subtotal + itbisAmt) * 100) / 100

      // 4. NCF (DGII) + noFactura (secuenciador centralizado)
      let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado
      if (esCotizacion) {
        noFactura = await generarSiguienteCodigo('cotizacion', tx)
        estado    = 'Borrador'
      } else {
        tipoNcf = tipoNcfOverride || (['PYME', 'Empresa'].includes(cliente.tipoEmpresa) ? 'Fiscal' : 'Consumidor Final')
        const rows = await tx.$queryRaw`
          UPDATE "ConfiguracionNCF"
          SET    "secuenciaActual" = "secuenciaActual" + 1
          WHERE  "tipoNcf"         = ${tipoNcf}
            AND  "activo"          = true
            AND  "secuenciaActual" < "limite"
            AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
          RETURNING *
        `
        if (!rows || rows.length === 0) throw Object.assign(new Error(`Sin secuencia NCF para "${tipoNcf}". Verifica Config NCF.`), { status: 422 })
        const seq = String(rows[0].secuenciaActual).padStart(8, '0')
        ncf       = `${rows[0].prefijo}${seq}`
        noFactura = await generarSiguienteCodigo('factura', tx)
        estado    = 'Emitida'
      }

      // Validación cobro mixto: la suma de pagos debe igualar total (±0.01 tolerance).
      let pagosValidados = null
      if (!esCotizacion && Array.isArray(pagos) && pagos.length > 0) {
        const suma = pagos.reduce((s, p) => s + Number(p.monto), 0)
        if (Math.abs(suma - total) > 0.01) {
          throw Object.assign(new Error(`Suma de pagos (RD$ ${suma.toFixed(2)}) no coincide con total (RD$ ${total.toFixed(2)}).`), { status: 400 })
        }
        pagosValidados = pagos.map(p => ({ metodo: p.metodo, monto: Number(p.monto), refer: p.refer ?? null }))
      }

      // Notas finales: override del usuario (autorizado por PIN) > auto-generadas.
      // Si notasOverride viene null se persiste null (oculta la sección en PDF).
      // Si viene undefined (sin override), se aplica la nota auto-generada
      // legacy de POS para mantener trazabilidad mínima. Sin variante walk-in:
      // todo documento se emite a un Cliente real, así que la nota refleja eso.
      const notasFinales = (notasOverride !== undefined)
        ? (notasOverride === '' ? null : notasOverride)
        : (esCotizacion
            ? `Cotización POS (catálogo) — ${lineas.length} línea(s)`
            : `Factura POS (catálogo) — ${lineas.length} línea(s)`)

      // 5. Create Factura (no productoId — catalog items don't deduct stock)
      return tx.factura.create({
        data: {
          noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
          ncf, tipoNcf, esCotizacion,
          empleadoId: req.user?.sub ?? null,    // C6: ownership trail (RBAC Kanban)
          pagos: pagosValidados,
          notas: notasFinales,
          // condiciones override per-doc: cada campo {incluir, texto}. Si el
          // user togglea OFF "Validez" en el carrito, llega { validez: {incluir:false} }
          // → mergeCondiciones en buildPdfData retorna null para validez → PDF oculta la fila.
          condiciones: condicionesOverride ?? {},
          fechaVence: diasVence > 0 ? new Date(Date.now() + diasVence * 86_400_000) : null,
          // Strip marker interno (_isProducto) antes de Prisma. productoId pasa intacto al schema.
          lineas: { createMany: { data: lineasEnriquecidas.map(({ _isProducto, ...rest }) => rest) } },
        },
        include: {
          cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
          lineas:  true,
        },
      })
    })
    await persistirVerifyHash(factura)
    auditReq(esCotizacion ? 'cotizacion:crear' : 'factura:pos_catalogo', req, { facturaId: factura.id, total: Number(factura.total) })

    // ── Reservas de stock al cotizar (TTL 72h) ──────────────────────────────
    // Para cada línea cuyo ItemCatalogo está vinculado a un Producto físico,
    // crea registro en ReservaInventario. Al listar /api/catalogo, el stock
    // efectivo será stockActual - SUM(reservas activas) → evita doble venta.
    if (esCotizacion) {
      try {
        // ItemCatalogo vinculados a producto físico:
        const catIds = [...new Set(lineas.filter(l => l.itemCatalogoId).map(l => l.itemCatalogoId))]
        let linkMap = {}
        if (catIds.length > 0) {
          const itemsLink = await prisma.itemCatalogo.findMany({
            where: { id: { in: catIds } }, select: { id: true, productoId: true },
          })
          linkMap = Object.fromEntries(itemsLink.map(i => [i.id, i.productoId]))
        }
        const exp = new Date(Date.now() + 72 * 3600_000)
        const reservas = lineas
          .map(l => ({
            productoId: l.productoId ?? linkMap[l.itemCatalogoId] ?? null,
            cantidad:   l.cantidad,
          }))
          .filter(r => r.productoId)
        if (reservas.length > 0) {
          await prisma.reservaInventario.createMany({
            data: reservas.map(r => ({
              productoId: r.productoId, cantidad: r.cantidad,
              facturaId: factura.id, expiraEn: exp,
              motivo: `Cotización ${factura.noFactura}`,
            })),
          })
        }
      } catch (e) { console.error('[RESERVA]', e.message) }
    }

    // Deducción de stock + Kardex para líneas con productoId real (ventas directas
    // de inventario, no cotizaciones). Itemcatalogo→producto se maneja aparte si aplica.
    if (!esCotizacion) {
      try {
        // Bundles + items directos: expandimos cada línea y agregamos antes de
        // ejecutar el UPDATE. Garantiza que un kit CCTV descuente las 4 cámaras
        // + 1 DVR + cable del stockActual real.
        const aDescontar = {}  // productoId -> cantidad acumulada
        for (const l of lineas) {
          const comps = await expandirLineaAComponentes(prisma, l)
          for (const c of comps) {
            aDescontar[c.productoId] = (aDescontar[c.productoId] ?? 0) + c.cantidad
          }
        }
        for (const [pidStr, cant] of Object.entries(aDescontar)) {
          const pid = Number(pidStr)
          const rows = await prisma.$queryRaw`
            UPDATE "Producto" SET "stockActual" = "stockActual" - ${cant}
            WHERE id = ${pid} AND "stockActual" >= ${cant}
            RETURNING id, "stockActual"
          `
          if (!rows || rows.length === 0) {
            console.error(`[POS] STOCK DRIFT producto ${pid} - venta facturada SIN deducción. Factura ${factura.noFactura}`)
            await prisma.auditCaja.create({ data: {
              tipo: 'stock_drift', empleadoId: req.user?.sub ?? null,
              facturaId: factura.id,
              detalle: `Stock drift productoId=${pid} cantidad=${cant} (post-bundle expansion) — investigar reconciliación.`,
              ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
            }}).catch(() => {})
            continue
          }
          await prisma.movimientoInventario.create({ data: { productoId: pid, tipo: 'Salida', cantidad: cant } })
        }
      } catch (e) { console.error('[POS STOCK]', e.message) }
    }

    // AuditCaja: log venta concretada (no cotización) para fraud trail.
    if (!esCotizacion) {
      try {
        await prisma.auditCaja.create({ data: {
          tipo: 'venta', empleadoId: req.user?.sub ?? null,
          facturaId: factura.id, monto: Number(factura.total),
          descPct: descuentoGlobalPct || null,
          detalle: `${factura.noFactura} · NCF ${factura.ncf ?? '—'} · ${lineas.length} líneas`,
          ip: req.ip, ua: (req.headers['user-agent'] ?? '').slice(0, 200),
        }})
      } catch (e) { console.error('[AUDIT CAJA]', e.message) }
    }
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[POS VENTA]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al procesar venta.' })
  }
})


// ─── BOM helper: expande líneas a lista plana de componentes físicos ─────────
// Devuelve un array de { productoId, cantidad, nombre } para cada línea:
//   - Línea con productoId directo  → 1 entry (la propia línea)
//   - Línea con itemCatalogo bundle → N entries (uno por componente, qty × line.qty)
//   - Línea con itemCatalogo simple vinculado a Producto → 1 entry (item.productoId)
//   - Línea de servicio puro → array vacío (no consume stock)
// Usado por OT (reservas) y POS (stock check + deducción).
async function expandirLineaAComponentes(tx, linea) {
  // Guards defensivos: una línea ausente o sin cantidad válida no consume stock.
  if (!linea || typeof linea !== 'object') return []
  const cantidad = Number(linea.cantidad)
  if (!Number.isFinite(cantidad) || cantidad <= 0) return []
  if (linea.productoId) {
    return [{ productoId: linea.productoId, cantidad, source: 'direct' }]
  }
  if (linea.itemCatalogoId) {
    let it
    try {
      it = await tx.itemCatalogo.findUnique({
        where:   { id: linea.itemCatalogoId },
        include: {
          componentes: { include: { producto: { select: { id: true, nombre: true, stockActual: true, tipoItem: true } } } },
          producto:    { select: { id: true, nombre: true, stockActual: true, tipoItem: true } },
        },
      })
    } catch (e) {
      console.warn(`[expandirLineaAComponentes] lookup falló id=${linea.itemCatalogoId}:`, e.message)
      return []
    }
    if (!it) return []
    // Bundle: explota a lista de componentes (cantidades multiplicadas por la línea).
    if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
      return it.componentes
        .filter(c => c?.producto && c.producto.tipoItem !== 'SERVICIO' && Number(c.cantidad) > 0)
        .map(c => ({
          productoId: c.productoId,
          cantidad:   Number(c.cantidad) * cantidad,
          nombre:     c.producto.nombre ?? 'Componente',
          source:     'bundle',
          bundleItemId: it.id,
        }))
    }
    // Item simple vinculado a Producto físico (no bundle)
    if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
      return [{ productoId: it.productoId, cantidad, nombre: it.producto?.nombre ?? it.nombre ?? 'Producto', source: 'linked' }]
    }
  }
  return []
}

async function procesarFacturaPOS({ inputClienteId, applyItbis, diasVence, esCotizacion, lineas, tipoNcfOverride, descuentoGlobalPct = 0, descuentoGlobalMonto = 0, puedeOverridePrecio = false, empleadoId = null, condicionesOverride = undefined, notasOverride = undefined }) {
  // Rigor Enterprise: clienteId obligatorio. Sin walk-in. Esta guard se ejecuta
  // ANTES de abrir la $transaction para evitar costos inútiles si falta el
  // cliente. La barrera Zod en las rutas que invocan procesarFacturaPOS también
  // valida — este check es defense-in-depth para callers internos (revivir, etc).
  if (!inputClienteId) {
    throw Object.assign(new Error('clienteId es obligatorio — vincula el documento a un cliente real.'), { status: 400 })
  }
  return prisma.$transaction(async (tx) => {
    // 1. Resolve client — siempre via findUnique sobre Cliente real.
    const cliente = await tx.cliente.findUnique({ where: { id: inputClienteId } })
    if (!cliente) throw Object.assign(new Error('Cliente no encontrado en la base de datos.'), { status: 404 })

    // 2. Load products (only lines that have a productoId — description-only lines skip this)
    const productoIds = [...new Set(lineas.map(l => l.productoId).filter(Boolean))]
    const productos = productoIds.length > 0
      ? await tx.producto.findMany({
          where:  { id: { in: productoIds } },
          select: { id: true, nombre: true, sku: true, stockActual: true, precio: true, tipoItem: true },
        })
      : []
    const pMap = Object.fromEntries(productos.map(p => [p.id, p]))
    for (const l of lineas) {
      if (l.productoId && !pMap[l.productoId])
        throw Object.assign(new Error(`Producto ID ${l.productoId} no encontrado.`), { status: 404 })
      if (!l.productoId && !l.descripcion)
        throw Object.assign(new Error('Línea sin productoId requiere campo descripción.'), { status: 400 })
    }

    // 3. Stock check — only ARTICULO items, only for real invoices
    // Performed later via atomic UPDATE to avoid TOCTOU race conditions

    // 4. Build enriched lines + totals (with discounts)
    // C2: precio autoritativo DB. Si cliente no tiene 'pos:override_precio',
    // ignoramos l.precioUnitario y usamos Producto.precio actual.
    const lineasEnriquecidas = lineas.map(l => {
      if (l.productoId) {
        const p   = pMap[l.productoId]
        const pu  = (puedeOverridePrecio && l.precioUnitario != null)
          ? Number(l.precioUnitario)
          : Number(p.precio)
        const pct = l.descuentoPorcentaje ?? 0
        const mon = l.descuentoMonto ?? 0
        return { productoId: l.productoId, descripcion: l.descripcion ?? p.nombre, cantidad: l.cantidad,
                 precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, _tipoItem: p.tipoItem }
      }
      // Description-only line (POS catalog item — no inventory tracking).
      // Aquí precio sí puede venir del cliente (no hay producto físico que validar).
      const pu  = l.precioUnitario ?? 0
      const pct = l.descuentoPorcentaje ?? 0
      const mon = l.descuentoMonto ?? 0
      return { productoId: null, descripcion: l.descripcion, cantidad: l.cantidad,
               precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, _tipoItem: 'SERVICIO' }
    })
    const subtotalBruto = Math.round(lineasEnriquecidas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPorcentaje, l.descuentoMonto, l.cantidad), 0) * 100) / 100
    const globalDesc    = descuentoGlobalPct > 0
      ? Math.round(subtotalBruto * (descuentoGlobalPct / 100) * 100) / 100
      : Math.min(descuentoGlobalMonto, subtotalBruto)
    const subtotal = Math.round((subtotalBruto - globalDesc) * 100) / 100
    const itbisAmt = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
    const total    = Math.round((subtotal + itbisAmt) * 100) / 100

    let ncf = null, noFactura, tipoNcf = 'Consumidor Final', estado

    if (esCotizacion) {
      noFactura = await generarSiguienteCodigo('cotizacion', tx)
      estado    = 'Borrador'
    } else {
      // 5. Smart NCF: override > PYME/Empresa → Fiscal (B01); else → Consumidor Final (B02)
      tipoNcf = tipoNcfOverride || (['PYME', 'Empresa'].includes(cliente.tipoEmpresa) ? 'Fiscal' : 'Consumidor Final')
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
        throw Object.assign(new Error(`Sin secuencia NCF disponible para "${tipoNcf}". Verifica Configuración NCF.`), { status: 422 })
      const seq = String(rows[0].secuenciaActual).padStart(8, '0')
      ncf       = `${rows[0].prefijo}${seq}`
      noFactura = await generarSiguienteCodigo('factura', tx)
      estado    = 'Emitida'
    }

    // 6. Snapshot fiscal: foto inmutable de empresa + cliente al momento de emitir.
    // Solo en facturas reales (no cotizaciones). Si la empresa cambia logo/RNC/dirección
    // años después, los PDFs antiguos siguen mostrando el estado original.
    let snapshot = null
    if (!esCotizacion) {
      const empresa = await tx.empresaPerfil.findUnique({ where: { id: 1 } })
      snapshot = {
        emitidoEn: new Date().toISOString(),
        empresa: empresa ? {
          razonSocial:       empresa.razonSocial,
          nombreComercial:   empresa.nombreComercial,
          rnc:               empresa.rnc,
          registroMercantil: empresa.registroMercantil,
          direccion:         empresa.direccion,
          sector:            empresa.sector,
          provincia:         empresa.provincia,
          telefono:          empresa.telefono,
          email:             empresa.email,
          website:           empresa.website,
          eslogan:           empresa.eslogan,
          representanteNombre:   empresa.representanteNombre,
          representanteApellido: empresa.representanteApellido,
          representanteCargo:    empresa.representanteCargo,
          assets:                empresa.assets ?? {},
          condicionesDefault:    empresa.condicionesDefault ?? {},
        } : null,
        cliente: {
          razonSocial: cliente.razonSocial,
          noCliente:   cliente.noCliente,
          rnc:         cliente.rnc,
          cedula:      cliente.cedula,
          direccion:   cliente.direccion,
          sector:      cliente.sector,
          provincia:   cliente.provincia,
          telefono:    cliente.telefonoPrincipal ?? cliente.telefono,
          email:       cliente.email,
          tipoEmpresa: cliente.tipoEmpresa,
        },
      }
    }

    // 7. Create Factura + LineaFactura (nested write)
    const lineaData = lineasEnriquecidas.map(({ _tipoItem, ...rest }) => rest)
    // Notas: override del usuario (PIN-autorizado) > auto-generadas. Si el
    // user envió notasOverride === '' (toggle OFF), persistimos null y el
    // PDF oculta la sección Notas vía mergeCondiciones/templater.
    // Sin variante walk-in: clienteId es siempre real.
    const notasFinales = (notasOverride !== undefined)
      ? (notasOverride === '' ? null : notasOverride)
      : (esCotizacion
          ? `Cotización POS — ${lineas.length} línea(s)`
          : `Factura manual POS — ${lineas.length} línea(s)`)
    const f = await tx.factura.create({
      data: {
        noFactura, clienteId: cliente.id, estado, subtotal, itbis: itbisAmt, total,
        ncf, tipoNcf, esCotizacion,
        empleadoId,                              // C6: ownership trail
        snapshot,
        notas:      notasFinales,
        // condiciones override per-doc: {validez,pago,entrega,garantia} cada
        // uno con {incluir, texto?}. mergeCondiciones en buildPdfData filtra
        // los incluir=false para que el PDF oculte esas filas.
        condiciones: condicionesOverride ?? {},
        fechaVence: diasVence > 0 ? new Date(Date.now() + diasVence * 86_400_000) : null,
        lineas:     { createMany: { data: lineaData } },
      },
      include: {
        cliente: { select: { id: true, razonSocial: true, noCliente: true, rnc: true, direccion: true, tipoNcf: true } },
        lineas:  { include: { producto: { select: { id: true, nombre: true, sku: true, tipoItem: true } } } },
      },
    })

    // 7. Atomic stock deduction + Kardex (ARTICULO only, real invoices only)
    // Single SQL UPDATE checks and decrements in one step — no race condition
    if (!esCotizacion) {
      const cantPorArticulo = {}
      for (const l of lineasEnriquecidas) {
        if (l._tipoItem !== 'SERVICIO')
          cantPorArticulo[l.productoId] = (cantPorArticulo[l.productoId] || 0) + l.cantidad
      }
      for (const [pid, cant] of Object.entries(cantPorArticulo)) {
        const rows = await tx.$queryRaw`
          UPDATE "Producto"
          SET    "stockActual" = "stockActual" - ${cant}
          WHERE  id = ${Number(pid)} AND "stockActual" >= ${cant}
          RETURNING id, nombre, "stockActual"
        `
        if (!rows || rows.length === 0) {
          const p = pMap[Number(pid)]
          throw Object.assign(new Error(`Stock insuficiente para "${p.nombre}". Disponible: ${p.stockActual}, requerido: ${cant}.`), { status: 400 })
        }
        await tx.movimientoInventario.create({ data: { productoId: Number(pid), tipo: 'Salida', cantidad: cant } })
      }
    }
    return f
  })
}

router.post('/facturas/manual', verificarJWT, billingLimiter, requerirPermiso('factura:emitir'), async (req, res) => {
  try {
    const { clienteId, itbis: applyItbis, diasVence, esCotizacion, lineas } = facturaManualSchema.parse(req.body)
    const _permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
    const puedeOverridePrecio = _permisos.includes('sistema:owner') || _permisos.includes('pos:override_precio')
    const factura = await procesarFacturaPOS({ inputClienteId: clienteId, applyItbis, diasVence, esCotizacion, lineas, puedeOverridePrecio, empleadoId: req.user?.sub ?? null })
    await persistirVerifyHash(factura)
    auditReq(esCotizacion ? 'cotizacion:crear' : 'factura:manual', req, { facturaId: factura.id, ncf: factura.ncf, total: Number(factura.total), lineas: factura.lineas.length })
    res.status(201).json(factura)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos.', detail: e.errors })
    console.error('[FACTURA MANUAL]', e.message)
    res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Error al generar la factura.' })
  }
})




  return router;
}

module.exports = createPosRouter;
