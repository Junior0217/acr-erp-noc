/**
 * Generador centralizado de PDFs server-side con Puppeteer.
 *
 * Mantiene un browser instance reusado (cold start ~500ms, hot ~80ms/PDF).
 * El browser se cierra al SIGTERM para liberar memoria en Render.
 *
 * Build commands Render Linux:
 *   npm install
 *   npx puppeteer browsers install chrome   (descarga binario, ~170MB)
 */
const puppeteer = require('puppeteer')

let _browser = null
let _launching = null

async function getBrowser() {
  if (_browser?.isConnected()) return _browser
  if (_launching) return _launching
  // Flags específicos por OS. En Linux containers (Render): sandbox/zygote/single-process.
  // En Windows local (dev): solo flags básicos para no crashear.
  const isLinux = process.platform === 'linux'
  const args = isLinux
    ? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--font-render-hinting=medium',
      ]
    : [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=medium',
      ]
  _launching = puppeteer.launch({ headless: 'new', args })
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

// Graceful shutdown
process.on('SIGTERM', () => { cerrarBrowser() })
process.on('SIGINT',  () => { cerrarBrowser() })

/**
 * Renderiza HTML completo a PDF.
 * @param {string} html         HTML completo (con <html>, <head>, <body>)
 * @param {object} opts         Opciones: format, margin, landscape, scale
 * @returns {Promise<Buffer>}   PDF buffer
 */
async function generarPdfDocumento(html, opts = {}) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.emulateMediaType('print')
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 })

    const pdf = await page.pdf({
      format:           opts.format ?? 'Letter',
      printBackground:  true,
      preferCSSPageSize: false,
      margin: opts.margin ?? { top: '12mm', right: '12mm', bottom: '14mm', left: '12mm' },
      landscape:        opts.landscape ?? false,
      scale:            opts.scale ?? 1,
      displayHeaderFooter: false,
    })
    return Buffer.from(pdf)
  } finally {
    await page.close()
  }
}

module.exports = { generarPdfDocumento, cerrarBrowser, getBrowser }
