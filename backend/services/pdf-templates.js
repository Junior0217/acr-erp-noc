/**
 * Plantillas HTML corporativas para Facturas y Cotizaciones.
 *
 * Cero hardcode: todos los datos de empresa salen de `EmpresaPerfil` (singleton id=1).
 * Diseño: encabezado tipo banco con banda corporativa, tabla densa con header oscuro,
 * totales contables, firma con superposición elegante de sello + firma escaneada.
 *
 * Paleta:
 *   Corporate dark   #0f172a   (slate-900)
 *   Corporate accent #1e40af   (blue-800)
 *   Slate            #475569 / #64748b / #94a3b8
 *   Border           #e2e8f0
 *   Bg-zebra         #f8fafc
 *
 * Convenciones:
 *   - Letter (8.5×11"), márgenes manejados internamente (Puppeteer margin: 0)
 *   - Una sola página hasta ~18 líneas; tabla rompe limpio si excede
 *   - Sin emojis, sin texto decorativo: estilo banco corporativo
 */

const { marked } = require('marked')
const sanitizeHtml = require('sanitize-html')

// Markdown ligero -> HTML seguro para incrustar en filas de la tabla del PDF.
// Permite: **negrita**, *cursiva*, listas con - / 1., saltos de línea.
// Sin tablas, sin imágenes, sin iframes, sin scripts.
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false })
const SANITIZE_OPTS = {
  allowedTags: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'ul', 'ol', 'li', 'code'],
  allowedAttributes: {},
  allowedSchemes: [],
  transformTags: {
    'p': (tagName, attribs) => ({ tagName: 'span', attribs }),
  },
}

function mdToHtml(s) {
  if (!s) return ''
  try {
    const html = marked.parse(String(s))
    return sanitizeHtml(html, SANITIZE_OPTS)
  } catch { return escape(s) }
}

