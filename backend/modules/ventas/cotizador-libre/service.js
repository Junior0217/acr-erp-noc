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

const NOMBRE_EMPRESA_DEFAULT  = 'RA Networks & Solutions';
const TAGLINE_DEFAULT         = 'Infraestructura de Redes · Seguridad Electrónica · Fibra Óptica';
const WEBSITE_DEFAULT         = 'https://acrnetworks.do';

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
  function _renderAnexoSheet({ tilesHtml, empresa, numero, fechaIso, qrDataUri, verifyUrl, totalFotos, paginaNum, paginasTotales }) {
    const repFull = [empresa.representanteNombre, empresa.representanteApellido].filter(Boolean).join(' ').trim();
    const corpRows = [
      empresa.rnc      ? `<div class="row"><span class="lbl">RNC</span><span class="val mono">${_esc(empresa.rnc)}</span></div>` : '',
      empresa.telefono ? `<div class="row"><span class="lbl">Tel.</span><span class="val mono">${_esc(empresa.telefono)}</span></div>` : '',
      empresa.email    ? `<div class="row"><span class="lbl">Email</span><span class="val">${_esc(empresa.email)}</span></div>` : '',
      empresa.website  ? `<div class="row"><span class="lbl">Web</span><span class="val">${_esc(empresa.website)}</span></div>` : '',
    ].filter(Boolean).join('');
    const assets = empresa.assets ?? {};
    const fechaCortaStr = fechaCorta(fechaIso);

    return `
<div class="sheet" style="page-break-before: always;">
  <div class="band"></div>

  <header class="header">
    <div class="brand">
      ${assets.logoClaro ? `<div class="logo"><img src="${_esc(assets.logoClaro)}" alt=""/></div>` : ''}
      <div class="brand-info">
        <div class="razon">${_esc(empresa.razonSocial ?? '—')}</div>
        ${empresa.nombreComercial ? `<div class="nombre-comercial">${_esc(empresa.nombreComercial)}</div>` : ''}
        ${empresa.eslogan ? `<div class="eslogan">${_esc(empresa.eslogan)}</div>` : ''}
      </div>
    </div>
    <div class="corp-meta">${corpRows}</div>
  </header>

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

  <main class="body">
    <div class="section-label">Capturas de campo</div>
    <div class="anexo-grid">${tilesHtml}</div>
  </main>

  <footer class="footer">
    <div class="qr-block">
      ${verifyUrl
        ? `<a class="qr-anchor" href="${_esc(verifyUrl)}"><img class="qr-img" src="${_esc(qrDataUri || '')}" alt="QR de verificación"/></a>`
        : `<img class="qr-img" src="${_esc(qrDataUri || '')}" alt="QR de verificación"/>`}
      <div class="qr-text">
        <div class="qr-ttl">Verificación Anti-Fraude</div>
        <div>Escanea el QR o toca la URL para validar.</div>
        ${verifyUrl
          ? `<div class="qr-url" title="${_esc(verifyUrl)}"><a href="${_esc(verifyUrl)}" style="text-decoration:none; color:inherit; display:block; word-wrap:break-word; overflow-wrap:break-word; white-space:normal;">${_esc(verifyUrl)}</a></div>`
          : (empresa.website ? `<div class="qr-url" title="${_esc(empresa.website)}"><a href="${_esc(empresa.website.startsWith('http') ? empresa.website : 'https://' + empresa.website)}" style="text-decoration:none; color:inherit; display:block; word-wrap:break-word; overflow-wrap:break-word; white-space:normal;">${_esc(empresa.website)}</a></div>` : '')}
      </div>
    </div>
    <div class="ctr">
      <div>Documento Electrónico Verificable</div>
      <div class="verify-line">${_esc(empresa.razonSocial ?? '')}${empresa.rnc ? ` · RNC ${_esc(empresa.rnc)}` : ''}</div>
    </div>
    <div class="right mono">${_esc(fechaCortaStr)}</div>
  </footer>
</div>`;
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

  function _renderAnexoFotos({ lineas, empresa, numero, fechaIso, qrDataUri, verifyUrl }) {
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
      empresa,
      numero,
      fechaIso,
      qrDataUri,
      verifyUrl,
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

    const verifyUrl = `${(empresa.website || WEBSITE_DEFAULT).replace(/\/+$/, '')}/cotizador-pro?doc=${encodeURIComponent(numero)}`;

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

    // 2) Inyectar fila Descuento si aplica.
    html = _injectarDescuentoEnTotales(html, totales.descuento);

    // 3) Inyectar anexo fotográfico + CSS extra.
    const { anexoHtml, anexoCss } = _renderAnexoFotos({
      lineas:    totales.lineas,
      empresa,
      numero,
      fechaIso,
      qrDataUri,
      verifyUrl,
    });
    if (anexoHtml) {
      // Inyectar CSS del anexo justo antes del cierre del <style> oficial.
      html = html.replace(/<\/style>/, `${anexoCss}</style>`);
      // Inyectar el bloque de páginas del anexo antes del cierre del último sheet.
      html = html.replace('</body></html>', `${anexoHtml}\n</body></html>`);
    }

    return html;
  }

  // ─── API pública del service ──────────────────────────────────────────────
  async function generarPdf(dto) {
    const totales   = _calcularTotales(dto);
    const fechaIso  = new Date().toISOString();
    const qrPayload = `${(dto.empresaWebsite?.trim() || WEBSITE_DEFAULT).replace(/\/+$/, '')}/cotizador-pro?doc=${encodeURIComponent(dto.numeroDocumento || 'COT')}`;
    const qrDataUri = await _qrDataUri(qrPayload);
    const html      = await _renderHtml({ dto, totales, qrDataUri, fechaIso });
    const buffer    = await generarPdfDocumento(html, {
      format: 'Letter',
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });
    if (!buffer || !buffer.length) {
      throw new CotizadorLibreError(500, 'PDF_EMPTY', 'El render generó un PDF vacío.');
    }
    return { buffer, totales, numeroDocumento: dto.numeroDocumento || `COT-${Date.now().toString().slice(-6)}` };
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

  return { generarPdf, listDrafts, getDraft, upsertDraft, deleteDraft };
}

module.exports = createCotizadorLibreService;
module.exports.CotizadorLibreError = CotizadorLibreError;
