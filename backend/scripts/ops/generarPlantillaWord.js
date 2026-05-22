/**
 * backend/scripts/ops/generarPlantillaWord.js
 *
 * Plantilla DOCX editable con PARIDAD VISUAL 1:1 al template PDF oficial
 * (`backend/services/pdf-templates.js`). Renderizada como Office HTML
 * (MSO/VML namespace) y serializada con extensión `.docx` para que Word
 * la abra heredando el CSS exacto del PDF (paleta slate-900/100/blue-800,
 * fuentes 10px/14.5px/17px, paddings, bordes, marca de agua institucional).
 *
 * Por qué Office-HTML y no docx-OOXML puro: el template oficial es CSS
 * altamente expresivo (grid, opacity, transforms para watermark). Word
 * interpreta este formato — declarado vía xmlns:w/xmlns:o/xmlns:v —
 * mucho mejor que cualquier conversión OOXML manual. Ediciones libres
 * en Word funcionan normalmente (selección, copy/paste, edición de
 * tabla), y la apariencia se preserva al imprimir.
 *
 * Espejo del PDF:
 *   · banda corporate slate-300 de 3px
 *   · header empresa centralizado (logo placeholder + razón social + nombre
 *     comercial + eslogan + corp-meta con RNC/dirección/teléfono/email)
 *   · marca de agua VML "COTIZACIÓN" rotada -20deg color #1e40af opacidad
 *     ~0.045 (idéntica al PDF Puppeteer)
 *   · title-bar slate-100 con doc-type 17px y número en chip slate-200
 *   · client-grid 3 col (Razón Social / RNC / Dirección)
 *   · tabla items: header slate-100 9px caps, body 10px slate-900,
 *     zebra slate-50, bordes hair slate-200, monoespaciada en cant/precio
 *   · totales: subtotal/ITBIS + grand-row slate-100 con borde superior
 *     medium slate-400 (14px bold caps slate-900)
 *   · condiciones + firmas dual + footer corporativo con QR placeholder
 *   · anexo fotográfico página nueva con grid 2×2 dashed slate-300
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.docx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaWord.js
 */

const path = require('path');
const fs   = require('fs');

const EMPRESA = {
  razonSocial:     'ACR Networks & Solutions, SRL',
  nombreComercial: 'ACR NETWORKS & SOLUTIONS',
  eslogan:         'Infraestructura de Redes · Seguridad Electrónica · Fibra Óptica',
  rnc:             '1-32-12345-6',
  direccion:       'Santo Domingo, República Dominicana',
  telefono:        '+1 809 000 0000',
  email:           'contacto@acrnetworks.do',
  website:         'https://acrnetworks.do',
};

const FILAS_INICIALES = 12;

function _hoyISO() { return new Date().toISOString().slice(0, 10); }
function _plus30() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

