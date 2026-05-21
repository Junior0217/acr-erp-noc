/**
 * backend/modules/ventas/cotizador-libre/service.js
 *
 * Lógica del Cotizador Libre. Render PDF puro en memoria — sin NCF, sin
 * descuento de stock, sin AuditCaja. Es una herramienta de cotización
 * editable libre para proyectos de infraestructura/CCTV donde los precios
 * y descripciones se manejan fuera del catálogo rígido.
 *
 * Ciclo 13:
 *   - Acepta `scope` en list/get/upsert/delete:
 *       { requesterId, isGlobal, targetEmpleadoId? }
 *     `isGlobal` se deriva de los permisos del JWT en el controller.
 *     Cuando `isGlobal` está activo, las queries NO filtran por empleadoId
 *     (modo Owner/Socios: ver y co-editar borradores de otros técnicos).
 *     Cuando NO, fuerza filtro por requesterId (fail-closed).
 *   - PDF incluye anexo fotográfico de Ítems con `fotos[]`. Se renderiza en
 *     una nueva página (page-break-before: always) con grid 2-col y captions
 *     "Lugar: …" + "Modelo: …" para cada foto.
 *
 * Pipeline render:
 *   1. Recibe dto validado por schema.js.
 *   2. Calcula subtotal/itbis/total en backend (defensa-en-profundidad).
 *   3. Genera QR para validación (link público).
 *   4. Renderiza HTML inline-template con CSS Cyber-Industrial.
 *   5. Renderiza ANEXO FOTOGRÁFICO si hay fotos en algún ítem.
 *   6. Devuelve Buffer al controller.
 *
 * Factory: createCotizadorLibreService({ generarPdfDocumento, QRCode, repo })
 */

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

