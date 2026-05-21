/**
 * backend/modules/ventas/cotizador-libre/service.js
 *
 * Lógica del Cotizador Libre. Render PDF puro en memoria — sin NCF, sin
 * descuento de stock, sin AuditCaja. Herramienta de cotización editable
 * para proyectos de infraestructura/CCTV.
 *
 * Ciclo 15: el PDF ahora HEREDA el template corporativo oficial
 * (`backend/services/pdf-templates.js → renderDocumento`) — la misma
 * plantilla usada por Facturas y Cotizaciones estándar. Esto garantiza
 * 100% paridad estética (header con logo + banda corporativa, title-bar
 * con número + estado, client-grid con bordes finos, tabla densa, totales
 * contables, footer con QR de verificación).
 *
 * Sobre el template oficial se inyectan DOS extensiones específicas del
 * cotizador libre, vía post-procesamiento del HTML retornado:
 *   1. Fila "Descuento" en la sección de totales si totales.descuento > 0.
 *      El template oficial no la trae porque facturas DGII no descuentan
 *      línea — pero en cotizaciones libres es un caso común.
 *   2. Anexo Técnico al final con grid 2-col de fotos comprimidas en
 *      base64 + lugar de instalación. Cada sheet del anexo replica el
 *      `.band`, `.header`, `.title-bar`, `.body`, `.footer` del template
 *      para mantener membrete superior y pie de página corporativo unificado.
 *
 * Pipeline render:
 *   1. Recibe dto validado por schema.js.
 *   2. Calcula subtotal/itbis/total en backend (defensa-en-profundidad).
 *   3. Genera QR del payload de validación (link público al portal).
 *   4. Fetcha EmpresaPerfil (opcional — si está disponible vía repo).
 *   5. Llama a renderDocumento del template oficial.
 *   6. Post-procesa: inyecta fila Descuento + anexo fotográfico.
 *   7. Devuelve Buffer al controller.
 *
 * Factory: createCotizadorLibreService({ generarPdfDocumento, QRCode, repo,
 *   inlineAssets? })
 */

const { renderDocumento, fmtMoney, fechaCorta } = require('../../../services/pdf-templates');
const { facturaVerifyHash } = require('../../../shared/services/verify-hash.service');

const NOMBRE_EMPRESA_DEFAULT  = 'ACR Networks & Solutions';
const TAGLINE_DEFAULT         = 'Infraestructura de Redes · Seguridad Electrónica · Fibra Óptica';
const WEBSITE_DEFAULT         = 'https://acrnetworks.do';