// ─── CSS clonado 1:1 del template PDF oficial ───────────────────────────────
// Conservamos las clases (`.header`, `.title-bar`, `.items`, `.totals`, etc.)
// para mantener semántica visual idéntica. Ajustes mínimos para Word
// (px → pt donde corresponde + bg via mso-shading).
const CSS = `
  @page Cotizacion {
    size: Letter;
    margin: 0.5in 0.4in 0.6in 0.4in;
    mso-header-margin: 0.3in;
    mso-footer-margin: 0.3in;
    mso-page-orientation: portrait;
  }
  div.section { page: Cotizacion; }

  body {
    font-family: 'Calibri', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif;
    color: #0f172a;
    font-size: 10pt;
    line-height: 1.4;
    margin: 0;
  }

  .mono { font-family: 'Consolas', 'Courier New', monospace; }

  /* ───── Banda corporate ───── */
  .band {
    height: 3pt;
    background: #cbd5e1;
    mso-shading: #cbd5e1;
    border: 0;
  }

  /* ───── Header ───── */
  table.header { width: 100%; border-collapse: collapse; padding: 0; }
  table.header td.brand     { padding: 12pt 14pt 8pt 18pt; vertical-align: middle; width: 60%; }
  table.header td.corp-meta { padding: 12pt 18pt 8pt 14pt; vertical-align: middle; width: 40%; text-align: right; font-size: 9.5pt; color: #475569; line-height: 1.55; }
  .razon            { font-size: 16pt; font-weight: 800; color: #0f172a; letter-spacing: -0.01em; line-height: 1.15; }
  .nombre-comercial { font-size: 9pt;  color: #1e40af; font-weight: 700; margin-top: 3pt; letter-spacing: 0.08em; text-transform: uppercase; }
  .eslogan          { font-size: 8.5pt; color: #64748b; margin-top: 4pt; font-style: italic; }
  .corp-meta .row   { display: block; margin-bottom: 2pt; }
  .corp-meta .lbl   { color: #94a3b8; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 800; margin-right: 6pt; }
  .corp-meta .val   { color: #0f172a; font-weight: 700; }
  .corp-meta .val-direccion { color: #334155; font-weight: 500; }
  .header-sep { border-bottom: 1px solid #e2e8f0; height: 0; }

  /* ───── Title bar ───── */
  table.title-bar { width: 100%; border-collapse: collapse; background: #f1f5f9; mso-shading: #f1f5f9; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; }
  table.title-bar td.doc-type {
    background: #f1f5f9; mso-shading: #f1f5f9;
    padding: 10pt 18pt 10pt 18pt;
    font-size: 17pt; font-weight: 800; letter-spacing: 0.1em;
    text-transform: uppercase; color: #1e293b;
    width: 60%;
  }
  table.title-bar td.doc-type .sub { font-size: 8.5pt; font-weight: 500; color: #64748b; letter-spacing: 0.14em; display: block; margin-top: 2pt; text-transform: uppercase; }
  table.title-bar td.doc-meta {
    background: #f1f5f9; mso-shading: #f1f5f9;
    padding: 10pt 18pt 10pt 14pt;
    text-align: right;
    font-size: 9.5pt; line-height: 1.4; color: #1e293b;
    width: 40%;
  }
  .doc-meta .num {
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 17pt; font-weight: 900; letter-spacing: 0.04em;
    color: #0f172a; background: #e2e8f0; mso-shading: #e2e8f0;
    padding: 3pt 10pt; border-radius: 4pt;
    display: inline-block;
  }
  .doc-meta .fechas { margin-top: 6pt; font-size: 9pt; color: #1e293b; }
  .doc-meta .fechas strong { color: #0f172a; }

  /* ───── Body ───── */
  table.body { width: 100%; border-collapse: collapse; padding: 0; }
  table.body td.body-cell { padding: 12pt 18pt 12pt 18pt; vertical-align: top; }

  .section-label {
    font-size: 8.5pt; font-weight: 800; color: #475569;
    text-transform: uppercase; letter-spacing: 0.18em;
    margin-bottom: 5pt;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 3pt;
  }

  /* ───── Client grid ───── */
  table.client-grid {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #e2e8f0;
    margin-bottom: 12pt;
  }
  table.client-grid td.client-cell {
    padding: 7pt 13pt;
    border-right: 1px solid #e2e8f0;
    background: #f8fafc; mso-shading: #f8fafc;
    vertical-align: top;
  }
  table.client-grid td.client-cell:last-child { border-right: none; }
  .client-cell .lbl {
    font-size: 7.5pt; color: #64748b; text-transform: uppercase;
    letter-spacing: 0.14em; font-weight: 700; margin-bottom: 4pt;
    display: block;
  }
  .client-cell .val {
    font-size: 11pt; color: #0f172a; font-weight: 700; line-height: 1.3;
  }
  .client-cell .val.normal { font-weight: 500; font-size: 10pt; line-height: 1.4; }
  .client-cell .editable {
    display: inline-block; min-width: 80%;
    border-bottom: 1px dashed #cbd5e1;
    color: #475569;
    padding: 2pt 0;
  }

  /* ───── Items table ───── */
  table.items {
    width: 100%; margin-top: 12pt;
    border-collapse: collapse;
    border: 1px solid #cbd5e1;
  }
  table.items thead th {
    background: #f1f5f9; mso-shading: #f1f5f9;
    color: #334155;
    padding: 7pt 8pt;
    font-size: 8.5pt; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em;
    border-bottom: 1px solid #cbd5e1;
    text-align: left;
  }
  table.items thead th.center { text-align: center; }
  table.items thead th.right  { text-align: right; }
  table.items thead th.col-num  { width: 6%;  text-align: center; }
  table.items thead th.col-cod  { width: 14%; }
  table.items thead th.col-cant { width: 8%;  text-align: center; }
  table.items thead th.col-pu   { width: 14%; text-align: right; }
  table.items thead th.col-itbis { width: 12%; text-align: right; }
  table.items thead th.col-amt  { width: 14%; text-align: right; }
  table.items tbody td {
    padding: 6pt 8pt;
    font-size: 10pt;
    border-bottom: 1px solid #f1f5f9;
    border-right: 1px solid #f1f5f9;
    vertical-align: top;
    color: #0f172a;
  }
  table.items tbody td:last-child { border-right: none; }
  table.items tbody tr.zebra td { background: #f8fafc; mso-shading: #f8fafc; }
  table.items tbody td.num    { color: #94a3b8; font-size: 9pt; text-align: center; font-family: 'Consolas', monospace; }
  table.items tbody td.codigo { font-family: 'Consolas', monospace; color: #1e293b; font-size: 9.5pt; font-weight: 700; }
  table.items tbody td.center { text-align: center; font-family: 'Consolas', monospace; }
  table.items tbody td.right  { text-align: right; font-family: 'Consolas', monospace; }
  table.items tbody td.amt    { text-align: right; font-family: 'Consolas', monospace; font-weight: 700; }

  /* ───── Totals ───── */
  table.totals-wrap { width: 100%; margin-top: 14pt; border-collapse: collapse; }
  table.totals-wrap td.legal-note {
    width: 60%; vertical-align: top;
    padding: 10pt 12pt;
    background: #f8fafc; mso-shading: #f8fafc;
    border: 1px solid #e2e8f0;
    font-size: 8.5pt; color: #64748b; line-height: 1.55;
  }
  .legal-note .ttl { font-size: 9pt; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4pt; display: block; }
  table.totals-wrap td.totals-cell { width: 40%; vertical-align: top; padding-left: 20pt; }
  table.totals { width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; }
  table.totals td { padding: 7pt 14pt; font-size: 10pt; border-bottom: 1px solid #f1f5f9; }
  table.totals td.lbl { color: #475569; font-weight: 600; text-transform: uppercase; font-size: 9pt; letter-spacing: 0.08em; }
  table.totals td.val { color: #0f172a; font-weight: 700; text-align: right; font-family: 'Consolas', monospace; }
  table.totals tr.grand td { background: #f1f5f9; mso-shading: #f1f5f9; padding: 11pt 14pt; border-top: 2px solid #94a3b8; border-bottom: none; }
  table.totals tr.grand td.lbl { color: #475569; font-size: 10pt; font-weight: 800; letter-spacing: 0.12em; }
  table.totals tr.grand td.val { color: #0f172a; font-size: 14pt; font-weight: 800; letter-spacing: 0.02em; }

  /* ───── Conditions ───── */
  table.cond-grid { width: 100%; border-collapse: separate; border-spacing: 6pt 6pt; margin-top: 14pt; }
  table.cond-grid td.cond-cell {
    border: 1px solid #e2e8f0; border-left: 3px solid #1e40af;
    padding: 7pt 10pt;
    background: #f8fafc; mso-shading: #f8fafc;
    width: 25%; vertical-align: top;
  }
  .cond-cell .lbl { font-size: 7.5pt; color: #64748b; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; display: block; }
  .cond-cell .val { font-size: 9.5pt; color: #0f172a; font-weight: 600; margin-top: 2pt; line-height: 1.4; }

  /* ───── Signatures ───── */
  table.sigs { width: 100%; margin-top: 36pt; border-collapse: separate; border-spacing: 40pt 0; }
  table.sigs td.sig-block { text-align: center; vertical-align: top; }
  .sig-line {
    border-top: 1.5px solid #0f172a;
    margin: 56pt 24pt 0 24pt;
  }
  .sig-name {
    margin-top: 5pt;
    font-size: 10pt; font-weight: 800; color: #0f172a;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .sig-role {
    font-size: 8.5pt; color: #64748b; margin-top: 2pt;
    letter-spacing: 0.04em;
  }

  /* ───── Footer ───── */
  div.footer-text {
    border-top: 1px solid #e2e8f0;
    padding-top: 6pt;
    font-size: 8pt; color: #94a3b8;
    text-align: center;
  }
  .footer-razon { color: #475569; font-weight: 700; }

  /* ───── Anexo fotográfico (página nueva) ───── */
  .page-break { page-break-before: always; mso-page-break-before: always; height: 0; }
  .anexo-title {
    font-size: 14pt; font-weight: 800; color: #0f172a;
    text-transform: uppercase; letter-spacing: 0.1em; text-align: center;
    margin-top: 12pt; margin-bottom: 4pt;
  }
  .anexo-sub {
    font-size: 9.5pt; color: #64748b; font-style: italic;
    text-align: center; margin-bottom: 18pt;
  }
  table.anexo-grid { width: 100%; border-collapse: separate; border-spacing: 12pt 12pt; }
  table.anexo-grid td.foto-slot {
    border: 1.5px dashed #cbd5e1;
    width: 50%;
    height: 220pt;
    text-align: center;
    vertical-align: middle;
    color: #94a3b8; font-size: 10pt; font-weight: 700;
  }
  table.anexo-grid td.foto-slot .placeholder {
    color: #94a3b8;
    font-size: 11pt;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    display: block;
  }
  table.anexo-grid td.foto-slot .help {
    color: #cbd5e1;
    font-size: 8.5pt;
    font-style: italic;
    font-weight: 400;
    margin-top: 6pt;
    display: block;
  }
  table.anexo-grid td.foto-slot .pie {
    color: #64748b;
    font-size: 8pt;
    margin-top: 60pt;
    border-top: 1px dashed #cbd5e1;
    padding-top: 4pt;
    display: block;
  }
`;

