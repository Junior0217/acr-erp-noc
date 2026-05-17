/**
 * backend/shared/infra/supabase.js
 *
 * Cliente Supabase Storage + helpers de upload (MIME magic-byte detection,
 * sharp compresión, anti-SSRF). Centralizado para que routers / jobs /
 * sub-modulos no se acoplen a la SDK directa.
 *
 * Exports:
 *   - supabase                 (cliente SDK o null si no hay env)
 *   - SUPABASE_URL/KEY/BUCKET  (envs base)
 *   - INVENTORY_BUCKET         (bucket separado de inventario-img)
 *   - KINDS_VALIDOS            (kinds para empresa-assets)
 *   - KINDS_INVENTARIO         (kinds para inventario-img)
 *   - MIME_EXT                 (whitelist MIME → ext)
 *   - esAssetUrlSegura         (whitelist URL anti tracking-pixel)
 *   - esUrlPublicaSegura       (anti-SSRF: rechaza IPs privadas, localhost)
 *   - pathFromSupabaseUrl      (extrae path de URL pública/firmada)
 *   - detectMimeFromBuffer     (magic bytes — NO confía en Content-Type)
 *   - svgSeguro                (placeholder — bloquea SVG por XSS)
 *   - comprimirImagen          (resize 800x800 + PNG, sharp)
 */

const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const sharp = require('sharp');


const SUPABASE_URL    = process.env.SUPABASE_URL || ''
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'empresa-assets'
const supabase        = (SUPABASE_URL && SUPABASE_KEY)
  ? createSupabaseClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null

/**
 * Whitelist estricta: URLs en assets DEBEN pertenecer al Supabase configurado
 * o a paths locales (/logo-acr.png para defaults). Bloquea inyección de
 * tracking-pixels externos via URLs como https://attacker.com/x.png.
 */
function esAssetUrlSegura(url) {
  if (!url || typeof url !== 'string') return true               // null/'' permitido
  if (url.startsWith('/'))             return true               // path relativo del propio frontend
  if (url.startsWith('data:image/'))   return true               // data URI inline (preview)
  if (!SUPABASE_URL)                   return false              // sin Supabase config = todo URL externo rechazado
  // Acepta URLs que empiecen con SUPABASE_URL/storage/v1/object/...
  const allowed = SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/object/'
  return url.startsWith(allowed)
}

// Mime detection real (no confiar en header del cliente)
function detectMimeFromBuffer(buf) {
  if (!buf || buf.length < 4) return null
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  // SVG: '<svg' o '<?xml' al inicio (con o sin BOM)
  const head = buf.slice(0, 100).toString('utf8').trim()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml'
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

// M6: SVG bloqueado por completo. Aunque sanitize-html podía filtrar, los
// vectores XSS via SVG son demasiado ricos (xlink:href javascript:, <set>,
// <animate onbegin=, <use href=data:>). Para logos corporativos PNG/WebP cubre
// el 100% de casos prácticos sin la superficie de ataque.
function svgSeguro(_buf) { return false }

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const KINDS_VALIDOS = ['logoClaro', 'logoOscuro', 'selloFisico', 'firmaGerente']

// Extrae la ruta de Supabase Storage desde una URL pública.
// Ej: https://xxx.supabase.co/storage/v1/object/public/empresa-assets/acr/logo-123.webp → 'acr/logo-123.webp'
function pathFromSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return null
  const marker = `/object/public/${SUPABASE_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) {
    // También aceptar formato firmado /object/sign/<bucket>/...
    const signMarker = `/object/sign/${SUPABASE_BUCKET}/`
    const signIdx = url.indexOf(signMarker)
    if (signIdx === -1) return null
    return url.slice(signIdx + signMarker.length).split('?')[0]
  }
  return url.slice(idx + marker.length).split('?')[0]
}

// Comprime con sharp: resize 800x800 fit:inside (preserva aspect ratio), convierte a PNG.
// PNG es lossless + universalmente compatible con pdfkit, Chromium print-to-PDF y editores.
// WebP fue descartado: rompe pdfkit y editores legacy.
// SVG pasa intacto (vector, no necesita compresión raster).
async function comprimirImagen(buf, mime) {
  if (mime === 'image/svg+xml') {
    return { buffer: buf, mime: 'image/svg+xml', ext: 'svg' }
  }
  const out = await sharp(buf, { failOn: 'error' })
    .rotate()                                // respeta EXIF orientation
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 8, quality: 100, adaptiveFiltering: true, palette: false })
    .toBuffer()
  return { buffer: out, mime: 'image/png', ext: 'png' }
}

// (Las rutas /api/configuracion/empresa/upload + /api/inventario/upload-*
//  permanecen en server.js — usan estos helpers vía require de este módulo.)

// ─── Upload de imágenes de inventario (productos, categorías, items) ─────────
// Reutiliza la misma pipeline de comprimirImagen + supabase storage. Bucket
// SUPABASE_INVENTORY_BUCKET (default: inventario-img) — separado de empresa-assets
// para tener cleanup independiente y políticas distintas.
const INVENTORY_BUCKET = process.env.SUPABASE_INVENTORY_BUCKET ?? 'inventario-img'
const KINDS_INVENTARIO = ['producto', 'categoria', 'itemCatalogo']

function esUrlPublicaSegura(u) {
  try {
    const url = new URL(u)
    if (!/^https?:$/.test(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    // Bloqueo SSRF básico: localhost / IPs privadas. No es bulletproof
    // (DNS rebinding requeriría resolver y revalidar) pero cubre el 95%.
    if (host === 'localhost' || host === '0.0.0.0') return false
    if (/^127\./.test(host)) return false
    if (/^10\./.test(host))  return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    if (host.endsWith('.local')) return false
    return true
  } catch { return false }
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPABASE_BUCKET,
  INVENTORY_BUCKET,
  KINDS_VALIDOS,
  KINDS_INVENTARIO,
  MIME_EXT,
  supabase,
  esAssetUrlSegura,
  esUrlPublicaSegura,
  detectMimeFromBuffer,
  svgSeguro,
  pathFromSupabaseUrl,
  comprimirImagen,
};
