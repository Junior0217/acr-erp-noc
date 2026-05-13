/**
 * PDF generator: puppeteer-core + @sparticuz/chromium en prod (Render Linux Free Tier).
 * En dev local (Windows/Mac) detecta Chrome del sistema o respeta PUPPETEER_EXECUTABLE_PATH.
 *
 * Por qué este stack:
 *   - puppeteer normal descarga ~170MB Chrome en postinstall y corrompe el caché en Render
 *     (error: "The browser folder exists but the executable is missing").
 *   - @sparticuz/chromium trae binario optimizado (~50MB) compilado para Lambda/contenedores
 *     y se inicializa sin tocar caché — no requiere `npx puppeteer browsers install`.
 *
 * Variables opcionales:
 *   PUPPETEER_EXECUTABLE_PATH   — fuerza ruta al Chrome local (override universal)
 *   CHROMIUM_GRAPHICS=true      — habilita WebGL en sparticuz (no necesario para PDF)
 */
const puppeteer = require('puppeteer-core')
const path = require('path')
const fs = require('fs')

let _browser = null
let _launching = null

// ─── Embedding de assets remotos (logo / firma / sello) ──────────────────────
// Puppeteer no espera bien recursos externos (Supabase, S3) y a veces el PDF
// se imprime antes de cargar la imagen. Solución: fetch → buffer → data: URI
// inline en el HTML. Garantiza render instantáneo y evita request de red
// desde el contenedor headless.
const _assetCache = new Map() // url -> dataURI (LRU implícito, max 32)
const ASSET_CACHE_MAX = 32

function mimeFromUrl(url) {
  const u = url.split('?')[0].toLowerCase()
  if (u.endsWith('.png'))  return 'image/png'
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.webp')) return 'image/webp'
  if (u.endsWith('.svg'))  return 'image/svg+xml'
  if (u.endsWith('.gif'))  return 'image/gif'
  return null
}

function detectMimeFromMagic(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  const head = buf.slice(0, 200).toString('utf8').trim().toLowerCase()
  if (head.includes('<svg')) return 'image/svg+xml'
  return null
}

async function fetchToDataUri(url, { timeoutMs = 5000 } = {}) {
  if (!url) return null
  if (_assetCache.has(url)) return _assetCache.get(url)

  // Permite también paths locales (assets/logo.png, /opt/render/.../foo.png)
  if (url.startsWith('data:')) return url
  if (!/^https?:\/\//i.test(url)) {
    try {
      const abs = path.isAbsolute(url) ? url : path.join(__dirname, '..', url)
      if (fs.existsSync(abs)) {
        const buf = fs.readFileSync(abs)
        const mime = detectMimeFromMagic(buf) || mimeFromUrl(abs) || 'application/octet-stream'
        const uri = `data:${mime};base64,${buf.toString('base64')}`
        if (_assetCache.size >= ASSET_CACHE_MAX) _assetCache.delete(_assetCache.keys().next().value)
        _assetCache.set(url, uri)
        return uri
      }
    } catch {}
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: controller.signal })
    if (!r.ok) return null
    const ab = await r.arrayBuffer()
    const buf = Buffer.from(ab)
    const mime = detectMimeFromMagic(buf)
              || r.headers.get('content-type')?.split(';')[0]?.trim()
              || mimeFromUrl(url)
              || 'application/octet-stream'
    const uri = `data:${mime};base64,${buf.toString('base64')}`
    if (_assetCache.size >= ASSET_CACHE_MAX) _assetCache.delete(_assetCache.keys().next().value)
    _assetCache.set(url, uri)
    return uri
  } catch (e) {
    console.warn(`[pdf:asset] No se pudo embeber ${url}: ${e.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Convierte un objeto `assets` con URLs a un objeto con data: URIs.
 * Si un asset falla la descarga, queda null y la plantilla no lo renderiza.
 */
async function inlineAssets(assets) {
  if (!assets || typeof assets !== 'object') return {}
  const keys = Object.keys(assets).filter(k => typeof assets[k] === 'string' && assets[k])
  const entries = await Promise.all(keys.map(async k => [k, await fetchToDataUri(assets[k])]))
  const out = {}
  for (const [k, v] of entries) if (v) out[k] = v
  return out
}

const IS_LINUX = process.platform === 'linux'
const IS_PROD  = process.env.NODE_ENV === 'production'

// Lazy-load sparticuz solo cuando se necesita (evita warning en Windows dev).
function loadSparticuz() {
  try { return require('@sparticuz/chromium') } catch { return null }
}

function findLocalChrome() {
  const candidates = []
  if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH)
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium',
    )
  }
  const fs = require('fs')
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p } catch {}
  }
  return null
}

async function buildLaunchOptions() {
  // Prod o Linux container: usar sparticuz si disponible.
  if (IS_LINUX || IS_PROD) {
    const chromium = loadSparticuz()
    if (chromium) {
      return {
        args: [
          ...chromium.args,
          '--font-render-hinting=medium',
          '--hide-scrollbars',
          '--disable-web-security',
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      }
    }
  }
  // Dev local: detectar Chrome instalado.
  const execPath = findLocalChrome()
  if (!execPath) {
    throw new Error(
      'Chrome no detectado. Instala Google Chrome o establece PUPPETEER_EXECUTABLE_PATH.\n' +
      'En Render se usa automáticamente @sparticuz/chromium.'
    )
  }
  return {
    executablePath: execPath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--font-render-hinting=medium',
    ],
  }
}

async function getBrowser() {
  if (_browser?.connected) return _browser
  if (_launching) return _launching
  const opts = await buildLaunchOptions()
  _launching = puppeteer.launch(opts)
  try {
    _browser = await _launching
    _browser.on('disconnected', () => { _browser = null })
    return _browser
  } finally {
    _launching = null
  }
}

async function cerrarBrowser() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
  }
}

process.on('SIGTERM', () => { cerrarBrowser() })
process.on('SIGINT',  () => { cerrarBrowser() })

/**
 * Renderiza HTML completo a PDF.
 */
async function generarPdfDocumento(html, opts = {}) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.emulateMediaType('print')
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 })
    const pdf = await page.pdf({
      format:            opts.format ?? 'Letter',
      printBackground:   true,
      preferCSSPageSize: false,
      margin: opts.margin ?? { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      landscape:         opts.landscape ?? false,
      scale:             opts.scale ?? 1,
      displayHeaderFooter: false,
    })
    return Buffer.from(pdf)
  } finally {
    await page.close()
  }
}

module.exports = { generarPdfDocumento, cerrarBrowser, getBrowser, inlineAssets, fetchToDataUri }
