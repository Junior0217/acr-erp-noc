/**
 * backend/modules/admin/empresa/router.js
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

function createEmpresaRouter(deps) {
  const router = express.Router();

  const {
    prisma, auditReq, middlewares = {}, schemas = {}, helpers = {}, limiters = {},
    completarLogin, twoFAStore, challengeStore, warmChallengeStore, IDLE_TTL_MS,
    generarSiguienteCodigo, generarPdfDeFactura, buildPdfData, subirPdfAlStorage,
    invalidarPdfCache, renderPdfDoc, generarPdfDocumento, persistirVerifyHash,
    facturaVerifyHash, PUBLIC_VERIFY_BASE, emailTransporter, sendFacturaPDF,
    PERMISSIONS_MAP, VAULT_KEY, vaultEncrypt, vaultDecrypt,
    supabase, SUPABASE_BUCKET, INVENTORY_BUCKET, OT_FOTOS_BUCKET,
    KINDS_VALIDOS, KINDS_INVENTARIO, MIME_EXT,
    detectMimeFromBuffer, svgSeguro, comprimirImagen,
    esAssetUrlSegura, esUrlPublicaSegura, pathFromSupabaseUrl,
    signPortalToken, NIVEL_PROPIETARIO_ABSOLUTO, protegerPropietario,
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
    fmtPhone, fmtCedula, fmtRNC, getClientIp, reqFingerprint, computeDeviceHash, labelFromUA, bodyLimit,
    nullStr, optIdent, emptyStr, optCedulaRD,
  } = helpers;
  const {
    loginLimiter, totpLimiter, backupCodeLimiter, billingLimiter,
    uploadLimiter, uploadMulter, portalLoginLimiter, forgotLimiter,
    checkoutLimiter, catalogoPublicoLimiter, trackingLimiter,
    verifyLimiter, bulkPdfLimiter, pinVerifyLimiter,
  } = limiters;

  // === ROUTES (extraidas del monolito) =================================
// ─── EmpresaPerfil (Singleton ID=1) ──────────────────────────────────────────

// GET semi-público — campos de membrete + logos. Sin PII del representante.
const empresaPublicLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
router.get('/configuracion/empresa/publico', empresaPublicLimiter, async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: {
        rnc: true, razonSocial: true, nombreComercial: true, registroMercantil: true,
        direccion: true, sector: true, provincia: true, pais: true,
        telefono: true, email: true, website: true, assets: true, eslogan: true,
      },
    })
    if (!e) return res.status(404).json({ error: 'Perfil no inicializado.' })
    // Limpia el JSON de assets — sólo expone públicamente lo necesario para membrete:
    const safeAssets = {
      logoClaro:  e.assets?.logoClaro  ?? null,
      logoOscuro: e.assets?.logoOscuro ?? null,
    }
    res.json({ ...e, assets: safeAssets })
  } catch { res.status(500).json({ error: 'Error interno.' }) }
})

// GET autenticado — completo (incluye selloFisico, firmaGerente, PII representante)
router.get('/configuracion/empresa', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
    if (!e) return res.status(404).json({ error: 'Perfil no inicializado.' })
    res.json(e)
  } catch (err) {
    console.error('[GET /api/configuracion/empresa]', err.code, err.message, err.meta)
    res.status(500).json({ error: 'Error interno.', code: err.code ?? 'UNKNOWN' })
  }
})


// ─── Configurador secuencias (owner edita prefijos + actual + padding) ────────
router.get('/configuracion/secuencias', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const e = await prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { secuenciasConfig: true },
    })
    const config = (e?.secuenciasConfig && typeof e.secuenciasConfig === 'object') ? e.secuenciasConfig : {}
    // Merge defaults para que el frontend siempre reciba la lista completa, aunque
    // el owner solo haya configurado algunas entidades.
    const merged = {}
    for (const k of Object.keys(SECUENCIA_DEFAULTS)) {
      merged[k] = { ...SECUENCIA_DEFAULTS[k], ...(config[k] ?? {}) }
    }
    res.json({ secuencias: merged, defaults: SECUENCIA_DEFAULTS })
  } catch (e) {
    console.error('[GET secuencias]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

const secuenciaEntradaSchema = z.object({
  prefijo: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Solo mayúsculas y dígitos.'),
  actual:  z.coerce.number().int().min(0).max(99_999_999),
  padding: z.coerce.number().int().min(3).max(10),
})
const secuenciasPatchSchema = z.object({
  factura:    secuenciaEntradaSchema.optional(),
  cotizacion: secuenciaEntradaSchema.optional(),
  producto:   secuenciaEntradaSchema.optional(),
  servicio:   secuenciaEntradaSchema.optional(),
  cliente:    secuenciaEntradaSchema.optional(),
  rma:        secuenciaEntradaSchema.optional(),
  plan:       secuenciaEntradaSchema.optional(),
}).strict()

router.patch('/configuracion/secuencias', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  try {
    const data = secuenciasPatchSchema.parse(req.body)
    const current = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { secuenciasConfig: true } })
    const baseConfig = (current?.secuenciasConfig && typeof current.secuenciasConfig === 'object') ? current.secuenciasConfig : {}
    const next = { ...baseConfig, ...data }
    await prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: { secuenciasConfig: next },
      create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig: next },
    })
    auditReq('empresa:secuencias_update', req, { entidades: Object.keys(data) })
    res.json({ secuencias: next })
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[PATCH secuencias]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})

// Endpoint de preview: muestra cómo lucirá el próximo código sin consumir secuencia.
router.get('/configuracion/secuencias/preview/:entidad', verificarJWT, requerirPermiso('empresa:ver'), async (req, res) => {
  try {
    const entidad = req.params.entidad
    const def = SECUENCIA_DEFAULTS[entidad]
    if (!def) return res.status(400).json({ error: 'Entidad desconocida.' })
    const e = await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { secuenciasConfig: true } })
    const cfg = (e?.secuenciasConfig?.[entidad] ?? def)
    const next = Number(cfg.actual ?? def.actual) + 1
    res.json({ entidad, prefijo: cfg.prefijo, actual: cfg.actual, padding: cfg.padding, proximo: `${cfg.prefijo}-${String(next).padStart(cfg.padding, '0')}` })
  } catch (e) {
    res.status(500).json({ error: 'Error interno.' })
  }
})


// ─── Bulk migration de descripciones legacy -> formato estructurado v=1 ───────
// Endpoint de uso único (owner only). Recorre Producto + ItemCatalogo y, para
// cada fila cuya descripcion NO sea JSON v=1, aplica el parser primitivo:
//   linea 1  -> titulo (strip ** o # heading si aplica)
//   resto    -> bullets (strip prefijos -, *, •, ·, "1.")
// Idempotente: re-ejecutar no daña filas ya migradas (las salta).
function _parsearLegacyDescripcion(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Ya está en formato estructurado -> skip.
  if (trimmed.startsWith('{')) {
    try { const o = JSON.parse(trimmed); if (o?.v === 1) return null } catch {}
  }
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  let titulo = '', bullets = []
  const m = lines[0].match(/^\*\*(.+)\*\*\s*$/) || lines[0].match(/^#{1,6}\s+(.+)$/)
  if (m) { titulo = m[1].trim(); bullets = lines.slice(1) }
  else   { titulo = lines[0];    bullets = lines.slice(1) }
  bullets = bullets
    .map(l => l.replace(/^[-*•·]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map(b => b.slice(0, 200))
  return { v: 1, titulo: titulo.slice(0, 200), bullets }
}

router.post('/admin/migrar-descripciones', verificarJWT, requerirPermiso('sistema:owner'), async (req, res) => {
  const t0 = Date.now()
  const stats = { producto: { total: 0, migrados: 0, skipped: 0, errores: 0 },
                  itemCatalogo: { total: 0, migrados: 0, skipped: 0, errores: 0 } }
  try {
    // PRODUCTOS
    const productos = await prisma.producto.findMany({
      where:  { descripcion: { not: null } },
      select: { id: true, descripcion: true },
    })
    stats.producto.total = productos.length
    for (const p of productos) {
      const parsed = _parsearLegacyDescripcion(p.descripcion)
      if (!parsed) { stats.producto.skipped++; continue }
      try {
        await prisma.producto.update({
          where: { id: p.id },
          data:  { descripcion: JSON.stringify(parsed) },
        })
        stats.producto.migrados++
      } catch (e) {
        console.error(`[MIGRACION] producto ${p.id}:`, e.message)
        stats.producto.errores++
      }
    }
    // ITEM CATALOGO
    const items = await prisma.itemCatalogo.findMany({
      where:  { descripcion: { not: null } },
      select: { id: true, descripcion: true },
    })
    stats.itemCatalogo.total = items.length
    for (const it of items) {
      const parsed = _parsearLegacyDescripcion(it.descripcion)
      if (!parsed) { stats.itemCatalogo.skipped++; continue }
      try {
        await prisma.itemCatalogo.update({
          where: { id: it.id },
          data:  { descripcion: JSON.stringify(parsed) },
        })
        stats.itemCatalogo.migrados++
      } catch (e) {
        console.error(`[MIGRACION] itemCatalogo ${it.id}:`, e.message)
        stats.itemCatalogo.errores++
      }
    }
    auditReq('admin:migrar_descripciones', req, { stats, elapsedMs: Date.now() - t0 })
    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      stats,
      resumen: `Productos: ${stats.producto.migrados}/${stats.producto.total} migrados, ${stats.producto.skipped} ya estructurados. ItemCatalogo: ${stats.itemCatalogo.migrados}/${stats.itemCatalogo.total} migrados, ${stats.itemCatalogo.skipped} ya estructurados.`,
    })
  } catch (e) {
    console.error('[MIGRACION]', e.message)
    res.status(500).json({ ok: false, error: e.message, stats })
  }
})

// PATCH — permiso granular empresa:editar (puede asignarse a Owner o Admin desde UI roles).
// Telefono permite formato múltiple "X / Y" (ACR usa 2 líneas).
const empresaPatchSchema = z.object({
  rnc:                   z.string().min(9).max(20).optional(),
  razonSocial:           z.string().min(2).max(200).optional(),
  nombreComercial:       z.string().max(200).optional().nullable(),
  registroMercantil:     z.string().max(50).optional().nullable(),
  representanteNombre:   z.string().max(100).optional().nullable(),
  representanteApellido: z.string().max(100).optional().nullable(),
  representanteCedula:   z.string().max(20).optional().nullable().refine(
    v => !v || validarCedulaRD(v),
    { message: 'Cédula RD inválida (dígito verificador no coincide).' }
  ),
  representanteCargo:    z.string().max(80).optional().nullable(),
  direccion:             z.string().max(300).optional().nullable(),
  sector:                z.string().max(100).optional().nullable(),
  provincia:             z.string().max(100).optional().nullable(),
  pais:                  z.string().max(80).optional(),
  tipoEmpresa:           z.string().max(40).optional().nullable(),
  fechaInicio:           z.coerce.date().optional().nullable(),
  telefono:              z.string().max(80).optional().nullable(),
  fax:                   z.string().max(40).optional().nullable(),
  email:                 z.string().email().max(150).optional().nullable().or(z.literal('').transform(() => null)),
  website:               z.string().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  // URLs deben pasar whitelist: Supabase Storage del proyecto o path local. Bloquea tracking-pixels externos.
  assets:                z.object({
    logoClaro:    z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    logoOscuro:   z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    selloFisico:  z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    firmaGerente: z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
  }).partial().optional(),
  eslogan:               z.string().max(200).optional().nullable(),
  // PIN supervisor para autorizar descuentos POS sobre el umbral dinámico.
  pinSupervisor:         z.string().min(4).max(8).regex(/^\d+$/, 'Solo dígitos.').optional(),
  // Umbral % de descuento global a partir del cual el POS exige PIN supervisor.
  maxDescuentoCajero:    z.coerce.number().int().min(0).max(100).optional(),
  // Condiciones comerciales por defecto — cada campo opcional, max 280 char.
  // _obligatorio: flag por término que prohíbe ocultarlo a nivel de documento
  // (ni con PIN supervisor). El cart muestra candado + pill "Forzado" y el
  // backend mergeCondiciones ignora cualquier override que apague la fila.
  // El bug previo: este objeto no incluía _obligatorio en su shape Zod, así
  // que el .parse() lo descartaba silenciosamente y nunca llegaba a Prisma.
  condicionesDefault:    z.object({
    validez:      z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    pago:         z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    entrega:      z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    garantia:     z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
    _obligatorio: z.object({
      validez:  z.boolean().optional(),
      pago:     z.boolean().optional(),
      entrega:  z.boolean().optional(),
      garantia: z.boolean().optional(),
    }).partial().optional(),
  }).partial().optional(),
})

router.patch('/configuracion/empresa', verificarJWT, requerirPermiso('empresa:editar'), async (req, res) => {
  try {
    const data = empresaPatchSchema.parse(req.body)
    // H2: pinSupervisor + maxDescuentoCajero SOLO editables por sistema:owner.
    // Cambiar el PIN o bajar el umbral equivalen a bypass de descuentos.
    const _camposCriticos = ['pinSupervisor', 'maxDescuentoCajero'].filter(k => data[k] !== undefined)
    if (_camposCriticos.length > 0) {
      const permisos = Array.isArray(req.user?.permisos) ? req.user.permisos : []
      if (!permisos.includes('sistema:owner')) {
        auditReq('empresa:critical_edit_denied', req, { campos: _camposCriticos })
        return res.status(403).json({ error: 'Solo el propietario absoluto puede modificar PIN o umbral de descuento.', code: 'OWNER_REQUIRED' })
      }
      auditReq('empresa:critical_changed', req, { campos: _camposCriticos, maxDesc: data.maxDescuentoCajero })
    }
    // Snapshot previo: necesario para identificar URLs huérfanas a remover de Storage
    // cuando el cliente reemplaza o limpia un asset al guardar el form.
    const prevAssets = data.assets
      ? ((await prisma.empresaPerfil.findUnique({ where: { id: 1 }, select: { assets: true } }))?.assets ?? {})
      : null
    // Merge assets en el JSON existente (no sobreescribir si el cliente omite alguna URL)
    if (data.assets) {
      data.assets = { ...(prevAssets ?? {}), ...data.assets }
    }
    const e = await prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: data,
      create: { id: 1, rnc: data.rnc ?? '', razonSocial: data.razonSocial ?? 'Empresa', ...data },
    })
    auditReq('empresa:perfil_update', req, { campos: Object.keys(data) })

    // Fire-and-forget: limpia Storage de assets que ya no se referencian.
    // Sólo borra paths que viven en el bucket SUPABASE_BUCKET de ACR (validados por pathFromSupabaseUrl).
    if (prevAssets && supabase) {
      setImmediate(async () => {
        try {
          const paths = []
          for (const [k, oldUrl] of Object.entries(prevAssets)) {
            if (!oldUrl) continue
            const newUrl = data.assets?.[k]
            if (newUrl === oldUrl) continue
            const p = pathFromSupabaseUrl(oldUrl)
            if (p) paths.push(p)
          }
          if (paths.length === 0) return
          const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(paths)
          if (error) console.error('[EMPRESA PATCH CLEANUP]', error.message)
          else       console.log('[EMPRESA PATCH CLEANUP OK]', paths.length, 'paths')
        } catch (err) {
          console.error('[EMPRESA PATCH CLEANUP EXCEPTION]', err.message)
        }
      })
    }
    res.json(e)
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? 'Datos inválidos.' })
    console.error('[EMPRESA PATCH]', e.message)
    res.status(500).json({ error: 'Error interno.' })
  }
})




  return router;
}

module.exports = createEmpresaRouter;