// ─── Office HTML: encabezado de página con MSO Section ──────────────────────
// Word entiende esta cadena como una "Cotizacion section" + define el
// pie de página via mso-element para que la paginación sea automática.
function _msoSectionXml() {
  return `
  <!--[if gte mso 9]><xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
      <w:DisplayHorizontalDrawingGridEvery>0</w:DisplayHorizontalDrawingGridEvery>
      <w:DisplayVerticalDrawingGridEvery>2</w:DisplayVerticalDrawingGridEvery>
      <w:UseMarginsForDrawingGridOrigin/>
    </w:WordDocument>
  </xml><![endif]-->`;
}

// VML watermark: "Cotización" rotado -20deg, azul #1e40af, opacidad 0.045.
// Renderizado en cada header de sección para que aparezca en cada página.
function _vmlWatermark() {
  return `
  <v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">
    <v:formulas>
      <v:f eqn="sum #0 0 10800"/>
      <v:f eqn="prod #0 2 1"/>
      <v:f eqn="sum 21600 0 @1"/>
      <v:f eqn="sum 0 0 @2"/>
      <v:f eqn="sum 21600 0 @3"/>
      <v:f eqn="if @0 @3 0"/>
      <v:f eqn="if @0 21600 @1"/>
      <v:f eqn="if @0 0 @2"/>
      <v:f eqn="if @0 @4 21600"/>
      <v:f eqn="mid @5 @6"/>
      <v:f eqn="mid @8 @5"/>
      <v:f eqn="mid @7 @8"/>
      <v:f eqn="mid @6 @7"/>
      <v:f eqn="sum @6 0 @5"/>
    </v:formulas>
    <v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="custom"
            o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800"
            o:connectangles="270,180,90,0"/>
    <v:textpath on="t" fitshape="t"/>
  </v:shapetype>
  <v:shape id="WaterMark"
           o:spid="_x0000_s2049"
           type="#_x0000_t136"
           style="position:absolute;
                  margin-left:0;margin-top:0;
                  width:540pt;height:140pt;
                  rotation:-20;
                  z-index:-251654144;
                  mso-position-horizontal:center;
                  mso-position-horizontal-relative:margin;
                  mso-position-vertical:center;
                  mso-position-vertical-relative:margin;"
           fillcolor="#1e40af" stroked="f">
    <v:fill opacity=".045" color2="#1e40af"/>
    <v:textpath style="font-family:&quot;Helvetica&quot;;font-size:1pt;font-weight:bold;v-text-spacing:9pt;v-text-kern:t" string="COTIZACIÓN"/>
  </v:shape>`;
}