// Resolver idéntico al de `modules/ventas/pdf/service` (las facturas). Si
// divergen, los QRs apuntan a hosts distintos y solo uno funciona. Cascada:
//   1. PUBLIC_FRONTEND_URL — preferida, configurada explícitamente.
//   2. CORS_ORIGIN — primer origen https de la lista (típicamente frontend prod).
//   3. localhost:5173 — dev. (NUNCA RENDER_EXTERNAL_URL — apunta al backend, 404.)
function _resolverPublicVerifyBase() {
  const explicit = (process.env.PUBLIC_FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const corsList = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const httpsCors = corsList.find(o => /^https:\/\//i.test(o));
  if (httpsCors) return httpsCors.replace(/\/+$/, '');
  if (corsList[0]) return corsList[0].replace(/\/+$/, '');
  return 'http://localhost:5173';
}
const PUBLIC_VERIFY_BASE = _resolverPublicVerifyBase();

class CotizadorLibreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

// Local escape — duplicado intencional del helper de pdf-templates.js que NO
// se exporta. Mantenerlo local nos da independencia del módulo oficial.
function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function createCotizadorLibreService(deps) {
  const { generarPdfDocumento, QRCode, repo, inlineAssets } = deps;
  if (typeof generarPdfDocumento !== 'function') throw new Error('createCotizadorLibreService: generarPdfDocumento required');

  // ─── Helpers de cálculo (defensa-en-profundidad) ──────────────────────────
  function _calcularTotales(dto) {
    const pct = Number(dto.porcentajeItbis ?? 18) / 100;

    const lineas = (dto.items ?? []).map((it) => {
      const qty   = Math.max(0, Math.floor(Number(it.cantidad ?? 0)));
      const pu    = Math.max(0, Number(it.precioUnit ?? 0));
      const sub   = Math.round(qty * pu * 100) / 100;
      const aplItb = dto.aplicaItbisGlobal && (it.aplicaItbis !== false);
      const itbisLinea = aplItb ? Math.round(sub * pct * 100) / 100 : 0;
      return { ...it, qty, pu, subtotal: sub, itbisLinea, aplicaItbis: aplItb };
    });

    const subtotal = lineas.reduce((s, l) => s + l.subtotal, 0);

    // Descuento global (porcentaje O monto, lo que sea mayor — pero solo uno
    // a la vez en práctica). El descuento NUNCA produce baseImponible negativa.
    const dscPct  = Math.max(0, Math.min(100, Number(dto.descuentoGlobalPct ?? 0))) / 100;
    const dscFijo = Math.max(0, Number(dto.descuentoGlobalMonto ?? 0));
    const descuentoCalc = Math.round((subtotal * dscPct + dscFijo) * 100) / 100;
    const descuento = Math.min(descuentoCalc, subtotal);

    const baseImponible = Math.max(0, subtotal - descuento);
    const itbis = dto.aplicaItbisGlobal
      ? Math.round(baseImponible * pct * 100) / 100
      : 0;
    const total = Math.round((baseImponible + itbis) * 100) / 100;

    return { lineas, subtotal, descuento, baseImponible, itbis, total };
  }

  function _normCondToString(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (v.incluir && v.texto?.trim()) return v.texto.trim();
    return null;
  }

  function _serializeCond(condRaw) {
    const c = condRaw ?? {};
    return {
      validez:  _normCondToString(c.validez),
      pago:     _normCondToString(c.pago),
      entrega:  _normCondToString(c.entrega),
      garantia: _normCondToString(c.garantia),
    };
  }

  async function _qrDataUri(payloadUrl) {
    if (!QRCode || !payloadUrl) return null;
    try {
      return await QRCode.toDataURL(payloadUrl, {
        errorCorrectionLevel: 'M',
        margin: 0,
        width: 96,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
    } catch { return null; }
  }

  // ─── Verify hash anti-tamper (mismo HMAC SHA256 que facturas) ─────────────
  // Compute hash usando `facturaVerifyHash` del shared service. La función
  // acepta `{ id, noFactura, ncf, total, fechaEmision }`. Mapeamos del shape
  // del draft del cotizador libre. Mismo algoritmo + mismo secret → un cliente
  // puede usar el mismo flujo /verify/:hash que con facturas y obtener
  // respuesta autenticada.
  function _computeVerifyHash({ draftId, numeroDocumento, total, fechaIso }) {
    return facturaVerifyHash({
      id:            draftId || '',
      noFactura:     numeroDocumento || '',
      ncf:           null,
      total:         total,
      fechaEmision:  fechaIso,
    }, 'cotizador-libre');
  }

  // Persiste el hash dentro del JSON `meta` del draft. El endpoint público
  // `/api/publico/verify/:hash` busca primero en `Factura.verifyHash` y luego
  // hace fallback al `meta.verifyHash` de cotizaciones libres (ver
  // modules/admin/ops/repo.js).
  async function _persistirHashEnDraft({ numeroDocumento, hash }) {
    if (!repo || !numeroDocumento || !hash) return;
    try {
      // findOne sin empleadoId → cualquier draft con ese numeroDocumento.
      const draft = await repo.findOne({ numeroDocumento });
      if (!draft) return;  // PDF generado sobre data no persistida (preview); skip
      const metaPrev = (draft.meta && typeof draft.meta === 'object') ? draft.meta : {};
      const meta = { ...metaPrev, verifyHash: hash, lastPdfAt: new Date().toISOString() };
      await repo.upsertByEmpleadoYNumero(draft.empleadoId, numeroDocumento, {
        cliente:     draft.cliente,
        items:       draft.items,
        condiciones: draft.condiciones,
        meta,
      });
    } catch (e) {
      console.warn('[COTIZADOR-LIBRE] persist hash failed:', e.message);
    }
  }

  // ─── Heurística de categorización (cuando ítem no trae .categoria) ────────
  function _detectarCategoria(item) {
    if (item.categoria) return item.categoria;
    const codigo = (item.codigo ?? '').toUpperCase();
    const desc   = (item.descripcion ?? '').toUpperCase();
    if (/^SVC|SERVICIO|INSTAL/.test(codigo) || /\bINSTALACI[ÓO]N\b|\bSERVICIO\b|\bMANO DE OBRA\b/.test(desc)) return 'Servicios';
    if (/CAPACIT/.test(codigo)              || /CAPACITACI[ÓO]N|ENTRENAMIENTO/.test(desc))                  return 'Capacitación';
    if (/^CCTV|CAMARA|^NVR|^DVR/.test(codigo) || /CÁMARA|CAMARA|NVR|DVR/.test(desc))                       return 'Equipos';
    if (/^FO-|FIBRA|^CAB|UTP|CAT6/.test(codigo) || /CABLE|FIBRA|UTP|CAT.?6/.test(desc))                   return 'Cableado';
    if (/^NET-|SWITCH|ROUTER|^USW|^UBQ/.test(codigo) || /SWITCH|ROUTER/.test(desc))                       return 'Equipos';
    if (/SOFTWARE|LICENCIA|^SW-/.test(codigo) || /SOFTWARE|LICENCIA|SUSCRIPCI[ÓO]N/.test(desc))           return 'Software';
    if (/MANTENIM/.test(desc))                                                                            return 'Mantenimiento';
    return 'Otros';
  }

  // ─── Resumen ejecutivo: tabla agrupada por categoría ─────────────────────
  function _renderResumenTable({ lineas }) {
    const grupos = new Map();
    for (const l of lineas) {
      const cat = _detectarCategoria(l);
      const prev = grupos.get(cat) ?? { count: 0, subtotal: 0 };
      grupos.set(cat, {
        count:    prev.count + 1,
        subtotal: prev.subtotal + (l.subtotal ?? 0),
      });
    }
    if (grupos.size === 0) return '';
    const rows = [...grupos.entries()].map(([cat, v]) => `
      <tr>
        <td><strong>${_esc(cat)}</strong></td>
        <td class="center mono">${v.count}</td>
        <td class="right mono"><strong>RD$ ${fmtMoney(v.subtotal)}</strong></td>
      </tr>`).join('');
    return `
      <div class="section-label" style="margin-top:14px;">Resumen ejecutivo por categoría</div>
      <table class="items resumen-exec">
        <thead>
          <tr>
            <th>Categoría</th>
            <th class="col-cant center">Ítems</th>
            <th class="col-amt right">Subtotal</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ─── Portada (carta de presentación) — solo contenido, sin header/footer
  // (esos se inyectan por Puppeteer en cada página). page-break-after: always
  // garantiza que la portada sea su propia página, separada del documento. ──
  function _renderPortadaSheet({ portada, empresa, numero, cliente, fechaIso }) {
    if (!portada?.activa || !(portada.texto ?? '').trim()) return '';
    const repFull = [empresa.representanteNombre, empresa.representanteApellido].filter(Boolean).join(' ').trim();
    const fechaStr = fechaCorta(fechaIso);
    const textoHtml = String(portada.texto).split(/\n{2,}/).map(parr =>
      `<p>${_esc(parr).replace(/\n/g, '<br/>')}</p>`
    ).join('');
    return `
<section class="portada-sheet">
  <div class="title-bar">
    <div class="doc-type">Carta de Presentación<span class="sub">Propuesta Comercial</span></div>
    <div class="doc-meta">
      <div class="num mono">${_esc(numero)}</div>
      <div style="margin-top:6px; font-size:9px; opacity:0.85;">${_esc(fechaStr)}</div>
    </div>
  </div>
  <main class="portada-body">
    <div class="section-label">Estimado(a)</div>
    <div class="portada-cliente">
      <div class="razon-cli">${_esc(cliente?.razonSocial ?? '—')}</div>
      ${cliente?.contacto ? `<div class="contacto-cli">A la atención de: <strong>${_esc(cliente.contacto)}</strong></div>` : ''}
    </div>
    <div class="portada-texto">${textoHtml}</div>
    <div class="portada-firma">
      ${repFull ? `<div class="firma-nombre">${_esc(repFull)}</div>` : ''}
      ${empresa.representanteCargo ? `<div class="firma-cargo">${_esc(empresa.representanteCargo)}</div>` : ''}
      <div class="firma-empresa">${_esc(empresa.razonSocial ?? '—')}</div>
    </div>
  </main>
</section>`;
  }

  function _renderSobreEmpresa({ sobreEmpresa }) {
    if (!sobreEmpresa?.activa || !(sobreEmpresa.texto ?? '').trim()) return '';
    const textoHtml = String(sobreEmpresa.texto).split(/\n{2,}/).map(parr =>
      `<p>${_esc(parr).replace(/\n/g, '<br/>')}</p>`
    ).join('');
    return `
      <div class="section-label" style="margin-top:14px;">Sobre nosotros</div>
      <div class="sobre-empresa-box">${textoHtml}</div>`;
  }

  // ─── Header/Footer templates de Puppeteer (multi-page, sin overlap) ──────
  // Puppeteer los renderiza DENTRO del margin top/bottom de @page. NO usan
  // CSS externo — todo inline styles. Disponibles: <span class="pageNumber">
  // y <span class="totalPages"> sustituidos por Puppeteer en runtime.
  function _buildHeaderTemplate({ empresa }) {
    const assets = empresa.assets ?? {};
    const corpRows = [];
    if (empresa.rnc)      corpRows.push(`<div><span style="color:#94a3b8; font-size:8px; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-right:3mm;">RNC</span><span style="color:#0f172a; font-weight:600;">${_esc(empresa.rnc)}</span></div>`);
    if (empresa.telefono) corpRows.push(`<div><span style="color:#94a3b8; font-size:8px; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-right:3mm;">Tel</span><span style="color:#0f172a; font-weight:600;">${_esc(empresa.telefono)}</span></div>`);
    if (empresa.email)    corpRows.push(`<div><span style="color:#94a3b8; font-size:8px; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-right:3mm;">Email</span><span style="color:#0f172a; font-weight:600;">${_esc(empresa.email)}</span></div>`);
    if (empresa.website)  corpRows.push(`<div><span style="color:#94a3b8; font-size:8px; text-transform:uppercase; letter-spacing:0.08em; font-weight:700; margin-right:3mm;">Web</span><span style="color:#0f172a; font-weight:600;">${_esc(empresa.website)}</span></div>`);

    return `
<div style="-webkit-print-color-adjust:exact; print-color-adjust:exact; width:100%; font-family:'Helvetica Neue',Arial,sans-serif; font-size:9.5px; color:#475569; box-sizing:border-box; padding:0;">
  <div style="height:3px; background:#cbd5e1; width:100%;"></div>
  <div style="padding:5mm 16mm 3mm; display:flex; align-items:center; justify-content:space-between; gap:10mm; border-bottom:1px solid #e2e8f0;">
    <div style="display:flex; align-items:center; gap:4mm;">
      ${assets.logoClaro ? `<img src="${_esc(assets.logoClaro)}" style="width:16mm; height:16mm; object-fit:contain; flex-shrink:0;"/>` : ''}
      <div>
        <div style="font-size:13.5px; font-weight:800; color:#0f172a; letter-spacing:-0.005em; line-height:1.15;">${_esc(empresa.razonSocial ?? '—')}</div>
        ${empresa.nombreComercial ? `<div style="font-size:9px; color:#1e40af; font-weight:600; margin-top:1px; text-transform:uppercase; letter-spacing:0.02em;">${_esc(empresa.nombreComercial)}</div>` : ''}
        ${empresa.eslogan ? `<div style="font-size:8.5px; color:#64748b; font-style:italic; margin-top:1.5px; max-width:90mm;">${_esc(empresa.eslogan)}</div>` : ''}
      </div>
    </div>
    <div style="text-align:right; line-height:1.5; color:#475569; font-size:9px;">
      ${corpRows.join('')}
    </div>
  </div>
</div>`;
  }

  function _buildFooterTemplate({ empresa, qrDataUri, verifyUrl }) {
    const websiteHref = empresa.website
      ? (String(empresa.website).startsWith('http') ? empresa.website : 'https://' + empresa.website)
      : null;
    const urlMostrar = verifyUrl || websiteHref || '';
    return `
<div style="-webkit-print-color-adjust:exact; print-color-adjust:exact; width:100%; font-family:'Helvetica Neue',Arial,sans-serif; font-size:8.5px; color:#94a3b8; box-sizing:border-box;">
  <div style="padding:3mm 16mm 4mm; display:flex; align-items:flex-start; justify-content:space-between; gap:8mm; border-top:1px solid #e2e8f0;">
    <div style="display:flex; align-items:flex-start; gap:3mm; flex:1; min-width:0;">
      ${qrDataUri ? `<img src="${_esc(qrDataUri)}" style="width:16mm; height:16mm; border:1px solid #cbd5e1; padding:0.5mm; background:white; border-radius:1mm; flex-shrink:0;"/>` : ''}
      <div style="min-width:0; max-width:80mm;">
        <div style="font-weight:800; text-transform:uppercase; letter-spacing:0.08em; color:#0f172a; font-size:8.5px;">Verificación Anti-Fraude</div>
        <div style="color:#475569; font-size:8px; margin-top:0.5mm;">Escanea el QR o copia la URL.</div>
        ${urlMostrar ? `<div style="font-family:'SF Mono','Consolas',monospace; color:#1e40af; font-size:8px; margin-top:0.5mm; word-wrap:break-word; overflow-wrap:break-word; word-break:break-all;">${_esc(urlMostrar)}</div>` : ''}
      </div>
    </div>
    <div style="text-align:center; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#475569; font-size:8px; flex-shrink:0; padding:0 4mm;">
      <div>Documento Electrónico Verificable</div>
      <div style="font-weight:500; text-transform:none; letter-spacing:0; color:#64748b; font-size:7.5px; margin-top:0.5mm;">${_esc(empresa.razonSocial ?? '')}${empresa.rnc ? ` · RNC ${_esc(empresa.rnc)}` : ''}</div>
    </div>
    <div style="text-align:right; font-family:'SF Mono','Consolas',monospace; color:#94a3b8; font-size:8px; flex-shrink:0;">
      Página <span class="pageNumber"></span> / <span class="totalPages"></span>
    </div>
  </div>
</div>`;
  }

  function _renderEstadoBadge(estado) {
    if (!estado || estado === 'Enviada' || estado === 'Aprobada') return '';
    // Solo mostramos badge BORRADOR / CONVERTIDA / PERDIDA — los estados que el
    // cliente no debería confundir con "esta es la oferta final".
    const colorMap = {
      'Borrador':   { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d' },
      'Convertida': { bg: '#dcfce7', fg: '#166534', border: '#86efac' },
      'Perdida':    { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' },
    };
    const c = colorMap[estado] ?? colorMap['Borrador'];
    return `<span class="estado-cotizador-libre" style="display:inline-block; margin-top:6px; padding:3px 10px; border-radius:3px; font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:0.12em; background:${c.bg}; color:${c.fg}; border:1px solid ${c.border};">${_esc(estado)}</span>`;
  }

  const _EXTRA_CSS = `
/* ── Cotizador libre — bloques extra (portada, sobre-empresa, resumen) ─── */
/* Header/footer ya no son inline en el HTML — Puppeteer los renderiza vía
   displayHeaderFooter + headerTemplate/footerTemplate en CADA página dentro
   del margin top/bottom. Body queda libre de overlap garantizado. Removidos
   los paddings agresivos del approach anterior. */
.portada-sheet .portada-body { padding: 14px 16mm 14px; }
.portada-cliente { margin-top: 6px; }
.portada-cliente .razon-cli { font-size: 18px; font-weight: 800; color: #0f172a; letter-spacing: -0.005em; }
.portada-cliente .contacto-cli { font-size: 11px; color: #475569; margin-top: 2px; }
.portada-texto { margin-top: 28px; font-size: 12px; line-height: 1.7; color: #1e293b; max-width: 100%; }
.portada-texto p { margin-bottom: 14px; }
.portada-firma { margin-top: 48px; padding-top: 28px; border-top: 1px solid #cbd5e1; max-width: 320px; }
.portada-firma .firma-nombre { font-size: 12px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.04em; }
.portada-firma .firma-cargo { font-size: 9.5px; color: #475569; margin-top: 2px; letter-spacing: 0.06em; }
.portada-firma .firma-empresa { font-size: 9.5px; color: #1e40af; font-weight: 700; margin-top: 4px; }

.sobre-empresa-box {
  border: 1px solid #e2e8f0; border-left: 3px solid #1e40af;
  background: #f8fafc; border-radius: 4px;
  padding: 12px 16px; font-size: 9.5px; color: #334155; line-height: 1.55;
  page-break-inside: avoid;
}
.sobre-empresa-box p { margin-bottom: 6px; }

.items.resumen-exec { margin-top: 4px; }
.items.resumen-exec tbody td { font-size: 10px; }

/* ── Watermarks de cotización libre ──────────────────────────────────────
   Doble capa: COTIZACIÓN base (azul tenue, siempre presente) + estado
   encima (ámbar/verde/rojo según Borrador/Convertida/Perdida).
   position:fixed garantiza repetición en cada página del PDF (Puppeteer
   con @media print honra fixed elements multi-page). */
.watermark.cotizacion {
  position: fixed !important;
  top: 35% !important;
  left: 50% !important;
  transform: translate(-50%, -50%) rotate(-20deg) !important;
  font-size: 110px !important;
  font-weight: 900 !important;
  color: #1e40af !important;
  opacity: 0.06 !important;
  letter-spacing: 0.1em !important;
  text-transform: uppercase !important;
  pointer-events: none !important;
  z-index: 5 !important;
}
.watermark.cotizador-estado {
  position: fixed;
  top: 55%; left: 50%;
  transform: translate(-50%, -50%) rotate(-15deg);
  font-size: 95px;
  font-weight: 900;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  pointer-events: none;
  z-index: 6;
}
.watermark.cotizador-estado.borrador   { color: #f59e0b; opacity: 0.14; }
.watermark.cotizador-estado.convertida { color: #16a34a; opacity: 0.12; }
.watermark.cotizador-estado.perdida    { color: #dc2626; opacity: 0.12; }
`;

  // ─── Inyección de fila Descuento en la sección de totales ─────────────────
  // El template oficial tiene Subtotal → ITBIS → Total. Insertamos una fila
  // "Descuento" antes de Total cuando aplica. Usa la misma clase `.tot-row`
  // que ya está estilizada por el template oficial.
  function _injectarDescuentoEnTotales(html, descuento) {
    if (!(descuento > 0)) return html;
    const filaDescuento = `<div class="tot-row">
            <span class="lbl">Descuento</span>
            <span class="val mono" style="color:#b91c1c;">− RD$ ${fmtMoney(descuento)}</span>
          </div>`;
    // Insertar antes de la tot-row.grand (la primera y única en el template).
    return html.replace(/(<div class="tot-row grand">)/, `${filaDescuento}\n          $1`);
  }

  // ─── Anexo fotográfico (nueva página con membrete corporativo unificado) ──
  // Cada `.sheet` del anexo replica band + header + title-bar + body + footer
  // del template oficial. Reusa las clases CSS ya inyectadas en el <head> por
  // renderDocumento, así que la apariencia es 100% consistente sin duplicar
  // CSS. `page-break-before: always` fuerza salto de página limpio.
  // ─── Sheet de anexo fotográfico — solo body. Header/footer Puppeteer. ─
  function _renderAnexoSheet({ tilesHtml, numero, fechaIso, totalFotos, paginaNum, paginasTotales }) {
    const fechaCortaStr = fechaCorta(fechaIso);
    return `
<section class="anexo-sheet">
  <div class="title-bar">
    <div class="doc-type">
      Anexo Técnico
      <span class="sub">Levantamiento Fotográfico</span>
    </div>
    <div class="doc-meta">
      <div class="num mono">${_esc(numero)}</div>
      <div style="margin-top:6px; font-size:9px; opacity:0.85;">
        ${totalFotos} imagen${totalFotos === 1 ? '' : 'es'} · ${_esc(fechaCortaStr)}
        ${paginasTotales > 1 ? ` · Página ${paginaNum}/${paginasTotales}` : ''}
      </div>
    </div>
  </div>
  <main class="anexo-body">
    <div class="section-label">Capturas de campo</div>
    <div class="anexo-grid">${tilesHtml}</div>
  </main>
</section>`;
  }

  // CSS extra que el template oficial NO trae (grid de fotos, foto-card). Se
  // inyecta dentro del <style>...</style> existente vía replace al final.
  const _ANEXO_CSS = `
/* ── Anexo fotográfico (cotizador libre) ───────────────────────────────── */
.anexo-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 14px 10px; margin-top: 6px;
}
.foto-card {
  border: 1px solid #cbd5e1; border-radius: 4px; overflow: hidden;
  background: #f8fafc; page-break-inside: avoid; break-inside: avoid;
}
.foto-card .foto-wrap {
  width: 100%; aspect-ratio: 4 / 3;
  background: #0f172a;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.foto-card .foto-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
.foto-card figcaption { padding: 7px 10px 8px; font-size: 9px; color: #334155; line-height: 1.4; }
.foto-meta { font-size: 8px; color: #1e293b; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 3px; font-weight: 700; }
.foto-meta strong { color: #1e40af; }
.foto-desc { color: #475569; margin-bottom: 4px; font-size: 9px; }
.foto-lugar { color: #0f172a; font-size: 9px; }
.foto-lugar .lbl { color: #64748b; font-size: 7.5px; text-transform: uppercase; letter-spacing: 0.08em; margin-right: 4px; font-weight: 700; }
.foto-nombre { color: #94a3b8; font-size: 8.5px; margin-top: 2px; font-style: italic; }
`;

  function _renderAnexoFotos({ lineas, numero, fechaIso }) {
    // Aplanar: cada foto se renderiza con metadatos contextuales del ítem padre.
    const tiles = [];
    lineas.forEach((l, i) => {
      const fotos = Array.isArray(l.fotos) ? l.fotos : [];
      fotos.forEach((f, j) => {
        if (!f?.dataUri) return;
        tiles.push({
          dataUri:      f.dataUri,
          nombre:       f.nombre ?? '',
          modelo:       (f.modelo ?? l.codigo ?? '').toString().trim(),
          itemIdx:      i + 1,
          descripcion:  (l.descripcion ?? '').toString().slice(0, 80),
          lugar:        (l.lugarInstalacion ?? '').toString().trim(),
          fotoIdx:      j + 1,
        });
      });
    });

    if (tiles.length === 0) return { anexoHtml: '', anexoCss: '' };

    // Paginación: 6 fotos por sheet (3 filas × 2 cols) para mantener buena
    // densidad visual sin overflow. Si hay 7+, generamos múltiples sheets.
    const FOTOS_X_PAGINA = 6;
    const paginas = [];
    for (let i = 0; i < tiles.length; i += FOTOS_X_PAGINA) {
      paginas.push(tiles.slice(i, i + FOTOS_X_PAGINA));
    }

    const renderTile = (t) => `
      <figure class="foto-card">
        <div class="foto-wrap"><img src="${t.dataUri}" alt="Foto ${t.itemIdx}.${t.fotoIdx}" /></div>
        <figcaption>
          <div class="foto-meta">Ítem ${t.itemIdx}.${t.fotoIdx} ${t.modelo ? `· <strong>${_esc(t.modelo)}</strong>` : ''}</div>
          <div class="foto-desc">${_esc(t.descripcion)}</div>
          ${t.lugar ? `<div class="foto-lugar"><span class="lbl">Lugar:</span>${_esc(t.lugar)}</div>` : ''}
          ${t.nombre ? `<div class="foto-nombre">${_esc(t.nombre)}</div>` : ''}
        </figcaption>
      </figure>
    `;

    const anexoHtml = paginas.map((pag, idx) => _renderAnexoSheet({
      tilesHtml:       pag.map(renderTile).join(''),
      numero,
      fechaIso,
      totalFotos:      tiles.length,
      paginaNum:       idx + 1,
      paginasTotales:  paginas.length,
    })).join('\n');

    return { anexoHtml, anexoCss: _ANEXO_CSS };
  }

  // ─── _renderHtml: ahora delega a renderDocumento del template oficial ────
  async function _renderHtml({ dto, totales, qrDataUri, fechaIso }) {
    // Empresa: prioridad BD (EmpresaPerfil singleton) > overrides del dto >
    // defaults hardcoded. Esto da paridad visual con facturas oficiales en
    // prod (logo + RNC + dirección reales) y degrada limpio si no hay BD
    // (tests, ambientes vacíos).
    let empresaPerfil = null;
    if (repo && typeof repo.findEmpresaPerfil === 'function') {
      try { empresaPerfil = await repo.findEmpresaPerfil(); } catch { /* sin BD */ }
    }

    const empresa = empresaPerfil
      ? {
          ...empresaPerfil,
          assets: typeof inlineAssets === 'function'
            ? await inlineAssets(empresaPerfil.assets ?? {})
            : (empresaPerfil.assets ?? {}),
          // overrides del frontend tienen prioridad sobre BD (modos especiales)
          razonSocial: dto.empresaNombre?.trim() || empresaPerfil.razonSocial || NOMBRE_EMPRESA_DEFAULT,
          eslogan:     dto.empresaTagline?.trim() || empresaPerfil.eslogan || TAGLINE_DEFAULT,
          website:     dto.empresaWebsite?.trim() || empresaPerfil.website || WEBSITE_DEFAULT,
        }
      : {
          razonSocial: dto.empresaNombre?.trim() || NOMBRE_EMPRESA_DEFAULT,
          nombreComercial: null,
          eslogan:     dto.empresaTagline?.trim() || TAGLINE_DEFAULT,
          website:     dto.empresaWebsite?.trim() || WEBSITE_DEFAULT,
          rnc:         null,
          telefono:    null,
          email:       null,
          direccion:   null,
          assets:      {},
          representanteNombre:    null,
          representanteApellido:  null,
          representanteCargo:     null,
        };

    const numero = dto.numeroDocumento || `COT-${Date.now().toString().slice(-6)}`;

    // Items: del shape del cotizador (codigo/descripcion/qty/pu) al shape
    // que espera el template oficial (codigo/descripcion/cantidad/precioUnitario).
    const items = totales.lineas.map((l) => ({
      codigo:         l.codigo?.trim() || null,
      descripcion:    l.descripcion ?? '',
      cantidad:       l.qty,
      precioUnitario: l.pu,
    }));

    // Verify URL = mismo formato que facturas: PUBLIC_VERIFY_BASE/verify/<hash>.
    // Si tenemos el draft persistido, incluimos su id en el hash para garantizar
    // unicidad. El hash se persiste en draft.meta para que /api/publico/verify/:hash
    // pueda hacer lookup.
    let draftPersistido = null;
    if (repo && typeof repo.findOne === 'function') {
      try { draftPersistido = await repo.findOne({ numeroDocumento: numero }); } catch {}
    }
    const verifyHashCalc = _computeVerifyHash({
      draftId:         draftPersistido?.id ?? null,
      numeroDocumento: numero,
      total:           totales.total,
      fechaIso,
    });
    const verifyUrl = `${PUBLIC_VERIFY_BASE}/verify/${verifyHashCalc}`;

    const opts = {
      tipo:                    'cotizacion',
      numero,
      ncf:                     null,
      tipoNcf:                 null,
      tipoComposicion:         null,
      empresa,
      cliente: {
        razonSocial: dto.cliente?.razonSocial ?? 'Consumidor Final',
        rnc:         dto.cliente?.rnc ?? null,
        contacto:    dto.cliente?.contacto ?? null,
        direccion:   dto.cliente?.direccion ?? null,
        telefono:    dto.cliente?.telefono ?? null,
        email:       null,
      },
      items,
      subtotal:                totales.baseImponible,   // baseImponible (subtotal − descuento)
      itbis:                   totales.itbis,
      total:                   totales.total,
      fechaEmision:            fechaIso,
      fechaVence:              null,
      estado:                  null,
      notas:                   null,
      condiciones:             _serializeCond(dto.condiciones),
      verify:                  { hash: null, url: verifyUrl },
      verifyQrDataUri:         qrDataUri,
      esNotaCredito:           false,
      esNotaDebito:            false,
      facturaOrigen:           null,
      motivoNotaModificatoria: null,
    };

    // 1) Render del documento oficial.
    let html = renderDocumento(opts);

    // 2) STRIP del inline header / footer / band del template oficial.
    //    Los reemplazamos por headerTemplate/footerTemplate de Puppeteer que
    //    Puppeteer inserta dentro del margin top/bottom de CADA página.
    //    Garantía: header y footer SIEMPRE aparecen en todas las páginas y
    //    NUNCA se solapan con contenido (Puppeteer reserva el espacio).
    html = html.replace(/<div class="band"><\/div>\s*/g, '');
    html = html.replace(/<header class="header">[\s\S]*?<\/header>\s*/g, '');
    html = html.replace(/<footer class="footer">[\s\S]*?<\/footer>\s*/g, '');

    // El template oficial fija `@page { size: Letter; margin: 0; }` — esa
    // regla CSS @page invalida el `margin` que pasamos a Puppeteer y hace
    // que el body llegue al borde físico de la hoja (= solapa con header /
    // footer template de Puppeteer). Cambiamos la regla @page para que el
    // browser respete los margins que reserva Puppeteer.
    html = html.replace(
      /@page\s*\{[^}]*\}/g,
      '@page { size: Letter; margin: 48mm 0 38mm 0; }',
    );
    // Sheet ya no necesita overflow:hidden ni position:relative para anclar
    // footer absolute. Sobre-escribimos para liberar el flow natural. Body
    // padding lateral se mantiene desde el template — sin top/bottom (lo
    // maneja @page margin + Puppeteer headerTemplate/footerTemplate).
    html = html.replace(/<style[^>]*>/, (m) => `${m}
.sheet { position: static !important; overflow: visible !important; min-height: 0 !important; padding: 0 !important; width: 100% !important; }
.body { padding: 4mm 16mm 4mm !important; }
/* page-break helpers — cada sub-sección del cotizador libre inicia en su propia hoja */
.portada-sheet { page-break-before: avoid; break-before: auto; page-break-after: always; break-after: page; padding: 0 16mm; }
.anexo-sheet   { page-break-before: always; break-before: page; padding: 0 16mm; }
`);

    // 3) Inyectar CSS extra (portada + sobre-empresa + resumen + watermark).
    html = html.replace(/<\/style>/, `${_EXTRA_CSS}</style>`);

    // 4) Inyectar fila Descuento si aplica.
    html = _injectarDescuentoEnTotales(html, totales.descuento);

    // 5) Estado badge en title-bar + watermark capas (Cotización + estado).
    const estado = dto.estado ?? 'Borrador';
    const badgeHtml = _renderEstadoBadge(estado);
    if (badgeHtml) {
      html = html.replace(
        /(<div class="doc-meta">[\s\S]*?<\/div>\s*<\/div>\s*<main)/,
        (m) => m.replace(/(<\/div>\s*<\/div>\s*<main)/, `${badgeHtml}$1`),
      );
    }

    // Watermark "COTIZACIÓN" del template oficial SIEMPRE permanece (capa
    // base). Cuando estado ∈ {Borrador, Convertida, Perdida}, AÑADIMOS otro
    // watermark encima con el estado y color distintivo. Para Enviada y
    // Aprobada solo queda el "Cotización" base.
    const wmEstadoMap = {
      'Borrador':   { label: 'BORRADOR',   cls: 'borrador' },
      'Convertida': { label: 'CONVERTIDA', cls: 'convertida' },
      'Perdida':    { label: 'PERDIDA',    cls: 'perdida' },
    };
    const wmEstado = wmEstadoMap[estado];
    if (wmEstado) {
      const wmHtml = `<div class="watermark cotizador-estado ${wmEstado.cls}">${wmEstado.label}</div>`;
      // Insertar inmediatamente después del watermark cotizacion base.
      html = html.replace(
        /(<div class="watermark cotizacion">Cotización<\/div>)/,
        `$1\n  ${wmHtml}`,
      );
    }

    // 6) Sección "Sobre nosotros" entre cliente-grid y items table.
    const sobreHtml = _renderSobreEmpresa({ sobreEmpresa: dto.sobreEmpresa });
    if (sobreHtml) {
      html = html.replace(
        /(<div style="margin-top:16px;" class="section-label">Detalle de productos y servicios<\/div>)/,
        `${sobreHtml}\n        $1`,
      );
    }

    // 7) Resumen ejecutivo por categoría (antes de items table).
    if (dto.mostrarResumen) {
      const resumenHtml = _renderResumenTable({ lineas: totales.lineas });
      html = html.replace(
        /(<div style="margin-top:16px;" class="section-label">Detalle de productos y servicios<\/div>)/,
        `${resumenHtml}\n        $1`,
      );
    }

    // 8) Portada (section completa ANTES del documento).
    const portadaHtml = _renderPortadaSheet({
      portada: dto.portada, empresa, numero, cliente: dto.cliente, fechaIso,
    });
    if (portadaHtml) {
      html = html.replace(/(<body[^>]*>)/, `$1\n${portadaHtml}`);
    }

    // 9) Anexo fotográfico al final + CSS extra.
    const { anexoHtml, anexoCss } = _renderAnexoFotos({
      lineas:    totales.lineas,
      numero,
      fechaIso,
    });
    if (anexoHtml) {
      html = html.replace(/<\/style>/, `${anexoCss}</style>`);
      html = html.replace('</body></html>', `${anexoHtml}\n</body></html>`);
    }

    return html;
  }

  // ─── API pública del service ──────────────────────────────────────────────
  async function generarPdf(dto) {
    const totales   = _calcularTotales(dto);
    const fechaIso  = new Date().toISOString();
    const numero    = dto.numeroDocumento || `COT-${Date.now().toString().slice(-6)}`;

    // Hash precomputado para el QR del primer sheet. _renderHtml lo recalcula
    // adentro con el mismo seed, así QR y verifyUrl quedan sincronizados.
    let draftPreview = null;
    if (repo && typeof repo.findOne === 'function') {
      try { draftPreview = await repo.findOne({ numeroDocumento: numero }); } catch {}
    }
    const hash = _computeVerifyHash({
      draftId:         draftPreview?.id ?? null,
      numeroDocumento: numero,
      total:           totales.total,
      fechaIso,
    });
    const qrPayload = `${PUBLIC_VERIFY_BASE}/verify/${hash}`;
    const qrDataUri = await _qrDataUri(qrPayload);
    const html      = await _renderHtml({ dto, totales, qrDataUri, fechaIso });

    // Empresa para header/footer template (fetch ya hecho dentro de _renderHtml
    // — re-fetch aquí para evitar dependencia de cache. Falla → defaults).
    let empresaTpl = null;
    if (repo && typeof repo.findEmpresaPerfil === 'function') {
      try { empresaTpl = await repo.findEmpresaPerfil(); } catch {}
    }
    const empresaFinal = empresaTpl
      ? { ...empresaTpl, assets: typeof inlineAssets === 'function' ? await inlineAssets(empresaTpl.assets ?? {}) : (empresaTpl.assets ?? {}) }
      : { razonSocial: dto.empresaNombre?.trim() || NOMBRE_EMPRESA_DEFAULT, rnc: null, telefono: null, email: null, website: dto.empresaWebsite?.trim() || WEBSITE_DEFAULT, eslogan: dto.empresaTagline?.trim() || TAGLINE_DEFAULT, assets: {} };

    const headerTemplate = _buildHeaderTemplate({ empresa: empresaFinal });
    const footerTemplate = _buildFooterTemplate({ empresa: empresaFinal, qrDataUri, verifyUrl: qrPayload });

    const buffer = await generarPdfDocumento(html, {
      format: 'Letter',
      // margin top/bottom DEBE coincidir con la regla @page del HTML (48/38)
      // para que el body inicie EXACTAMENTE donde termina el header template
      // y termine donde empieza el footer template. Nunca overlap.
      //   Header alto ≈ 32mm (3mm band + 5mm padding + 16mm logo + texto)
      //   Footer alto ≈ 28mm (qr 16mm + verify text + padding + página N/M)
      // 48mm top deja 16mm de aire entre header y body — visualmente limpio.
      // 38mm bottom deja 10mm de aire entre body y footer.
      margin: { top: '48mm', right: '0mm', bottom: '38mm', left: '0mm' },
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
    });
    if (!buffer || !buffer.length) {
      throw new CotizadorLibreError(500, 'PDF_EMPTY', 'El render generó un PDF vacío.');
    }
    // Side-effect: persist hash en el draft para que /verify/:hash lo encuentre.
    // No bloquea el response — si falla, el PDF ya está generado y el QR todavía
    // funciona si el hash matchea algún draft persistido posteriormente con auto-save.
    _persistirHashEnDraft({ numeroDocumento: numero, hash }).catch(() => {});

    return { buffer, totales, numeroDocumento: numero, verifyHash: hash };
  }

  // ─── Drafts (persistencia opcional — repo puede no estar inyectado) ──────
  function _assertRepo() {
    if (!repo) {
      throw new CotizadorLibreError(500, 'NO_REPO',
        'Repo de drafts no inyectado — endpoint no disponible.');
    }
  }

  function _normScope(scope) {
    const requesterId = Number(scope?.requesterId);
    if (!Number.isInteger(requesterId) || requesterId <= 0) {
      throw new CotizadorLibreError(401, 'NO_USER', 'requesterId requerido.');
    }
    const isGlobal = !!scope?.isGlobal;
    const target   = scope?.targetEmpleadoId != null ? Number(scope.targetEmpleadoId) : null;
    if (target != null && (!Number.isInteger(target) || target <= 0)) {
      throw new CotizadorLibreError(400, 'BAD_TARGET', 'targetEmpleadoId inválido.');
    }
    return { requesterId, isGlobal, targetEmpleadoId: target };
  }

  async function listDrafts(scope, query = {}) {
    _assertRepo();
    const { requesterId, isGlobal, targetEmpleadoId } = _normScope(scope);
    const empleadoFiltro = isGlobal
      ? (targetEmpleadoId ?? null)
      : requesterId;
    const drafts = await repo.list({ empleadoId: empleadoFiltro, limit: query.limit });
    return { drafts, scope: { isGlobal, filteredBy: empleadoFiltro } };
  }

  async function getDraft(scope, numeroDocumento) {
    _assertRepo();
    const { requesterId, isGlobal, targetEmpleadoId } = _normScope(scope);
    const empleadoFiltro = isGlobal
      ? (targetEmpleadoId ?? null)
      : requesterId;
    const draft = await repo.findOne({ numeroDocumento, empleadoId: empleadoFiltro });
    if (!draft) throw new CotizadorLibreError(404, 'NOT_FOUND', 'Borrador no encontrado.');
    return draft;
  }

  async function upsertDraft(scope, dto) {
    _assertRepo();
    const { requesterId, isGlobal, targetEmpleadoId } = _normScope(scope);
    const ownerEmpleadoId = (isGlobal && targetEmpleadoId)
      ? targetEmpleadoId
      : requesterId;
    const saved = await repo.upsertByEmpleadoYNumero(ownerEmpleadoId, dto.numeroDocumento, {
      cliente:     dto.cliente,
      items:       dto.items,
      condiciones: dto.condiciones,
      meta:        dto.meta ?? null,
    });
    return saved;
  }

  async function deleteDraft(scope, numeroDocumento) {
    _assertRepo();
    const { requesterId, isGlobal, targetEmpleadoId } = _normScope(scope);
    const ownerEmpleadoId = (isGlobal && targetEmpleadoId)
      ? targetEmpleadoId
      : requesterId;
    const r = await repo.deleteByEmpleadoYNumero(ownerEmpleadoId, numeroDocumento);
    return { deleted: r.count };
  }

  /**
   * getStats — fail-closed: solo se invoca via endpoint con permiso global.
   * Devuelve agregaciones puras (sin PII del cliente) para panel admin.
   */
  async function getStats(scope) {
    _assertRepo();
    const { isGlobal } = _normScope(scope);
    if (!isGlobal) {
      throw new CotizadorLibreError(403, 'NO_SCOPE', 'Stats requiere permiso ventas:cotizador_libre_global.');
    }
    return repo.getStats();
  }

  return { generarPdf, listDrafts, getDraft, upsertDraft, deleteDraft, getStats };
}

module.exports = createCotizadorLibreService;
module.exports.CotizadorLibreError = CotizadorLibreError;