function createCotizadorLibreService(deps) {
  const { generarPdfDocumento, QRCode, repo } = deps;
  if (typeof generarPdfDocumento !== 'function') throw new Error('createCotizadorLibreService: generarPdfDocumento required');

  // ─── Helpers de cálculo (defensa-en-profundidad) ──────────────────────────
  function _calcularTotales(dto) {
    const pct = Number(dto.porcentajeItbis ?? 18) / 100;

    // Subtotal por línea = cantidad × precio.
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
    // a la vez en práctica. Si ambos vienen, ganamos al porcentaje y dejamos
    // el monto como adicional para no penalizar al cliente).
    const dscPct  = Math.max(0, Math.min(100, Number(dto.descuentoGlobalPct ?? 0))) / 100;
    const dscFijo = Math.max(0, Number(dto.descuentoGlobalMonto ?? 0));
    const descuentoCalc = Math.round((subtotal * dscPct + dscFijo) * 100) / 100;
    const descuento = Math.min(descuentoCalc, subtotal); // no negative neto

    const baseImponible = Math.max(0, subtotal - descuento);
    // ITBIS recalculado sobre baseImponible (no sobre subtotal sin descuento).
    const itbis = dto.aplicaItbisGlobal
      ? Math.round(baseImponible * pct * 100) / 100
      : 0;
    const total = Math.round((baseImponible + itbis) * 100) / 100;

    return { lineas, subtotal, descuento, baseImponible, itbis, total };
  }

  function _fmt(n) {
    return Number(n ?? 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _normCond(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() ? { texto: v.trim(), incluir: true } : null;
    if (v.incluir && v.texto?.trim()) return { texto: v.texto.trim(), incluir: true };
    return null;
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

  // ─── Anexo fotográfico: si algún ítem trae fotos[], se renderiza una nueva
  // página al final del PDF con grid 2-col. Las captions referencian el ítem
  // (#N + descripción truncada) + Lugar de Instalación + Modelo opcional.
  function _renderAnexoFotos({ lineas, numDoc }) {
    // Aplanar: cada foto se renderiza con sus metadatos contextuales del ítem
    // padre (lugar de instalación, número de ítem, descripción).
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

    if (tiles.length === 0) return '';

    const cells = tiles.map((t) => `
      <figure class="foto-card">
        <div class="foto-wrap"><img src="${t.dataUri}" alt="Foto ${t.itemIdx}.${t.fotoIdx}" /></div>
        <figcaption>
          <div class="foto-meta">Ítem ${t.itemIdx}.${t.fotoIdx} ${t.modelo ? `· <strong>${_esc(t.modelo)}</strong>` : ''}</div>
          <div class="foto-desc">${_esc(t.descripcion)}</div>
          ${t.lugar ? `<div class="foto-lugar"><strong>Lugar:</strong> ${_esc(t.lugar)}</div>` : ''}
          ${t.nombre ? `<div class="foto-nombre">${_esc(t.nombre)}</div>` : ''}
        </figcaption>
      </figure>
    `).join('');

    return `
      <section class="anexo">
        <header class="anexo-head">
          <div class="anexo-title">Anexo Técnico — Fotografías del Levantamiento</div>
          <div class="anexo-sub">Documento ${_esc(numDoc)} · ${tiles.length} imagen${tiles.length === 1 ? '' : 'es'}</div>
        </header>
        <div class="anexo-grid">${cells}</div>
      </section>
    `;
  }

  // ─── HTML template (Cyber-Industrial, omitido SKU / Registro Mercantil) ───
  function _renderHtml({ dto, totales, qrDataUri, fechaIso }) {
    const empNombre   = dto.empresaNombre?.trim() || NOMBRE_EMPRESA_DEFAULT;
    const empTagline  = dto.empresaTagline?.trim() || TAGLINE_DEFAULT;
    const empWebsite  = dto.empresaWebsite?.trim() || WEBSITE_DEFAULT;
    const cli = dto.cliente;
    const cond = dto.condiciones ?? {};
    const numDoc = dto.numeroDocumento || `COT-${Date.now().toString().slice(-6)}`;
    const fechaCorta = new Date(fechaIso).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });

    // En la tabla principal mostramos también lugarInstalacion debajo de la
    // descripción si el ítem tiene fotos asociadas — así el lector ve la
    // referencia del anexo sin tener que pasar página.
    const filasItems = totales.lineas.map((l, i) => {
      const lugar = (l.lugarInstalacion ?? '').toString().trim();
      const tieneFotos = Array.isArray(l.fotos) && l.fotos.length > 0;
      const sufijo = lugar
        ? `<div class="lugar-inline">📍 ${_esc(lugar)}${tieneFotos ? ` · <span class="fotos-ref">ver anexo</span>` : ''}</div>`
        : (tieneFotos ? `<div class="lugar-inline">📎 <span class="fotos-ref">ver anexo</span></div>` : '');
      return `
      <tr>
        <td class="num">${i + 1}</td>
        <td class="codigo">${_esc(l.codigo ?? '')}</td>
        <td class="desc">${_esc(l.descripcion ?? '')}${sufijo}</td>
        <td class="qty">${l.qty}</td>
        <td class="num">RD$ ${_fmt(l.pu)}</td>
        <td class="num">RD$ ${_fmt(l.subtotal)}</td>
      </tr>
    `;
    }).join('');

    const condRow = (label, v) => {
      const c = _normCond(v);
      if (!c) return '';
      return `<div class="cond"><span class="cond-label">${label}</span><span class="cond-text">${_esc(c.texto)}</span></div>`;
    };

    const qrBlock = qrDataUri
      ? `<img class="qr" src="${qrDataUri}" alt="QR validación" />`
      : '<div class="qr-placeholder">QR</div>';

    const anexoHtml = _renderAnexoFotos({ lineas: totales.lineas, numDoc });

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${_esc(dto.titulo || 'Cotización')} ${_esc(numDoc)}</title>
<style>
  *,*:before,*:after { box-sizing: border-box; }
  html,body { margin:0; padding:0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color:#0f172a; }
  body { padding: 24mm 16mm 22mm 16mm; font-size: 10pt; }
  .header { text-align:center; border-bottom: 2px solid #1e293b; padding-bottom: 12px; margin-bottom: 18px; }
  .header h1 { margin:0; font-size: 20pt; letter-spacing: 0.06em; color:#1e293b; }
  .header .tagline { margin: 4px 0 0; font-size: 9pt; color:#475569; letter-spacing: 0.05em; }
  .header .doc-meta { margin-top: 12px; display:flex; justify-content: space-between; font-size: 9.5pt; }
  .header .doc-meta strong { color:#1e293b; }
  .doc-title { display:inline-block; font-weight:700; font-size: 12pt; padding: 6px 14px; border: 1.5px solid #1e293b; background:#0f172a; color:#fff; letter-spacing: 0.12em; }

  .cliente-box { background:#f8fafc; border: 1px solid #cbd5e1; padding: 10px 12px; margin: 14px 0 18px; border-radius: 4px; }
  .cliente-box .label { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.1em; color:#64748b; }
  .cliente-box .razon { font-size: 12pt; font-weight: 700; margin-top: 2px; color:#0f172a; }
  .cliente-box .row { display:flex; flex-wrap: wrap; gap: 18px; margin-top: 4px; font-size: 9.5pt; color:#334155; }
  .cliente-box .row span { display:inline-block; }

  table.items { width:100%; border-collapse: collapse; margin-top: 4px; }
  table.items thead th { background:#0f172a; color:#fff; padding: 7px 8px; font-size: 8.5pt; letter-spacing: 0.08em; text-transform: uppercase; text-align: left; }
  table.items thead th.num { text-align: right; }
  table.items thead th.qty { text-align: center; width: 6%; }
  table.items thead th.codigo { width: 14%; }
  table.items thead th.desc { width: 46%; }
  table.items tbody td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; font-size: 10pt; }
  table.items tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.items tbody td.qty { text-align: center; }
  table.items tbody td.codigo { color:#475569; font-family: 'Menlo','Consolas',monospace; font-size: 9pt; }
  table.items tbody td.desc { color:#0f172a; }
  .lugar-inline { font-size: 8.5pt; color: #475569; margin-top: 3px; letter-spacing: 0.02em; }
  .fotos-ref { color: #0f172a; font-weight: 600; text-decoration: underline dotted; }

  .totales { margin-left: auto; width: 38%; margin-top: 14px; }
  .totales .row { display:flex; justify-content: space-between; padding: 4px 10px; font-size: 10pt; }
  .totales .row.sub { border-bottom: 1px dashed #cbd5e1; }
  .totales .row.itbis { border-bottom: 1px dashed #cbd5e1; }
  .totales .row.total { background:#0f172a; color:#fff; font-weight: 700; font-size: 11.5pt; padding: 8px 10px; margin-top: 4px; letter-spacing: 0.04em; }

  .condiciones { margin-top: 22px; border-top: 1px solid #cbd5e1; padding-top: 12px; }
  .condiciones h3 { margin: 0 0 8px; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.12em; color:#475569; }
  .cond { display:flex; gap: 10px; margin-bottom: 4px; font-size: 9.5pt; }
  .cond-label { min-width: 92px; font-weight: 700; text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.08em; color:#1e293b; }
  .cond-text { color:#334155; flex:1; }

  /* Footer fijo en cada página */
  .footer { position: fixed; bottom: 8mm; left: 16mm; right: 16mm; border-top: 1px solid #cbd5e1; padding-top: 6px; display:flex; justify-content: space-between; align-items: flex-end; font-size: 8.5pt; color:#64748b; }
  .footer .url { font-weight: 600; color:#1e293b; }
  .footer .url small { display:block; font-weight: 400; font-size: 7.5pt; color:#94a3b8; letter-spacing: 0.05em; }
  .footer .qr { width: 60px; height: 60px; display: block; }
  .footer .qr-placeholder { width: 60px; height: 60px; border:1px dashed #cbd5e1; display:flex; align-items: center; justify-content: center; font-size: 7pt; color:#94a3b8; }

  /* ─── Anexo fotográfico (página separada) ────────────────────────────── */
  .anexo { page-break-before: always; padding-top: 0; }
  .anexo-head { border-bottom: 2px solid #1e293b; padding-bottom: 8px; margin-bottom: 14px; }
  .anexo-title { font-size: 14pt; font-weight: 700; color: #0f172a; letter-spacing: 0.04em; }
  .anexo-sub { font-size: 9pt; color: #64748b; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 4px; }
  .anexo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm 8mm; }
  .foto-card { margin: 0; page-break-inside: avoid; border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; background: #f8fafc; }
  .foto-wrap { width: 100%; aspect-ratio: 4 / 3; background: #0f172a; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .foto-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .foto-card figcaption { padding: 8px 10px 10px; font-size: 8.5pt; color: #334155; line-height: 1.35; }
  .foto-meta { font-size: 8pt; color: #1e293b; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 3px; }
  .foto-desc { color: #334155; margin-bottom: 4px; }
  .foto-lugar { color: #0f172a; }
  .foto-lugar strong { color: #475569; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.08em; margin-right: 3px; }
  .foto-nombre { color: #94a3b8; font-size: 8pt; margin-top: 2px; font-style: italic; }
</style>
</head>
<body>
  <div class="header">
    <h1>${_esc(empNombre)}</h1>
    <p class="tagline">${_esc(empTagline)}</p>
    <div class="doc-meta">
      <div><strong>Documento:</strong> <span class="doc-title">${_esc(dto.titulo || 'COTIZACIÓN')} ${_esc(numDoc)}</span></div>
      <div><strong>Fecha:</strong> ${_esc(fechaCorta)}</div>
    </div>
  </div>

  <div class="cliente-box">
    <div class="label">Cotizado para</div>
    <div class="razon">${_esc(cli.razonSocial)}</div>
    <div class="row">
      ${cli.contacto  ? `<span><strong>Contacto:</strong> ${_esc(cli.contacto)}</span>` : ''}
      ${cli.rnc       ? `<span><strong>RNC:</strong> ${_esc(cli.rnc)}</span>` : ''}
      ${cli.telefono  ? `<span><strong>Tel:</strong> ${_esc(cli.telefono)}</span>` : ''}
    </div>
    ${cli.direccion ? `<div class="row"><span><strong>Dirección:</strong> ${_esc(cli.direccion)}</span></div>` : ''}
  </div>

  <table class="items">
    <thead>
      <tr>
        <th class="num">#</th>
        <th class="codigo">Código</th>
        <th class="desc">Descripción</th>
        <th class="qty">Cant.</th>
        <th class="num">Precio Unit.</th>
        <th class="num">Importe</th>
      </tr>
    </thead>
    <tbody>${filasItems}</tbody>
  </table>

  <div class="totales">
    <div class="row sub"><span>Subtotal</span><span>RD$ ${_fmt(totales.subtotal)}</span></div>
    ${totales.descuento > 0 ? `<div class="row sub"><span>Descuento</span><span>− RD$ ${_fmt(totales.descuento)}</span></div>` : ''}
    ${dto.aplicaItbisGlobal ? `<div class="row itbis"><span>ITBIS ${Number(dto.porcentajeItbis ?? 18).toFixed(0)}%</span><span>RD$ ${_fmt(totales.itbis)}</span></div>` : ''}
    <div class="row total"><span>Total RD$</span><span>RD$ ${_fmt(totales.total)}</span></div>
  </div>

  <div class="condiciones">
    <h3>Condiciones del documento</h3>
    ${condRow('Validez', cond.validez)}
    ${condRow('Forma de pago', cond.pago)}
    ${condRow('Tiempo de entrega', cond.entrega)}
    ${condRow('Garantía', cond.garantia)}
    ${condRow('Notas', cond.notas)}
  </div>

  <div class="footer">
    <div class="url">
      ${_esc(empWebsite)}
      <small>Cotización electrónica · Documento no fiscal</small>
    </div>
    ${qrBlock}
  </div>

  ${anexoHtml}
</body>
</html>`;
  }

  // ─── API pública del service ──────────────────────────────────────────────
  async function generarPdf(dto) {
    const totales   = _calcularTotales(dto);
    const fechaIso  = new Date().toISOString();
    const qrPayload = `${(dto.empresaWebsite?.trim() || WEBSITE_DEFAULT).replace(/\/+$/, '')}/cotizador-pro?doc=${encodeURIComponent(dto.numeroDocumento || 'COT')}`;
    const qrDataUri = await _qrDataUri(qrPayload);
    const html      = _renderHtml({ dto, totales, qrDataUri, fechaIso });
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

  /**
   * listDrafts — si caller es global puede pasar opcionalmente targetEmpleadoId
   * para filtrar a un técnico específico (típico: Owner buscando los drafts de
   * Cristian). Si NO se pasa, lista todos los drafts (cross-user) ordenados
   * por updatedAt DESC.
   */
  async function listDrafts(scope, query = {}) {
    _assertRepo();
    const { requesterId, isGlobal, targetEmpleadoId } = _normScope(scope);
    const empleadoFiltro = isGlobal
      ? (targetEmpleadoId ?? null)   // global: puede filtrar a un target o ver todo
      : requesterId;                 // no-global: SIEMPRE forzado a su propio id
    const drafts = await repo.list({ empleadoId: empleadoFiltro, limit: query.limit });
    return { drafts, scope: { isGlobal, filteredBy: empleadoFiltro } };
  }

  async function getDraft(scope, numeroDocumento) {
    _assertRepo();
    const { requesterId, isGlobal, targetEmpleadoId } = _normScope(scope);
    // Global con targetEmpleadoId → unique. Global sin target → findFirst.
    // No-global → siempre por su propio id (fail-closed).
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
    // Si caller es global y pasa targetEmpleadoId, el upsert apunta al dueño
    // target (co-edición en vivo del draft de Cristian). Sino, dueño = caller.
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