// Header con marca de agua + footer (paginación + razón social).
function _msoHeaderFooter() {
  return `
  <div style='mso-element:header' id="h1">
    <p class=MsoHeader>
      <!--[if gte vml 1]>
        ${_vmlWatermark()}
      <![endif]-->
    </p>
  </div>
  <div style='mso-element:footer' id="f1">
    <p class=MsoFooter style="text-align:center; font-size:8pt; color:#475569; border-top:1px solid #e2e8f0; padding-top:4pt;">
      <span style="font-weight:700;">${EMPRESA.razonSocial}</span>
      &nbsp;·&nbsp; RNC ${EMPRESA.rnc}
      &nbsp;·&nbsp; <span style="color:#1e40af;">${EMPRESA.website}</span>
      &nbsp;·&nbsp; Página <span style='mso-field-code:" PAGE "'>1</span> de <span style='mso-field-code:" NUMPAGES "'>1</span>
    </p>
  </div>`;
}

// ─── Helpers de markup ──────────────────────────────────────────────────────
function _editable(min = 0) {
  // Subrayado dashed para campos editables — el usuario rellena directo
  return `<span class="editable" style="min-width:${min || 120}pt;">&nbsp;</span>`;
}

function _filaItem(i, zebra) {
  const cls = zebra ? ' class="zebra"' : '';
  return `
    <tr${cls}>
      <td class="num">${String(i + 1).padStart(2, '0')}</td>
      <td class="codigo">${_editable(60)}</td>
      <td>${_editable(180)}</td>
      <td class="center">${_editable(40)}</td>
      <td class="right">${_editable(70)}</td>
      <td class="right">${_editable(70)}</td>
      <td class="amt">${_editable(70)}</td>
    </tr>`;
}

