/**
 * backend/modules/admin/ops/router.js
 *
 * Auto-extraido de routes/admin.js (Stage 4 DDD split).
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


function createOpsRouter(deps) {
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
  } = deps;
  const {
    verificarJWT, verificarPortalJWT, requerirPermiso, requerirNivel,
    esPropietarioAbsoluto, requerirTOTP, requerirTOTPEstricto, vaultCooldownGuard,
  } = middlewares;
  const {
    passwordSchema, empleadoSchema, empleadoUpdateSchema, asistenciaSchema,
    clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema,
    prospectoSchema, prospectoUpdateSchema,
  } = schemas;
  const {
    validUUID, rejectBadId, sendErr, sendOk, validarCedulaRD,
    formatCliente, formatSuplidor, formatProspecto,
    fmtPhone, fmtCedula, fmtRNC, nullStr, optIdent, emptyStr, optCedulaRD,
  } = helpers;
  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, empresaPublicLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) =================================
  // ─── Mapa NOC ─────────────────────────────────────────────────────────────
  router.get('/mapa-noc', async (req, res) => {
    try {
      const [clientes, suplidores, prospectos, nC, nS, nP] = await Promise.all([
        prisma.cliente.findMany({
          select: { id: true, razonSocial: true, latitud: true, longitud: true, activo: true, telefonoPrincipal: true, servicios: { select: { plan: { select: { tipo: true } } }, where: { estado: 'Activo' }, take: 1 } },
          where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
        }),
        prisma.suplidor.findMany({
          select: { id: true, razonSocial: true, latitud: true, longitud: true, activo: true, actividad: true, telefonoPrincipal: true },
          where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
        }),
        prisma.prospecto.findMany({
          select: { id: true, nombre: true, latitud: true, longitud: true, estado: true, servicioInteresado: true, telefono: true },
          where: { AND: [{ latitud: { not: null } }, { longitud: { not: null } }] },
        }),
        prisma.cliente.count(),
        prisma.suplidor.count(),
        prisma.prospecto.count(),
      ]);

      const toMarker = (list, tipo) => list.flatMap(r => {
        const lat = parseFloat(r.latitud);
        const lng = parseFloat(r.longitud);
        if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return [];
        return [{
          id:      r.id,
          tipo,
          nombre:  r.razonSocial ?? r.nombre,
          lat, lng,
          activo:  r.activo ?? null,
          estado:  r.estado ?? null,
          servicio: r.servicios?.[0]?.plan?.tipo ?? r.actividad ?? r.servicioInteresado,
          telefono: fmtPhone(r.telefonoPrincipal ?? r.telefono),
        }];
      });

      res.json({
        markers: [
          ...toMarker(clientes,   'cliente'),
          ...toMarker(suplidores, 'suplidor'),
          ...toMarker(prospectos, 'prospecto'),
        ],
        totales: { clientes: nC, suplidores: nS, prospectos: nP },
      });
    } catch {
      res.status(500).json({ error: 'Error al obtener mapa NOC' });
    }
  });


  // ─── Incidencias de reconciliación ────────────────────────────────────────
  router.get('/incidencias', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
    try {
      const { tipo, severidad, resueltas } = req.query;
      const where = {};
      if (tipo)      where.tipo      = tipo;
      if (severidad) where.severidad = severidad;
      if (resueltas === 'true')  where.resueltoEn = { not: null };
      if (resueltas === 'false') where.resueltoEn = null;
      const data = await prisma.incidenciaReconciliacion.findMany({
        where,
        orderBy: [{ resueltoEn: 'asc' }, { createdAt: 'desc' }],
        take: 200,
        include: { empleado: { select: { id: true, nombre: true } } },
      });
      res.json({ data });
    } catch { res.json({ data: [], _error: 'Error obteniendo incidencias' }); }
  });

  router.patch('/incidencias/:id/resolver', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    const { resolucion } = z.object({ resolucion: z.string().min(3).max(500) }).parse(req.body);
    try {
      const inc = await prisma.incidenciaReconciliacion.update({
        where: { id },
        data:  { resueltoEn: new Date(), resolucion, asignadoA: req.user.sub },
      });
      auditReq('reconciliacion:resolver', req, { incidenciaId: id });
      res.json(inc);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Incidencia no encontrada.' });
      res.status(500).json({ error: 'Error interno.' });
    }
  });


// ─── Anti brute-force: in-memory tally + DB-persisted IpBlock ────────────────

const TRACK_FAIL_WINDOW_MS  = 5  * 60 * 1000      // 5 min sliding window
const TRACK_FAIL_THRESHOLD  = 5                   // 5 failures triggers block
const TRACK_BLOCK_DURATION  = 30 * 60 * 1000      // 30 min block

const failTally    = new Map()  // ip -> { count, firstFail }
const activeBlocks = new Map()  // ip -> expiresAt(ms)

async function hydrateIpBlocks() {
  try {
    const blocks = await prisma.ipBlock.findMany({ where: { expiraEn: { gt: new Date() } } })
    for (const b of blocks) activeBlocks.set(b.ip, b.expiraEn.getTime())
    console.log(`[IpBlock] hydrated ${blocks.length} active block(s)`)
  } catch (e) { console.error('[IpBlock hydrate]', e.message) }
}
hydrateIpBlocks()

function getClientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
       || req.socket?.remoteAddress
       || 'unknown').replace(/^::ffff:/, '')
}

function isIpBlocked(ip) {
  const exp = activeBlocks.get(ip)
  if (!exp) return false
  if (exp < Date.now()) { activeBlocks.delete(ip); return false }
  return true
}

async function registerTrackFailure(ip, motivo) {
  const now = Date.now()
  const entry = failTally.get(ip)
  if (!entry || (now - entry.firstFail) > TRACK_FAIL_WINDOW_MS) {
    failTally.set(ip, { count: 1, firstFail: now })
    return false
  }
  entry.count++
  if (entry.count >= TRACK_FAIL_THRESHOLD) {
    failTally.delete(ip)
    const expiraEn = new Date(now + TRACK_BLOCK_DURATION)
    activeBlocks.set(ip, expiraEn.getTime())
    try {
      await prisma.ipBlock.create({ data: { ip, motivo, intentos: TRACK_FAIL_THRESHOLD, expiraEn } })
      auditReq('security:ip_block', { headers: {}, socket: { remoteAddress: ip }, originalUrl: '/track' }, { ip, motivo, hasta: expiraEn })
    } catch (e) { console.error('[IpBlock persist]', e.message) }
    return true
  }
  return false
}

const trackingLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
router.get('/track/:pin', trackingLimiter, async (req, res) => {
  const ip = getClientIp(req)
  if (isIpBlocked(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. IP bloqueada temporalmente.' })
  }
  const pinRaw = (req.params.pin || '').toUpperCase()
  if (!/^[A-Z2-9]{6}$/.test(pinRaw)) {
    await registerTrackFailure(ip, 'PIN formato inválido')
    return res.status(400).json({ error: 'PIN inválido.' })
  }
  try {
    const t = await prisma.ticketTaller.findUnique({
      where:  { codigoPin: pinRaw },
      select: {
        noTicket: true, equipo: true, marca: true, modelo: true, estado: true,
        recibidoEn: true, diagnosticadoEn: true, listoEn: true, entregadoEn: true,
        diagnostico: true, costoEstimado: true,
        cliente: { select: { razonSocial: true } },
      },
    })
    if (!t) {
      await registerTrackFailure(ip, 'PIN no encontrado')
      return res.status(404).json({ error: 'Ticket no encontrado.' })
    }
    res.json(t)
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})


// ─── API Dictionary: endpoint meta / introspección ────────────────────────────

// Mapping path -> módulo de negocio (NO refactor de URLs, solo agrupación lógica)
const MODULE_MAP = [
  { test: /^\/api\/_meta/,                                    modulo: 'Sistema',         emoji: '⚙️' },
  { test: /^\/api\/health/,                                   modulo: 'Sistema',         emoji: '⚙️' },
  { test: /^\/api\/auth\//,                                   modulo: 'Autenticación',   emoji: '🔐' },
  { test: /^\/api\/incidencias/,                              modulo: 'Seguridad',       emoji: '🛡️' },
  { test: /^\/api\/credenciales/,                             modulo: 'Seguridad (Vault)', emoji: '🔑' },
  { test: /^\/api\/empleados/,                                modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/asistencia/,                               modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/roles/,                                    modulo: 'RRHH',            emoji: '👥' },
  { test: /^\/api\/clientes/,                                 modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/suplidores/,                               modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/prospectos/,                               modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/usuarios-portal/,                          modulo: 'CRM',             emoji: '🤝' },
  { test: /^\/api\/(productos|categorias|inventario|kardex)/, modulo: 'Inventario',      emoji: '📦' },
  { test: /^\/api\/prestamos/,                                modulo: 'Inventario',      emoji: '📦' },
  { test: /^\/api\/(items-catalogo|catalogo)/,                modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/(facturas|cotizaciones|cotizacion|ncf)/,   modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/ordenes/,                                  modulo: 'Ventas',          emoji: '💼' },
  { test: /^\/api\/(servicios|planes|plantillas)/,            modulo: 'Servicios',       emoji: '🛠️' },
  { test: /^\/api\/taller/,                                   modulo: 'Taller (RMA)',    emoji: '🔧' },
  { test: /^\/api\/track/,                                    modulo: 'Tracking Público',emoji: '📍' },
  { test: /^\/api\/activos-cliente/,                          modulo: 'CMDB',            emoji: '🗂️' },
  { test: /^\/api\/reportes/,                                 modulo: 'Reportes',        emoji: '📊' },
  { test: /^\/api\/dashboard/,                                modulo: 'Dashboard',       emoji: '📈' },
  { test: /^\/api\/mapa-noc/,                                 modulo: 'NOC / Mapa',      emoji: '🗺️' },
  { test: /^\/api\/portal\/(auth|sos|dashboard|cotizacion|catalogo|checkout|settings|facturas)/, modulo: 'Portal B2C', emoji: '🌐' },
  { test: /^\/api\/webhooks/,                                 modulo: 'Webhooks',        emoji: '🪝' },
  { test: /^\/api\/carrito/,                                  modulo: 'Ventas',          emoji: '💼' },
]
function resolveModule(path) {
  for (const m of MODULE_MAP) if (m.test.test(path)) return { modulo: m.modulo, emoji: m.emoji }
  return { modulo: 'Otros', emoji: '❓' }
}

// Express 5.x: usa app.router (NO app._router). Robusto contra middlewares anidados.
function _scanRoutes(app) {
  const out = []
  const router = app.router ?? app._router // Express 5 vs 4 compat
  if (!router || !Array.isArray(router.stack)) return out

  function walk(stack, basePath = '') {
    for (const layer of stack) {
      try {
        if (layer.route) {
          // Express 5: route.path puede ser string, array de strings, o RegExp
          let pathStr = layer.route.path
          if (Array.isArray(pathStr)) pathStr = pathStr[0]
          if (pathStr instanceof RegExp) pathStr = pathStr.toString()
          if (typeof pathStr !== 'string') pathStr = String(pathStr ?? '')
          const path = basePath + pathStr
          const methodsObj = layer.route.methods || {}
          const methods = Object.keys(methodsObj).filter(m => methodsObj[m])
          for (const m of methods) {
            const handlerNames = (layer.route.stack || []).map(s => s?.name).filter(Boolean)
            const auth =
              handlerNames.includes('verificarJWT')          ? 'JWT'        :
              handlerNames.includes('verificarPortalJWT')    ? 'PortalJWT'  :
              handlerNames.some(h => /Limiter$/.test(h))     ? 'rate-limit' :
              'public'
            const permiso =
              handlerNames.find(h => h.startsWith('requerirPermiso')) ? 'role-restricted' : null
            const { modulo, emoji } = resolveModule(path)
            out.push({ method: m.toUpperCase(), path, modulo, emoji, auth, permiso })
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          walk(layer.handle.stack, basePath)
        }
      } catch (e) {
        console.error('[SCAN ROUTES] skip layer:', e.message)
      }
    }
  }
  walk(router.stack)
  return out
}

let _routesCache = null
router.get('/_meta/endpoints', verificarJWT, requerirPermiso('sistema:owner'), (req, res) => {
  try {
    if (!_routesCache || req.query.refresh === '1') {
      _routesCache = _scanRoutes(app)
        .filter(r => r.path.startsWith('/'))
        .sort((a, b) => a.modulo.localeCompare(b.modulo) || a.path.localeCompare(b.path))
    }
    const grouped = _routesCache.reduce((acc, r) => {
      const key = `${r.emoji} ${r.modulo}`
      ;(acc[key] = acc[key] || []).push(r)
      return acc
    }, {})
    res.json({
      total:     _routesCache.length,
      endpoints: _routesCache,
      grouped,
      modulos:   Object.keys(grouped).sort(),
      generadoEn: new Date(),
    })
  } catch (e) {
    console.error('[META ENDPOINTS]', e.message, e.stack)
    res.json({ total: 0, endpoints: [], grouped: {}, modulos: [], _error: 'Error escaneando rutas: ' + e.message })
  }
})


// ─── UsuarioPortal: Owner reset password (no revelar — bcrypt one-way) ───────

router.post('/usuarios-portal/:id/reset-password', verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const nuevoPassword = crypto.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + 'A1!'
    const hash = await bcrypt.hash(nuevoPassword, 12)
    const u = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { passwordHash: hash },
      select: { id: true, noUsuario: true, nombre: true, email: true },
    })
    auditReq('portal:password_reset_owner', req, { usuarioId: u.id, email: u.email })
    // Response devuelve el password temporal UNA VEZ (no se persiste en claro)
    res.json({ usuario: u, passwordTemporal: nuevoPassword, mensaje: 'Comparte este password con el cliente por canal seguro. Se mostrará una sola vez.' })
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' })
    console.error('[PORTAL RESET OWNER]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.post('/usuarios-portal/:id/bloquear', verificarJWT, requerirNivel(NIVEL_PROPIETARIO_ABSOLUTO), async (req, res) => {
  if (!validUUID(req.params.id)) return res.status(400).json({ error: 'ID inválido.' })
  try {
    const u = await prisma.usuarioPortal.update({
      where:  { id: req.params.id },
      data:   { activo: false },
      select: { id: true, activo: true },
    })
    auditReq('portal:bloquear_owner', req, { usuarioId: u.id })
    res.json(u)
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Usuario portal no encontrado.' })
    res.status(500).json({ error: 'Error interno.' })
  }
})


// ─── Verificación pública anti-tamper ─────────────────────────────────────────
// Genera el HMAC sobre cada factura activa y matchea el `:hash` que viene en el
// QR/link del PDF. NO valida contra una columna almacenada — el hash siempre
// se RECOMPUTA, así un PDF alterado revela inconsistencia (cambia el monto en
// Photoshop -> el hash mostrado ya no matchea con el real).
const verifyLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })

router.get('/publico/verify/:hash', verifyLimiter, async (req, res) => {
  try {
    const hash = String(req.params.hash || '').toLowerCase()
    if (!/^[a-f0-9]{24}$/.test(hash)) return res.status(400).json({ valid: false, error: 'Hash inválido.' })
    if (VERIFY_HASH_DEBUG) console.log(`[HASH verify-in] hash=${hash}`)

    // H4: lookup O(log n) por columna indexada verifyHash. Fallback al scan legacy
    // si la fila aún no tiene hash precomputado (facturas pre-H4 deployment).
    let match = await prisma.factura.findFirst({
      where:  { deletedAt: null, verifyHash: hash },
      select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
    })
    if (!match) {
      // Fallback expandido: facturas legacy sin verifyHash O con verifyHash
      // distinto (drift de normalización antes de cache-bust). Scan acotado.
      // Acepta ambos: rows sin hash (legacy puro) y rows con hash divergente
      // (post-cambio normalización) — recomputa y compara contra el hash entrante.
      const candidatos = await prisma.factura.findMany({
        where:  { deletedAt: null, OR: [{ verifyHash: null }, { verifyHash: { not: hash } }] },
        select: { id: true, noFactura: true, ncf: true, total: true, fechaEmision: true, estado: true, esCotizacion: true, clienteId: true },
        orderBy:{ fechaEmision: 'desc' },
        take:   20000,
      })
      match = candidatos.find(f => facturaVerifyHash(f, 'verify-scan') === hash) ?? null
      // Self-heal: backfill el hash en la primera consulta exitosa. Sobrescribe
      // cualquier verifyHash divergente para que el lookup O(log n) funcione
      // en el próximo scan sin caer al scan secuencial.
      if (match) {
        prisma.factura.update({ where: { id: match.id }, data: { verifyHash: hash } }).catch(() => {})
      }
    }
    const empresa = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { razonSocial: true, rnc: true } })
    if (!match) return res.status(404).json({ valid: false, error: 'Documento no encontrado o alterado.' })

    const cliente = await prisma.cliente.findUnique({ where: { id: match.clienteId }, select: { razonSocial: true } }).catch(() => null)
    res.json({
      valid:       true,
      tipo:        match.esCotizacion ? 'cotizacion' : 'factura',
      noFactura:   match.noFactura,
      ncf:         match.ncf,
      fechaEmision: match.fechaEmision,
      total:       Number(match.total),
      estado:      match.estado,
      cliente:     cliente?.razonSocial ?? null,
      empresa:     empresa ? { razonSocial: empresa.razonSocial, rnc: empresa.rnc } : null,
    })
  } catch (e) {
    console.error('[VERIFY]', e.code, e.message)
    res.status(500).json({ valid: false, error: 'Error interno.' })
  }
})

// Endpoint público para portal B2C (descarga su propia factura)
router.get('/portal/facturas/:id/pdf-v2', verificarPortalJWT, async (req, res) => {
  try {
    const fact = await prisma.factura.findUnique({
      where:   { id: req.params.id },
      include: { cliente: true, lineas: { include: { producto: { select: { sku: true, nombre: true } } } } },
    })
    if (!fact || fact.clienteId !== req.portalUser.clienteId) return res.status(404).json({ error: 'No encontrada.' })
    const data = await buildPdfData(fact)
    const html = renderPdfDoc({
      tipo:        fact.esCotizacion ? 'cotizacion' : 'factura',
      numero:      fact.noFactura,
      ...data,
    })
    const pdfBuf = await generarPdfDocumento(html)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${fact.noFactura}.pdf"`)
    res.end(pdfBuf)
  } catch (e) {
    console.error('[PDF PORTAL]', e.message)
    res.status(500).json({ error: 'Error generando PDF.' })
  }
})

// ─── AuditCaja: vista para owner (Fase 1.4) ──────────────────────────────────
// Lista ordenada DESC por createdAt; filtro opcional ?tipo=<event>; cap 500.
router.get('/auditoria/caja', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const { tipo, limit = '100' } = req.query
    const where = {}
    if (tipo) where.tipo = tipo
    const rows = await prisma.auditCaja.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(parseInt(limit) || 100, 500),
    })
    res.json({ data: rows })
  } catch (e) {
    console.error('[GET /api/auditoria/caja]', e.code, e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// ─── Verificadores de integridad de hash chain (Fase 1.4) ────────────────────
// AuditCaja + AuditLog usan hash-chain HMAC-SHA256. Estas rutas recorren las
// últimas N filas, recalculan hash localmente y reportan inconsistencias —
// detecta cualquier reescritura post-facto de tablas append-only. Coste O(N).
const AUDIT_SECRET_OPS = process.env.AUDIT_SECRET ?? process.env.JWT_SECRET ?? 'change-me-audit-secret'

function _canonicalizarCaja(row) {
  const safe = {
    tipo:        row.tipo ?? '',
    empleadoId:  row.empleadoId ?? null,
    facturaId:   row.facturaId ?? null,
    monto:       row.monto != null ? String(row.monto) : null,
    descPct:     row.descPct != null ? String(row.descPct) : null,
    detalle:     row.detalle ?? '',
    ip:          row.ip ?? null,
    createdAt:   row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  }
  return JSON.stringify(safe, Object.keys(safe).sort())
}

const { _canonicalizarLog } = require('../../../shared/services/audit.service')

router.get('/auditoria/caja/verify', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10), 5000)
    const rows = await prisma.auditCaja.findMany({ orderBy: { id: 'asc' }, take: limit })
    let prev = 'GENESIS'
    let roto = null
    for (const r of rows) {
      if (!r.hash) continue
      const expected = crypto.createHmac('sha256', AUDIT_SECRET_OPS).update(_canonicalizarCaja(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex')
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }; break
      }
      prev = r.hash
    }
    res.json({ ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto })
  } catch (e) {
    console.error('[AUDIT VERIFY caja]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

router.get('/auditoria/log/verify', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10), 5000)
    const rows = await prisma.auditLog.findMany({ orderBy: { id: 'asc' }, take: limit })
    let prev = 'GENESIS'
    let roto = null
    for (const r of rows) {
      if (!r.hash) continue
      const expected = crypto.createHmac('sha256', AUDIT_SECRET_OPS).update(_canonicalizarLog(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex')
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }; break
      }
      prev = r.hash
    }
    res.json({ ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto })
  } catch (e) {
    console.error('[AUDIT VERIFY log]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

  return router;
}

module.exports = createOpsRouter;