// ─── Parseo estructurado de descripción de línea ─────────────────────────────
// El usuario quiere alta jerarquía visual:
//   Línea 1 (desc-main, bold):   titulo
//   Línea 2 (desc-sub, gray):    bullets unidos por ' · '
//   Línea 3 (desc-sku, mono):    SKU
//
// Reglas:
//   - Si la descripción tiene una lista markdown (- item / 1. item), TODOS los
//     bullets se aplanan a una sola línea separada por '·' (ahorra espacio).
//   - Si tiene **título** o ## título en la primera línea, ese es desc-main.
//   - Si no hay título, la 1ra línea no-vacía es desc-main; el resto va a sub.
//   - Si llega `detalle` separado (legacy), pasa entero a desc-sub.
// Extrae "SKU: XXX" / "SKU XXX" / "SKU - XXX" desde cualquier posición del string
// y devuelve el SKU + el texto limpio (sin la frase del SKU). Permite al usuario
// escribir el SKU en cualquier lugar y el template lo renderice en su línea propia.
function extraerSku(text) {
  const m = String(text).match(/\s*\bSKU\s*[:#\-]?\s*([A-Z0-9][A-Z0-9_\-]{2,40})\b\.?\s*/i)
  if (!m) return { texto: text, sku: null }
  return { texto: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), sku: m[1] }
}

// Delimitadores inline reconocidos como separador título/detalles cuando NO hay
// saltos de línea. Orden importa: el PRIMERO encontrado parte el título.
const INLINE_SEPS = [' — ', ' – ', ' · ', ' - ', ' | ', ': ']

function splitInlineTituloDetalles(text) {
  let bestIdx = -1, bestSep = null
  for (const sep of INLINE_SEPS) {
    const i = text.indexOf(sep)
    if (i > 0 && (bestIdx === -1 || i < bestIdx)) { bestIdx = i; bestSep = sep }
  }
  if (bestIdx === -1) return { titulo: text, resto: '' }
  return { titulo: text.slice(0, bestIdx).trim(), resto: text.slice(bestIdx + bestSep.length).trim() }
}

// Formato estructurado nativo: la UI Producto/Servicio/ItemCatalogo guarda
// JSON.stringify({v:1, titulo, bullets:[], imagenUrl?}). Si lo detectamos,
// renderizamos directo sin pasar por el parser Markdown legacy.
function _tryParseEstructurada(raw) {
  if (typeof raw !== 'string' || raw.length < 2 || raw[0] !== '{') return null
  try {
    const obj = JSON.parse(raw)
    if (obj && obj.v === 1 && typeof obj.titulo === 'string') return obj
  } catch {}
  return null
}

function parseDescripcionEstructurada(descRaw, detalleRaw) {
  if (!descRaw && !detalleRaw) return { main: '', sub: '', sku: null }
  if (!descRaw) return { main: escape(detalleRaw), sub: '', sku: null }

  // Formato estructurado nativo (UI nueva). Lo procesamos sin tocar el parser legacy.
  const estructurado = _tryParseEstructurada(descRaw)
  if (estructurado) {
    const main = estructurado.titulo ? escape(estructurado.titulo) : ''
    const bullets = Array.isArray(estructurado.bullets) ? estructurado.bullets : []
    const sub  = bullets.length ? bullets.map(b => escape(b)).join(' · ') : ''
    return { main, sub, sku: null }
  }

  // 1) Extrae SKU primero — puede venir en cualquier parte del texto.
  const skuOut = extraerSku(String(descRaw))
  const text   = skuOut.texto.trim()
  const skuExtraido = skuOut.sku

  // 2) Modo vertical: hay saltos de línea -> trata cada línea.
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  let main = ''
  let bulletsRaw = []
  let otrosRaw   = []

  if (lines.length >= 2) {
    const first = lines[0]
    const mBold = first.match(/^\*\*(.+)\*\*\s*$/)
    const mHead = first.match(/^#{1,6}\s+(.+)$/)
    if (mBold || mHead) { main = (mBold ? mBold[1] : mHead[1]).trim() }
    else {
      const allBullets = lines.every(l => /^[-*•·]\s+/.test(l) || /^\d+\.\s+/.test(l))
      if (!allBullets) main = first
    }
    const rest = main ? lines.slice(1) : lines
    for (const l of rest) {
      const m = l.match(/^[-*•·]\s+(.+)$/) || l.match(/^\d+\.\s+(.+)$/)
      if (m) bulletsRaw.push(m[1].trim()); else otrosRaw.push(l)
    }
  } else if (lines.length === 1) {
    // 3) Modo horizontal: el usuario escribió todo de corrido. Detecta el primer
    // separador inline (` — `, ` - `, ` · `, ` | `, `: `, ` – `) y divide en
    // título/detalles. Los detalles se aplanan por los mismos separadores.
    const only = lines[0]
    const split = splitInlineTituloDetalles(only)
    if (split.resto) {
      main = split.titulo
      bulletsRaw = split.resto
        .split(/\s+[-·—–|]\s+|\s*,\s+(?=[A-ZÁÉÍÓÚÑa-z])/)
        .map(s => s.trim()).filter(Boolean)
    } else {
      main = only
    }
  }

  if (detalleRaw && String(detalleRaw).trim()) otrosRaw.unshift(String(detalleRaw).trim())
  const subPieces = []
  if (otrosRaw.length)   subPieces.push(otrosRaw.join(' '))
  if (bulletsRaw.length) subPieces.push(bulletsRaw.join(' · '))

  return {
    main: main ? mdToHtml(main) : '',
    sub:  subPieces.length ? mdToHtml(subPieces.join(' · ')) : '',
    sku:  skuExtraido,
  }
}

function fmtMoney(n) {
  return new Intl.NumberFormat('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0)
}

function fechaCorta(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function fechaLarga(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' })
}

function escape(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function buildDireccion(parts) {
  return parts.filter(Boolean).map(p => String(p).trim()).filter(Boolean).join(', ')
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: Letter; margin: 0; }
html, body {
  font-family: 'Inter', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif;
  color: #0f172a; font-size: 10px; line-height: 1.4;
  -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  background: white;
}
.mono { font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.tabular { font-variant-numeric: tabular-nums; }

/* ───── Page wrapper ───── */
.sheet {
  width: 8.5in; min-height: 11in;
  padding: 0; position: relative; overflow: hidden;
}

/* ───── Top corporate band (print-friendly: gris claro, ahorra tinta) ───── */
.band {
  height: 3px; width: 100%;
  background: #cbd5e1;
}

/* ───── Header ───── */
/* Padding superior reducido + logo más chico = ~30px menos en la zona alta.
   Ese espacio se libera para la tabla de artículos al final de la hoja. */
.header {
  display: grid; grid-template-columns: 1fr 1fr;
  padding: 12px 36px 10px;
  border-bottom: 1px solid #e2e8f0;
  gap: 18px;
  align-items: center;
}
.brand { display: flex; align-items: center; gap: 14px; }
.logo {
  width: 96px; height: 96px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
.brand-info .razon { font-size: 14.5px; font-weight: 800; color: #0f172a; letter-spacing: -0.005em; line-height: 1.15; }
.brand-info .nombre-comercial { font-size: 10px; color: #1e40af; font-weight: 600; margin-top: 2px; letter-spacing: 0.02em; text-transform: uppercase; }
.brand-info .eslogan { font-size: 9px; color: #64748b; margin-top: 3px; font-style: italic; max-width: 260px; }

.corp-meta { text-align: right; font-size: 9.5px; color: #475569; line-height: 1.55; }
.corp-meta .row { display: flex; justify-content: flex-end; align-items: baseline; gap: 6px; }
.corp-meta .lbl { color: #94a3b8; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; min-width: 56px; text-align: right; }
.corp-meta .val { color: #0f172a; font-weight: 600; }
/* Dirección sin etiqueta — texto puro alineado a la derecha. Color un poco
   más tenue para que no compita con razón social ni RNC, pero perfectamente
   legible. Sin font-weight bold para distinguirla de valores fiscales. */
.corp-meta .val-direccion { color: #334155; font-weight: 500; max-width: 280px; text-align: right; }

/* ───── Document title bar (print-friendly: fondo claro, texto oscuro) ───── */
/* Padding reducido — antes 14px arriba/abajo, ahora 9px. Mismo peso visual
   con ~10px menos por arriba y ~10px por abajo = 20px más para la tabla. */
.title-bar {
  background: #f1f5f9;
  color: #0f172a;
  padding: 9px 36px;
  display: grid; grid-template-columns: 1fr auto; align-items: center;
  gap: 20px;
  border-top: 1px solid #e2e8f0;
  border-bottom: 1px solid #e2e8f0;
}
.doc-type {
  font-size: 17px; font-weight: 800; letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #1e293b;
}
.doc-type .sub { font-size: 8.5px; font-weight: 500; color: #64748b; letter-spacing: 0.14em; display: block; margin-top: 1px; }
.doc-meta { text-align: right; font-size: 9.5px; line-height: 1.35; color: #1e293b; }
/* Número del documento = elemento dominante visual (más compacto) */
.doc-meta .num {
  font-size: 19px; font-weight: 900; letter-spacing: 0.04em;
  color: #0f172a;
  background: #e2e8f0; padding: 4px 12px; border-radius: 4px;
  display: inline-block;
}
/* NCF en segundo plano para no competir con el número principal */
.doc-meta .ncf-line {
  margin-top: 4px;
  font-size: 9px; font-weight: 600;
  color: #64748b;
  letter-spacing: 0.04em;
}
.doc-meta .ncf-line .lbl { color: #94a3b8; text-transform: uppercase; letter-spacing: 0.12em; font-size: 7.5px; margin-right: 4px; }
.doc-meta .ncf-line .val { font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', monospace; color: #334155; }

.estado-stamp {
  display: inline-block; margin-top: 6px;
  padding: 3px 10px; border-radius: 3px;
  font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em;
  border: 1px solid;
}
/* Estados: paleta unificada gris claro (ink-friendly). El texto conserva
   tinte semántico tenue para distinguir Pagada/Vencida/Anulada de un vistazo
   sin saturar el toner. Misma identidad visual en factura y cotización. */
.estado-Pagada   { background: #f8fafc; color: #166534; border-color: #cbd5e1; }
.estado-Emitida  { background: #f8fafc; color: #1e40af; border-color: #cbd5e1; }
.estado-Vencida  { background: #f8fafc; color: #991b1b; border-color: #cbd5e1; }
.estado-Borrador { background: #f8fafc; color: #475569; border-color: #cbd5e1; }
.estado-Anulada  { background: #f8fafc; color: #7f1d1d; border-color: #cbd5e1; }

/* ───── Sections ───── */
/* Padding superior del body reducido (18→11px) — el bloque "Facturar a" /
   "Cliente" queda inmediatamente debajo del title-bar, sin aire desperdiciado. */
.body { padding: 11px 36px 12px; }
.section-label {
  font-size: 8.5px; font-weight: 800; color: #475569;
  text-transform: uppercase; letter-spacing: 0.18em;
  margin-bottom: 5px;
  display: flex; align-items: center; gap: 8px;
}
.section-label::after {
  content: ''; flex: 1; height: 1px; background: #e2e8f0;
}

/* ───── Client block ───── */
.client-grid {
  display: grid; grid-template-columns: 1.6fr 1fr 1fr;
  gap: 0;
  border: 1px solid #e2e8f0; border-radius: 4px;
  overflow: hidden;
}
.client-cell {
  padding: 7px 13px;
  border-right: 1px solid #e2e8f0;
  background: #f8fafc;
}
.client-cell:last-child { border-right: none; }
.client-cell .lbl {
  font-size: 7.5px; color: #64748b; text-transform: uppercase;
  letter-spacing: 0.14em; font-weight: 700; margin-bottom: 3px;
}
.client-cell .val {
  font-size: 11px; color: #0f172a; font-weight: 700; line-height: 1.3;
}
.client-cell .val.normal { font-weight: 500; font-size: 10px; line-height: 1.4; }

/* ───── Items table ───── */
.items {
  width: 100%; margin-top: 16px;
  border-collapse: separate; border-spacing: 0;
  border: 1px solid #cbd5e1; border-radius: 4px; overflow: hidden;
}
.items thead th {
  background: #f1f5f9; color: #334155;
  padding: 9px 10px;
  font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.1em;
  text-align: left;
  border-bottom: 1px solid #cbd5e1;
}
.items thead th.center { text-align: center; }
.items thead th.right  { text-align: right; }
.items thead th.col-num  { width: 30px; text-align: center; }
.items thead th.col-cod  { width: 86px; text-align: left; }
.items thead th.col-cant { width: 56px; text-align: center; }
.items thead th.col-pu   { width: 90px; text-align: right; }
.items thead th.col-amt  { width: 100px; text-align: right; }
.items tbody td.codigo   { font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', monospace; color: #1e293b; font-size: 9.5px; font-weight: 700; letter-spacing: 0.02em; }
.items tbody td {
  padding: 8px 10px;
  font-size: 10px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
.items tbody tr:last-child td { border-bottom: none; }
.items tbody tr:nth-child(even) td { background: #f8fafc; }
/* ── Pagination intra-tabla ────────────────────────────────────────────────
   Cada fila se imprime entera. Si no cabe, salta al inicio de la página
   siguiente. Header se repite (thead como header-group). Evita huérfanos
   tipo "una descripción cortada por la mitad". */
.items tbody tr  { page-break-inside: avoid; break-inside: avoid; }
.items thead     { display: table-header-group; }
.items tfoot     { display: table-footer-group; }
.items tbody td.center { text-align: center; }
.items tbody td.right  { text-align: right; }
.items tbody td.num    { color: #94a3b8; font-size: 9px; }
/* Jerarquía estricta: title BOLD · subtitle gray (separado por ·) · SKU mono */
.items .desc-main {
  color: #0f172a; font-weight: 700; font-size: 10.5px;
  line-height: 1.3; letter-spacing: -0.005em;
}
.items .desc-sub {
  color: #64748b; font-weight: 400; font-size: 9px;
  margin-top: 3px; line-height: 1.45;
}
/* Markdown rendering inside item descriptions */
.items .desc-main strong, .items .desc-sub strong { font-weight: 700; color: #0f172a; }
.items .desc-main em,     .items .desc-sub em     { font-style: italic; }
.items .desc-main ul, .items .desc-sub ul,
.items .desc-main ol, .items .desc-sub ol {
  margin: 4px 0 2px 14px; padding: 0;
}
.items .desc-main li, .items .desc-sub li {
  margin: 1px 0; padding: 0; line-height: 1.35;
}
.items .desc-main ul li { list-style: disc; }
.items .desc-main ol li { list-style: decimal; }
.items .desc-sub  ul li { list-style: '·  '; color: #64748b; }
.items .desc-sub  ol li { list-style: decimal; color: #64748b; }
.items .desc-main code, .items .desc-sub code {
  font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 9px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px;
}
.items .sku       { color: #94a3b8; font-size: 8px; margin-top: 3px; letter-spacing: 0.06em; font-weight: 600; }

/* ───── Totals ───── */
.totals-wrap {
  display: grid; grid-template-columns: 1fr 280px;
  gap: 20px; margin-top: 14px;
}
.totals-wrap.totals-wrap--solo {
  grid-template-columns: 1fr;
  justify-items: end;
}
.totals-wrap.totals-wrap--solo .totals { width: 280px; }
.legal-note {
  font-size: 8.5px; color: #64748b; line-height: 1.55;
  padding: 10px 12px; background: #f8fafc;
  border: 1px solid #e2e8f0; border-radius: 4px;
}
.legal-note .ttl { font-size: 9px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
.totals {
  border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;
}
.tot-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 7px 14px;
  font-size: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.tot-row:last-child { border-bottom: none; }
.tot-row .lbl { color: #475569; font-weight: 600; text-transform: uppercase; font-size: 9px; letter-spacing: 0.08em; }
.tot-row .val { color: #0f172a; font-weight: 700; }
/* Grand Total: fondo claro + borde superior fuerte. Antes navy oscuro
   (#0f172a) — desperdiciaba tinta y rompía la unificación factura/cotización.
   Ahora idéntico tratamiento al resto del template. */
.tot-row.grand {
  background: #f1f5f9;
  color: #0f172a;
  padding: 11px 14px;
  border-top: 2px solid #94a3b8;
}
.tot-row.grand .lbl { color: #475569; font-size: 10px; font-weight: 800; letter-spacing: 0.12em; }
.tot-row.grand .val { color: #0f172a; font-size: 14px; font-weight: 800; letter-spacing: 0.02em; }

/* ───── Conditions ───── */
.cond-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 6px; margin-top: 14px;
}
.cond-cell {
  border: 1px solid #e2e8f0; border-left: 3px solid #1e40af;
  padding: 7px 10px;
  background: #f8fafc;
  border-radius: 3px;
}
.cond-cell .lbl { font-size: 7.5px; color: #64748b; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; }
.cond-cell .val { font-size: 9.5px; color: #0f172a; font-weight: 600; margin-top: 2px; line-height: 1.4; }

/* Notes: paleta neutra slate en lugar de ámbar saturado. Se conserva el
   acento de borde lateral para marcar atención sin gastar tinta de color. */
.notes {
  margin-top: 12px;
  padding: 10px 14px;
  background: #f8fafc; border-left: 3px solid #94a3b8;
  border-radius: 3px;
  font-size: 9.5px; color: #334155; line-height: 1.5;
}
.notes .ttl { font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; font-size: 8.5px; margin-bottom: 2px; color: #0f172a; }

/* ───── Signatures ───── */
.sigs {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 80px;
  margin-top: 36px;
  padding: 0 12px;
}
.sig-block { position: relative; text-align: center; }
.sig-stack { position: relative; min-height: 64px; }
.sig-firma {
  position: absolute; left: 50%; bottom: 2px;
  transform: translateX(-50%);
  max-height: 56px; max-width: 200px;
  opacity: 0.92;
  z-index: 2;
}
.sig-sello {
  position: absolute; right: 0; bottom: -8px;
  width: 92px; height: 92px;
  object-fit: contain;
  opacity: 0.58;
  transform: rotate(-9deg);
  mix-blend-mode: multiply;
  z-index: 1;
  pointer-events: none;
}
.sig-line {
  border-top: 1.2px solid #0f172a;
  margin-top: 4px;
}
.sig-name {
  margin-top: 5px;
  font-size: 10px; font-weight: 800; color: #0f172a;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.sig-role {
  font-size: 8.5px; color: #64748b; margin-top: 1px;
  letter-spacing: 0.04em;
}

/* ───── Footer (anti-fraude QR a la izquierda + leyenda + fecha) ─────────────
   El QR se imprime SIEMPRE que el backend pueda generar la URL pública. El
   destinatario escanea con cualquier app de cámara y aterriza en /verify/:hash
   donde se valida el HMAC del documento. */
.footer {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 8px 36px 12px;
  border-top: 1px solid #e2e8f0;
  display: grid; grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 18px;
  font-size: 7.5px; color: #94a3b8;
  background: white;
}
.footer .qr-block {
  display: flex; align-items: center; gap: 10px;
}
.footer .qr-block .qr-img {
  width: 64px; height: 64px;
  border: 1px solid #cbd5e1; padding: 3px; background: white;
  border-radius: 4px;
  display: block;
}
.footer .qr-block .qr-text { font-size: 7.5px; color: #475569; line-height: 1.4; max-width: 220px; }
.footer .qr-block .qr-text .qr-ttl { font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #0f172a; font-size: 8px; }
/* Anti-OCR mobile: la URL textual se imprime en UNA SOLA linea fisica. El
   hash crudo NO se imprime (era ruido visual que el OCR movil truncaba). El
   <a> envolvente garantiza link clickable correcto y el QR funciona como
   fallback tactil gigante (ver qr-anchor). */
.footer .qr-block .qr-text .qr-url  { font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', monospace; color: #1e40af; font-size: 8.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px; max-width: 220px; font-weight: 600; }
.footer .qr-block .qr-text .qr-url a { color: inherit; text-decoration: none; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.footer .qr-block .qr-anchor { display: inline-block; line-height: 0; text-decoration: none; }
.footer .ctr   { text-align: center; font-weight: 700; color: #475569; letter-spacing: 0.06em; text-transform: uppercase; font-size: 7.5px; }
.footer .ctr .verify-line { margin-top: 2px; font-weight: 500; text-transform: none; letter-spacing: 0; color: #64748b; font-size: 7px; }
.footer .ctr .verify-line .lbl { color: #94a3b8; }
.footer .ctr .verify-line .url { color: #1e40af; }
.footer .right { text-align: right; font-size: 7.5px; color: #94a3b8; }
.footer .right .razon { color: #475569; font-weight: 700; font-size: 7.5px; }

/* ───── Pagination del bloque inferior ─────────────────────────────────────
   Totales + condiciones + notas + firmas se imprimen como UN bloque
   atómico. Si no queda espacio al final de la página, todo el bloque
   salta junto a la siguiente — nunca aparecen las firmas solas en una
   página nueva ni los totales separados de las firmas. */
.doc-footer {
  page-break-inside: avoid; break-inside: avoid;
  page-break-before: auto;
  margin-top: 0;
}
.totals-wrap { page-break-inside: avoid; break-inside: avoid; }
.cond-grid   { page-break-inside: avoid; break-inside: avoid; }
.notes       { page-break-inside: avoid; break-inside: avoid; }
.sigs        { page-break-inside: avoid; break-inside: avoid; }
.sig-block   { page-break-inside: avoid; break-inside: avoid; }
.client-grid { page-break-inside: avoid; break-inside: avoid; }
.section-label { page-break-after: avoid; break-after: avoid; }

/* ───── Watermark ANULADA ───── */
.watermark {
  position: absolute;
  top: 42%; left: 50%; transform: translate(-50%, -50%) rotate(-20deg);
  font-size: 130px; font-weight: 900;
  color: #ef4444; opacity: 0.07;
  letter-spacing: 0.08em; text-transform: uppercase;
  pointer-events: none; z-index: 5;
}
.watermark.cotizacion {
  color: #1e40af; opacity: 0.045; font-size: 110px;
}
.watermark.notacredito {
  color: #b91c1c; opacity: 0.065; font-size: 110px;
}
.watermark.notadebito {
  color: #c2410c; opacity: 0.065; font-size: 110px;
}

/* Variante ámbar para Nota de Débito — distingue visualmente B03 (cargo extra)
   de B04 (anulación). Mismo layout que .nc-ref-bar pero con paleta ambar. */
.nd-ref-bar {
  margin-top: 12px;
  padding: 9px 14px;
  background: #fffbeb;
  border: 1px solid #fde68a; border-left: 4px solid #c2410c;
  border-radius: 4px;
  display: grid; grid-template-columns: auto 1fr; column-gap: 14px; row-gap: 3px;
  align-items: baseline;
}
.nd-ref-bar .lbl { font-size: 8.5px; font-weight: 800; color: #7c2d12; text-transform: uppercase; letter-spacing: 0.12em; }
.nd-ref-bar .val { font-size: 11px; font-weight: 700; color: #0f172a; font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', monospace; letter-spacing: 0.02em; }
.nd-ref-bar .val.motivo { font-family: inherit; font-weight: 500; color: #334155; font-size: 10px; }

/* ───── Nota de Crédito — banda informativa "Modifica al Comprobante:" ─────
   Va inmediatamente debajo del bloque cliente. Rojo tenue para señalar la
   naturaleza correctiva del documento (vs azul corporativo de factura
   normal). Sin gritar: alta jerarquía sin saturar tinta. */
.nc-ref-bar {
  margin-top: 12px;
  padding: 9px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca; border-left: 4px solid #b91c1c;
  border-radius: 4px;
  display: grid; grid-template-columns: auto 1fr; column-gap: 14px; row-gap: 3px;
  align-items: baseline;
}
.nc-ref-bar .lbl { font-size: 8.5px; font-weight: 800; color: #7f1d1d; text-transform: uppercase; letter-spacing: 0.12em; }
.nc-ref-bar .val { font-size: 11px; font-weight: 700; color: #0f172a; font-family: 'SF Mono', 'JetBrains Mono', 'Consolas', monospace; letter-spacing: 0.02em; }
.nc-ref-bar .val.motivo { font-family: inherit; font-weight: 500; color: #334155; font-size: 10px; }
`

function renderDocumento(opts) {
  const {
    tipo,            // 'cotizacion' | 'factura' | 'nota-credito' | 'nota-debito'
    numero,          // string ej. 'COT-2026-0512-001'
    ncf,             // factura NCF (opt)
    tipoNcf,         // 'B01' / 'B02' / 'B03' (ND) / 'B04' (NC) ...
    tipoComposicion, // 'Artículos' | 'Servicio' | 'Mixto' — calculado en buildPdfData
    empresa,         // EmpresaPerfil row (NO defaults: si falta algo, oculta esa sección)
    cliente,         // { razonSocial, rnc, direccion, sector, provincia, telefono, email }
    items,           // [{ descripcion, sku?, detalle?, cantidad, precioUnitario }]
    subtotal,
    itbis,
    total,
    fechaEmision,
    fechaVence,
    estado,          // 'Pagada' | 'Emitida' | 'Vencida' | 'Borrador' | 'Anulada'
    notas,
    condiciones,     // { validez, pago, entrega, garantia }
    verify,          // { hash, url } o null si PUBLIC_FRONTEND_URL no está seteado
    verifyQrDataUri, // QR pre-renderizado por el backend (data:image/png;base64,...)
    // ── Datos exclusivos comprobantes modificatorios DGII (NC B04 / ND B03) ──
    esNotaCredito,
    esNotaDebito,
    facturaOrigen,           // { noFactura, ncf, tipoNcf } | null
    motivoNotaModificatoria, // string | null
  } = opts

  const isNotaCredito  = tipo === 'nota-credito' || !!esNotaCredito
  const isNotaDebito   = tipo === 'nota-debito'  || !!esNotaDebito
  const isModificatoria = isNotaCredito || isNotaDebito
  const isFactura      = tipo === 'factura' && !isModificatoria
  const tipoLabel      = isNotaCredito ? 'Nota de Crédito'
                       : isNotaDebito  ? 'Nota de Débito'
                       : isFactura     ? 'Factura'
                       :                 'Cotización'

  const emp = empresa ?? {}
  const assets = emp.assets ?? {}
  const repFull = [emp.representanteNombre, emp.representanteApellido].filter(Boolean).join(' ').trim()
  const direccionEmp = buildDireccion([emp.direccion, emp.sector, emp.provincia])
  const direccionCli = buildDireccion([cliente?.direccion, cliente?.sector, cliente?.provincia])

  const watermark = isNotaCredito
    ? '<div class="watermark notacredito">Nota de Crédito</div>'
    : isNotaDebito
      ? '<div class="watermark notadebito">Nota de Débito</div>'
      : estado === 'Anulada'
        ? '<div class="watermark">Anulada</div>'
        : (!isFactura ? '<div class="watermark cotizacion">Cotización</div>' : '')

  const itemsRows = (items ?? []).map((it, idx) => {
    const importe = Number(it.cantidad) * Number(it.precioUnitario)
    const { main, sub, sku: skuParsed } = parseDescripcionEstructurada(it.descripcion, it.detalle)
    // Código del artículo: prioridad explícita > SKU del producto > sku parseado de la descripción.
    // Si no hay nada, deja un guion para que la columna no quede en blanco visualmente.
    const codigo = it.codigo ?? it.sku ?? skuParsed ?? '—'
    return `<tr>
      <td class="num center">${String(idx + 1).padStart(2, '0')}</td>
      <td class="codigo">${escape(codigo)}</td>
      <td>
        ${main      ? `<div class="desc-main">${main}</div>` : ''}
        ${sub       ? `<div class="desc-sub">${sub}</div>` : ''}
      </td>
      <td class="center mono">${Number(it.cantidad).toLocaleString('es-DO')}</td>
      <td class="right mono">${fmtMoney(it.precioUnitario)}</td>
      <td class="right mono"><strong>${fmtMoney(importe)}</strong></td>
    </tr>`
  }).join('')

  const cond = condiciones ?? {}
  const condCards = (cond.validez || cond.pago || cond.entrega || cond.garantia) ? `
    <div class="cond-grid">
      ${cond.validez  ? `<div class="cond-cell"><div class="lbl">Validez</div><div class="val">${escape(cond.validez)}</div></div>`  : ''}
      ${cond.pago     ? `<div class="cond-cell"><div class="lbl">Forma de Pago</div><div class="val">${escape(cond.pago)}</div></div>` : ''}
      ${cond.entrega  ? `<div class="cond-cell"><div class="lbl">Entrega</div><div class="val">${escape(cond.entrega)}</div></div>` : ''}
      ${cond.garantia ? `<div class="cond-cell"><div class="lbl">Garantía</div><div class="val">${escape(cond.garantia)}</div></div>` : ''}
    </div>` : ''

  // Dirección de la EMPRESA: el usuario pidió eliminar la ETIQUETA "Dirección:"
  // pero CONSERVAR el texto físico de la ubicación. Va en su propia fila sin
  // <span class="lbl">; el .row sin lbl colapsa a una sola línea de val al
  // 100% del ancho corp-meta (alineado a la derecha como el resto).
  const corpRows = [
    emp.rnc      ? `<div class="row"><span class="lbl">RNC</span><span class="val mono">${escape(emp.rnc)}</span></div>` : '',
    direccionEmp ? `<div class="row row-noticket"><span class="val val-direccion">${escape(direccionEmp)}</span></div>` : '',
    emp.telefono ? `<div class="row"><span class="lbl">Tel.</span><span class="val mono">${escape(emp.telefono)}</span></div>` : '',
    emp.email    ? `<div class="row"><span class="lbl">Email</span><span class="val">${escape(emp.email)}</span></div>` : '',
    emp.website  ? `<div class="row"><span class="lbl">Web</span><span class="val">${escape(emp.website)}</span></div>` : '',
  ].filter(Boolean).join('')

  const legalNote = isFactura
    ? ''
    : `<div class="legal-note">
        <div class="ttl">Condiciones Generales</div>
        Esta cotización tiene carácter informativo y no constituye documento fiscal.
        Los precios pueden estar sujetos a cambio sin previo aviso fuera del período de validez.
        Para emisión de factura formal se requiere confirmación por escrito.
      </div>`

  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="UTF-8"><title>${escape(tipoLabel)} ${escape(numero)}</title>
  <style>${CSS}</style>
</head><body>
<div class="sheet">

  <div class="band"></div>
  ${watermark}

  <header class="header">
    <div class="brand">
      ${assets.logoClaro ? `<div class="logo"><img src="${escape(assets.logoClaro)}" alt=""/></div>` : ''}
      <div class="brand-info">
        <div class="razon">${escape(emp.razonSocial ?? '—')}</div>
        ${emp.nombreComercial ? `<div class="nombre-comercial">${escape(emp.nombreComercial)}</div>` : ''}
        ${emp.eslogan ? `<div class="eslogan">${escape(emp.eslogan)}</div>` : ''}
      </div>
    </div>
    <div class="corp-meta">${corpRows}</div>
  </header>

  <div class="title-bar">
    <div class="doc-type">
      ${escape(tipoLabel)}
    </div>
    <div class="doc-meta">
      <div class="num mono">${escape(numero)}</div>
      ${isFactura && ncf ? `<div class="ncf-line"><span class="lbl">NCF${tipoNcf ? ` · ${escape(tipoNcf)}` : ''}</span><span class="val">${escape(ncf)}</span></div>` : ''}
      <div style="margin-top:6px; font-size:9px; opacity:0.85;">
        Emisión: <strong>${fechaCorta(fechaEmision)}</strong>
        ${fechaVence ? ` · ${isFactura ? 'Vence' : 'Válida hasta'}: <strong>${fechaCorta(fechaVence)}</strong>` : ''}
      </div>
      ${estado ? `<span class="estado-stamp estado-${escape(estado)}">${escape(estado)}</span>` : ''}
    </div>
  </div>

  <main class="body">

    <div class="section-label">${isFactura ? 'Facturar a' : 'Cliente'}</div>
    <div class="client-grid">
      <div class="client-cell">
        <div class="lbl">Razón Social</div>
        <div class="val">${escape(cliente?.razonSocial ?? 'Consumidor Final')}</div>
        ${cliente?.noCliente ? `<div class="val normal mono" style="margin-top:3px; color:#475569;">${escape(cliente.noCliente)}</div>` : ''}
      </div>
      <div class="client-cell">
        <div class="lbl">${cliente?.rnc ? 'RNC' : 'Contacto'}</div>
        <div class="val${cliente?.rnc ? ' mono' : ''}">${escape(cliente?.rnc ?? cliente?.contacto ?? '—')}</div>
        ${cliente?.telefono ? `<div class="val normal mono" style="margin-top:3px; color:#475569;">Tel. ${escape(cliente.telefono)}</div>` : ''}
      </div>
      <div class="client-cell">
        <div class="lbl">Dirección</div>
        <div class="val normal">${escape(direccionCli || '—')}</div>
        ${cliente?.email ? `<div class="val normal" style="margin-top:3px; color:#475569;">${escape(cliente.email)}</div>` : ''}
      </div>
    </div>

    ${isModificatoria ? `
    <div class="${isNotaCredito ? 'nc-ref-bar' : 'nd-ref-bar'}">
      <div class="lbl">Modifica al Comprobante</div>
      <div class="val">${escape(facturaOrigen?.ncf || facturaOrigen?.noFactura || '—')}${facturaOrigen?.noFactura && facturaOrigen?.ncf ? ` · ${escape(facturaOrigen.noFactura)}` : ''}</div>
      ${motivoNotaModificatoria ? `<div class="lbl">Motivo</div><div class="val motivo">${escape(motivoNotaModificatoria)}</div>` : ''}
    </div>` : ''}

    <div style="margin-top:16px;" class="section-label">Detalle de productos y servicios</div>
    <table class="items">
      <thead>
        <tr>
          <th class="col-num">#</th>
          <th class="col-cod">Código</th>
          <th>Descripción</th>
          <th class="col-cant center">Cant.</th>
          <th class="col-pu right">Precio Unit.</th>
          <th class="col-amt right">Importe</th>
        </tr>
      </thead>
      <tbody>${itemsRows || `<tr><td colspan="6" style="text-align:center; padding:20px; color:#94a3b8;">Sin líneas de detalle.</td></tr>`}</tbody>
    </table>

    <div class="doc-footer">
      <div class="totals-wrap${legalNote ? '' : ' totals-wrap--solo'}">
        ${legalNote}
        <div class="totals">
          <div class="tot-row">
            <span class="lbl">Subtotal</span>
            <span class="val mono">RD$ ${fmtMoney(subtotal)}</span>
          </div>
          ${Number(itbis) > 0 ? `
          <div class="tot-row">
            <span class="lbl">ITBIS (18%)</span>
            <span class="val mono">RD$ ${fmtMoney(itbis)}</span>
          </div>` : `
          <div class="tot-row">
            <span class="lbl">ITBIS</span>
            <span class="val mono" style="color:#94a3b8;">Exento</span>
          </div>`}
          <div class="tot-row grand">
            <span class="lbl">Total</span>
            <span class="val mono">RD$ ${fmtMoney(total)}</span>
          </div>
        </div>
      </div>

      ${condCards}

      ${notas ? `<div class="notes"><div class="ttl">Notas</div>${escape(notas)}</div>` : ''}

      <div class="sigs">
        <div class="sig-block">
          <div class="sig-stack"></div>
          <div class="sig-line"></div>
          <div class="sig-name">Aceptación del Cliente</div>
          <div class="sig-role">Firma · Sello · Fecha</div>
        </div>
        <div class="sig-block">
          <div class="sig-stack">
            ${assets.firmaGerente ? `<img class="sig-firma" src="${escape(assets.firmaGerente)}" alt=""/>` : ''}
            ${assets.selloFisico  ? `<img class="sig-sello" src="${escape(assets.selloFisico)}" alt=""/>` : ''}
          </div>
          <div class="sig-line"></div>
          <div class="sig-name">${escape(repFull || emp.razonSocial || 'Autorizado')}</div>
          <div class="sig-role">${escape(emp.representanteCargo ?? 'Representante')}${emp.razonSocial ? ` · ${escape(emp.razonSocial)}` : ''}</div>
        </div>
      </div>
    </div>

  </main>

  <footer class="footer">
    <div class="qr-block">
      ${verify?.url
        ? `<a class="qr-anchor" href="${escape(verify.url)}"><img class="qr-img" src="${escape(verifyQrDataUri || '')}" alt="QR de verificación"/></a>`
        : `<img class="qr-img" src="${escape(verifyQrDataUri || '')}" alt="QR de verificación"/>`}
      <div class="qr-text">
        <div class="qr-ttl">Verificación Anti-Fraude</div>
        <div>Escanea el QR o toca la URL para validar.</div>
        ${verify?.url
          ? `<div class="qr-url" title="${escape(verify.url)}"><a href="${escape(verify.url)}" style="text-decoration:none; color:inherit; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escape(verify.url)}</a></div>`
          : ''}
      </div>
    </div>
    <div class="ctr">
      <div>Documento Electrónico Verificable</div>
      <div class="verify-line">${escape(emp.razonSocial ?? '')}${emp.rnc ? ` · RNC ${escape(emp.rnc)}` : ''}</div>
    </div>
    <div class="right mono">${fechaLarga(new Date())}</div>
  </footer>

</div>
</body></html>`
}

module.exports = { renderDocumento, fmtMoney, fechaLarga, fechaCorta }