function _filasItems() {
  return Array.from({ length: FILAS_INICIALES }, (_, i) => _filaItem(i, i % 2 === 1)).join('');
}

function _condCells() {
  const conds = [
    ['Validez',          '30 días desde la emisión'],
    ['Forma de Pago',    '50% confirmación · 50% entrega'],
    ['Tiempo Entrega',   'Sujeto a disponibilidad'],
    ['Garantía',         '12 meses defectos de fábrica'],
  ];
  return conds.map(([lbl, val]) => `
    <td class="cond-cell">
      <span class="lbl">${lbl}</span>
      <span class="val">${val}</span>
    </td>`).join('');
}

// ─── Documento Office HTML completo ─────────────────────────────────────────
function construirDocumentoHtml() {
  const hoy   = _hoyISO();
  const vence = _plus30();

  return `<html xmlns:v="urn:schemas-microsoft-com:vml"
              xmlns:o="urn:schemas-microsoft-com:office:office"
              xmlns:w="urn:schemas-microsoft-com:office:word"
              xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <meta name="ProgId" content="Word.Document"/>
  <meta name="Generator" content="Microsoft Word 15"/>
  <meta name="Originator" content="Microsoft Word 15"/>
  <title>Cotización Manual RA · ACR Networks &amp; Solutions</title>
  ${_msoSectionXml()}
  <style>${CSS}</style>
</head>
<body lang="es-DO">

<div class="section">

  <!-- ─── Banda corporate ─── -->
  <div class="band">&nbsp;</div>

  <!-- ─── Header empresa ─── -->
  <table class="header">
    <tr>
      <td class="brand">
        <div class="razon">${EMPRESA.razonSocial}</div>
        <div class="nombre-comercial">${EMPRESA.nombreComercial}</div>
        <div class="eslogan">${EMPRESA.eslogan}</div>
      </td>
      <td class="corp-meta">
        <div class="row"><span class="lbl">RNC</span><span class="val">${EMPRESA.rnc}</span></div>
        <div class="row"><span class="val val-direccion">${EMPRESA.direccion}</span></div>
        <div class="row"><span class="val val-direccion">Tel ${EMPRESA.telefono}</span></div>
        <div class="row"><span class="val val-direccion">${EMPRESA.email}</span></div>
        <div class="row"><span class="val" style="color:#1e40af;">${EMPRESA.website}</span></div>
      </td>
    </tr>
  </table>
  <div class="header-sep">&nbsp;</div>

  <!-- ─── Title bar ─── -->
  <table class="title-bar">
    <tr>
      <td class="doc-type">
        COTIZACIÓN
        <span class="sub">Plantilla Manual · Edición Offline</span>
      </td>
      <td class="doc-meta">
        <span class="num">COT-MANUAL-001</span>
        <div class="fechas">
          Emisión: <strong>${hoy}</strong>
          &nbsp;·&nbsp; Válida hasta: <strong>${vence}</strong>
        </div>
      </td>
    </tr>
  </table>

  <!-- ─── Body ─── -->
  <table class="body">
    <tr><td class="body-cell">

      <div class="section-label">CLIENTE</div>
      <table class="client-grid">
        <tr>
          <td class="client-cell" style="width:42%;">
            <span class="lbl">Razón Social</span>
            <span class="val">${_editable(180)}</span>
            <div class="val normal mono" style="margin-top:4pt; color:#475569;">${_editable(120)}</div>
          </td>
          <td class="client-cell" style="width:28%;">
            <span class="lbl">RNC / Contacto</span>
            <span class="val mono">${_editable(80)}</span>
            <div class="val normal mono" style="margin-top:4pt; color:#475569;">Tel ${_editable(80)}</div>
          </td>
          <td class="client-cell" style="width:30%;">
            <span class="lbl">Dirección</span>
            <span class="val normal">${_editable(120)}</span>
            <div class="val normal" style="margin-top:4pt; color:#475569;">${_editable(120)}</div>
          </td>
        </tr>
      </table>

      <div class="section-label" style="margin-top:16pt;">DETALLE DE PRODUCTOS Y SERVICIOS</div>
      <table class="items">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-cod">Código / Modelo</th>
            <th>Descripción Técnica</th>
            <th class="col-cant">Cant.</th>
            <th class="col-pu">Precio Unit.</th>
            <th class="col-itbis">ITBIS (18%)</th>
            <th class="col-amt">Importe</th>
          </tr>
        </thead>
        <tbody>
          ${_filasItems()}
        </tbody>
      </table>

      <table class="totals-wrap">
        <tr>
          <td class="legal-note">
            <span class="ttl">Condiciones Generales</span>
            Esta cotización tiene carácter informativo y no constituye documento fiscal.
            Los precios pueden estar sujetos a cambio sin previo aviso fuera del período
            de validez. Para emisión de factura formal se requiere confirmación por escrito.
          </td>
          <td class="totals-cell">
            <table class="totals">
              <tr>
                <td class="lbl">Subtotal</td>
                <td class="val">RD$ ${_editable(60)}</td>
              </tr>
              <tr>
                <td class="lbl">ITBIS (18%)</td>
                <td class="val">RD$ ${_editable(60)}</td>
              </tr>
              <tr class="grand">
                <td class="lbl">Total Neto</td>
                <td class="val">RD$ ${_editable(80)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <table class="cond-grid">
        <tr>${_condCells()}</tr>
      </table>

      <table class="sigs">
        <tr>
          <td class="sig-block">
            <div class="sig-line">&nbsp;</div>
            <div class="sig-name">Aceptación del Cliente</div>
            <div class="sig-role">Firma · Sello · Fecha</div>
          </td>
          <td class="sig-block">
            <div class="sig-line">&nbsp;</div>
            <div class="sig-name">${EMPRESA.razonSocial}</div>
            <div class="sig-role">Representante Autorizado · Firma · Sello</div>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>

  ${_msoHeaderFooter()}

</div>

<!-- ─── Anexo fotográfico (página nueva) ─── -->
<div class="page-break">&nbsp;</div>
<div class="section">
  <div class="band">&nbsp;</div>
  <table class="header">
    <tr>
      <td class="brand">
        <div class="razon" style="font-size:14pt;">${EMPRESA.razonSocial}</div>
        <div class="nombre-comercial">${EMPRESA.nombreComercial}</div>
      </td>
      <td class="corp-meta">
        <div class="row"><span class="lbl">RNC</span><span class="val">${EMPRESA.rnc}</span></div>
        <div class="row"><span class="val val-direccion">${EMPRESA.website}</span></div>
      </td>
    </tr>
  </table>
  <div class="header-sep">&nbsp;</div>

  <table class="body">
    <tr><td class="body-cell">

      <div class="anexo-title">ANEXO FOTOGRÁFICO</div>
      <div class="anexo-sub">Insertar fotografías del sitio · Levantamiento técnico previo a la instalación</div>

      <table class="anexo-grid">
        <tr>
          <td class="foto-slot">
            <span class="placeholder">[ FOTO 1 ]</span>
            <span class="help">Insertar imagen aquí</span>
            <span class="pie">Pie de foto / ubicación</span>
          </td>
          <td class="foto-slot">
            <span class="placeholder">[ FOTO 2 ]</span>
            <span class="help">Insertar imagen aquí</span>
            <span class="pie">Pie de foto / ubicación</span>
          </td>
        </tr>
        <tr>
          <td class="foto-slot">
            <span class="placeholder">[ FOTO 3 ]</span>
            <span class="help">Insertar imagen aquí</span>
            <span class="pie">Pie de foto / ubicación</span>
          </td>
          <td class="foto-slot">
            <span class="placeholder">[ FOTO 4 ]</span>
            <span class="help">Insertar imagen aquí</span>
            <span class="pie">Pie de foto / ubicación</span>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</div>

</body>
</html>`;
}

async function main() {
  const html = construirDocumentoHtml();
  const outPath = path.resolve(__dirname, '..', '..', '..', 'Plantilla_Cotizacion_Manual_RA.docx');
  // BOM UTF-8 + escribir como .docx (Word reconoce el Office HTML via ProgId)
  fs.writeFileSync(outPath, '﻿' + html, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[generarPlantillaWord] OK -> ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[generarPlantillaWord] ERROR:', err);
    process.exit(1);
  });
}

module.exports = { construirDocumentoHtml };
