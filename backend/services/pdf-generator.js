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

let _browser = null
let _launching = null

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

module.exports = { generarPdfDocumento, cerrarBrowser, getBrowser }
