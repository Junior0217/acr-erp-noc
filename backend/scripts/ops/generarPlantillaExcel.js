/**
 * backend/scripts/ops/generarPlantillaExcel.js
 *
 * Cotización en formato XLSX con ESPEJO VISUAL EXACTO del PDF oficial
 * generado por el pipeline de producción (`backend/services/pdf-templates.js`).
 *
 * Reglas de espejo (sin excepción):
 *   · MISMAS 6 columnas que la tabla del PDF: #, Código, Descripción,
 *     Cant., Precio Unit., Importe.
 *   · ITBIS NO va en columna por fila — solo en el bloque de totales
 *     (Subtotal · ITBIS 18% · Total Neto), idéntico al PDF.
 *   · MISMA paleta corporativa: slate-900/800/700/600/500/400/300/200/100/50
 *     + blue-800 acento.
 *   · MISMOS bloques del PDF en el MISMO orden:
 *       1. Banda corporate 3px slate-300
 *       2. Header: logo 70×70 + razón social/nombre comercial/eslogan +
 *          corp-meta derecho (RNC/Dir/Tel/Email/Web)
 *       3. Title-bar slate-100: COTIZACIÓN 16pt + chip número mono +
 *          línea inferior con emisión/vence
 *       4. Sección Cliente: 3 cajas (Razón Social / RNC + Tel / Dirección + Email)
 *       5. Tabla items: header slate-100 + cuerpo con datos demo + zebra slate-50
 *       6. Totales: Subtotal · ITBIS · Total Neto (Grand row slate-100)
 *       7. Condiciones generales: 4 cajas (Validez / Pago / Entrega / Garantía)
 *          con borde izquierdo blue-800
 *       8. Notas del proyecto: borde izquierdo slate-400
 *       9. Firmas duales con línea
 *       10. Footer print con paginación
 *   · FÓRMULAS VIVAS Excel:
 *       · Importe por fila      → =D{r}*E{r}
 *       · Subtotal              → =SUM(F{a}:F{b})
 *       · ITBIS                 → =Subtotal * 0.18
 *       · Total Neto            → =Subtotal + ITBIS
 *   · Logo PNG real (backend/assets/logo-acr.png) embebido — mismo del PDF.
 *   · Watermark "COTIZACIÓN" azul rotado -20deg (sharp SVG→PNG) flotando
 *     sobre la tabla.
 *   · Print titles: header de la tabla se repite en cada página impresa.
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.xlsx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaExcel.js
 */

const path = require('path');
const ExcelJS = require('exceljs');
const sharp   = require('sharp');

const {
  EMPRESA, CLIENTE, ITEMS, NUMERO,
  CONDICIONES, NOTAS,
  calcular, fechaEmision, fechaVence, fechaISO,
  logoBuffer,
} = require('./_demoCotizacion');

// ─── Paleta corporativa (ARGB exceljs) ──────────────────────────────────────
const COLOR = {
  slate900: 'FF0F172A',
  slate800: 'FF1E293B',
  slate700: 'FF334155',
  slate600: 'FF475569',
  slate500: 'FF64748B',
  slate400: 'FF94A3B8',
  slate300: 'FFCBD5E1',
  slate200: 'FFE2E8F0',
  slate100: 'FFF1F5F9',
  slate50:  'FFF8FAFC',
  blue800:  'FF1E40AF',
  white:    'FFFFFFFF',
};

const FONT      = 'Calibri';
const FONT_MONO = 'Consolas';

const BORDER_HAIR    = { style: 'hair',   color: { argb: COLOR.slate200 } };
const BORDER_THIN    = { style: 'thin',   color: { argb: COLOR.slate200 } };
const BORDER_MED     = { style: 'thin',   color: { argb: COLOR.slate300 } };
const BORDER_THICK   = { style: 'medium', color: { argb: COLOR.slate400 } };
const BORDER_BLUE_L  = { style: 'thick',  color: { argb: COLOR.blue800 } };
const BORDER_SLATE_L = { style: 'thick',  color: { argb: COLOR.slate400 } };

function fillBg(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function setBorder(cell, b) {
  cell.border = {
    top:    b.top    ?? BORDER_HAIR,
    bottom: b.bottom ?? BORDER_HAIR,
    left:   b.left   ?? BORDER_HAIR,
    right:  b.right  ?? BORDER_HAIR,
  };
}

async function _watermarkPng() {
  // Espejo exacto del .watermark.cotizacion del PDF:
  // color #1e40af, opacity 0.045-0.07, font-size 110px, rotate -20deg, caps,
  // letter-spacing 0.08em, font-weight 900.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="300" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 300">
  <g transform="rotate(-20 600 150)">
    <text x="600" y="195"
          text-anchor="middle"
          font-family="Helvetica, 'Helvetica Neue', Arial, sans-serif"
          font-size="170"
          font-weight="900"
          letter-spacing="14"
          fill="#1e40af"
          fill-opacity="0.06">COTIZACIÓN</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function construirLibro() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'ACR Networks & Solutions';
  wb.company  = 'ACR Networks & Solutions';
  wb.title    = `Cotización ${NUMERO}`;
  wb.subject  = 'Cotización editable · espejo exacto del PDF corporativo';
  wb.keywords = 'cotizacion, ACR, plantilla, offline, CCTV';
  wb.created  = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('Cotización', {
    properties: { tabColor: { argb: COLOR.blue800 }, defaultRowHeight: 15 },
    pageSetup: {
      paperSize: 1,                              // Letter
      orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.35, right: 0.35, top: 0.35, bottom: 0.5, header: 0.2, footer: 0.25 },
      horizontalCentered: true,
      printArea: undefined,                      // se define abajo
    },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 105 }],
  });

  // ─── Anchos de columna (proporciones PDF) ─────────────────────────────────
  // PDF: col-num 30px, col-cod 86px, descripción flex, col-cant 56px,
  // col-pu 90px, col-amt 100px. Total ancho body = 8.5" - 72px padding = 744px.
  ws.getColumn('A').width =  5;     // # (col-num 30px)
  ws.getColumn('B').width = 14;     // Código (col-cod 86px)
  ws.getColumn('C').width = 56;     // Descripción (flex)
  ws.getColumn('D').width =  8;     // Cant. (col-cant 56px)
  ws.getColumn('E').width = 15;     // Precio Unit. (col-pu 90px)
  ws.getColumn('F').width = 17;     // Importe (col-amt 100px)

  let row = 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BANDA CORPORATE — 3px slate-300, full width
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 4;
  ws.mergeCells(`A${row}:F${row}`);
  fillBg(ws.getCell(`A${row}`), COLOR.slate300);
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. HEADER — logo izq + brand-info + corp-meta derecho
  //    PDF: padding 12px 36px 10px. Logo 96×96. Brand: razón 14.5px / nombre
  //    10px caps blue / eslogan 9px italic. Corp-meta: RNC/Dir/Tel/Email/Web
  //    como label-value pairs.
  // ═══════════════════════════════════════════════════════════════════════════
  const headerStartRow = row;

  // Logo embebido en A2-A5
  const logoBuf = logoBuffer();
  if (logoBuf) {
    const imgId = wb.addImage({ buffer: logoBuf, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: 0.15, row: headerStartRow - 0.85 },
      ext: { width: 72, height: 72 },
      editAs: 'oneCell',
    });
  }

  // Row 2: razón social | RNC (rich text)
  ws.getRow(row).height = 22;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 14, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'RNC  ',     font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.rnc, font: { name: FONT_MONO, size: 11, bold: true, color: { argb: COLOR.slate900 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 3: nombre comercial | dirección
  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.nombreComercial;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.blue800 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = EMPRESA.direccion;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate700 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
  row += 1;

  // Row 4: eslogan | tel
  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.eslogan;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 8, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'Tel. ', font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.telefono, font: { name: FONT_MONO, size: 9, color: { argb: COLOR.slate700 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 5: (vacío izq) | email
  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = '';
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = `${EMPRESA.email}   ·   ${EMPRESA.website}`;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.blue800 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Separador hairline
  ws.getRow(row).height = 3;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).border = { bottom: BORDER_THIN };
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. TITLE-BAR — slate-100 bg, COTIZACIÓN 17pt izq + número chip der
  //    PDF: padding 9px 36px, slate-100 con border-top/bottom slate-200.
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 32;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'COTIZACIÓN';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 17, bold: true, color: { argb: COLOR.slate800 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate100);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  setBorder(ws.getCell(`A${row}`), { top: BORDER_THIN, bottom: BORDER_THIN, left: { style: 'none' }, right: { style: 'none' } });

  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = NUMERO;
  ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 16, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate100);
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  setBorder(ws.getCell(`D${row}`), { top: BORDER_THIN, bottom: BORDER_THIN, left: { style: 'none' }, right: { style: 'none' } });
  // Bandas slate-100 continuas
  for (const col of ['B', 'C', 'E']) {
    const c = ws.getCell(`${col}${row}`);
    fillBg(c, COLOR.slate100);
    setBorder(c, { top: BORDER_THIN, bottom: BORDER_THIN, left: { style: 'none' }, right: { style: 'none' } });
  }
  row += 1;

  // Sub-línea title-bar: estado izq + emisión/vence der
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = {
    richText: [
      { text: '◆ EMITIDA   ', font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.blue800 }, letterSpacing: 12 } },
      { text: '·   Documento Electrónico Verificable', font: { name: FONT, size: 8, color: { argb: COLOR.slate500 } } },
    ],
  };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = {
    richText: [
      { text: 'Emisión: ',    font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: fechaISO(fechaEmision()), font: { name: FONT_MONO, size: 9, bold: true, color: { argb: COLOR.slate900 } } },
      { text: '   ·   Válida hasta: ', font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: fechaISO(fechaVence()), font: { name: FONT_MONO, size: 9, bold: true, color: { argb: COLOR.slate900 } } },
    ],
  };
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  row += 1;

  // Spacer post title-bar
  ws.getRow(row).height = 12;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CLIENTE — section-label + 3 cajas grid (Razón / RNC+Tel / Dir+Email)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = {
    richText: [
      { text: 'CLIENTE  ', font: { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 }, letterSpacing: 40 } },
      { text: '─────────────────────────────────────────────────────────────────────────────────────────────', font: { name: FONT, size: 7, color: { argb: COLOR.slate200 } } },
    ],
  };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  row += 1;

  // Client-grid labels row
  ws.getRow(row).height = 14;
  const gridDef = [
    { start: 'A', end: 'C', lbl: 'RAZÓN SOCIAL' },
    { start: 'D', end: 'D', lbl: 'RNC' },
    { start: 'E', end: 'F', lbl: 'DIRECCIÓN' },
  ];
  for (const { start, end, lbl } of gridDef) {
    if (start !== end) ws.mergeCells(`${start}${row}:${end}${row}`);
    const c = ws.getCell(`${start}${row}`);
    c.value = lbl;
    c.font  = { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate500 } };
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    setBorder(c, { top: BORDER_THIN, bottom: { style: 'hair', color: { argb: COLOR.slate200 } }, left: BORDER_THIN, right: BORDER_THIN });
    for (let col = start.charCodeAt(0) + 1; col <= end.charCodeAt(0); col += 1) {
      const c2 = ws.getCell(`${String.fromCharCode(col)}${row}`);
      fillBg(c2, COLOR.slate50);
      setBorder(c2, { top: BORDER_THIN, bottom: { style: 'hair', color: { argb: COLOR.slate200 } }, left: BORDER_THIN, right: BORDER_THIN });
    }
  }
  row += 1;

  // Client-grid values row 1: razón / RNC / dirección
  ws.getRow(row).height = 22;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = CLIENTE.razonSocial;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 12, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.getCell(`D${row}`).value = CLIENTE.rnc;
  ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 11, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate50);
  ws.getCell(`D${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = CLIENTE.direccion;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 9.5, color: { argb: COLOR.slate800 } };
  fillBg(ws.getCell(`E${row}`), COLOR.slate50);
  ws.getCell(`E${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };

  for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) {
    setBorder(ws.getCell(`${col}${row}`), { top: { style: 'hair', color: { argb: COLOR.slate200 } }, bottom: { style: 'hair', color: { argb: COLOR.slate200 } }, left: BORDER_THIN, right: BORDER_THIN });
  }
  row += 1;

  // Client-grid sub row: cliente#/contacto | tel | email
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = `Cliente: ${CLIENTE.noCliente}  ·  ${CLIENTE.contacto}`;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.getCell(`D${row}`).value = {
    richText: [
      { text: 'Tel ', font: { name: FONT, size: 8, color: { argb: COLOR.slate400 } } },
      { text: CLIENTE.telefono, font: { name: FONT_MONO, size: 8.5, color: { argb: COLOR.slate600 } } },
    ],
  };
  fillBg(ws.getCell(`D${row}`), COLOR.slate50);
  ws.getCell(`D${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = CLIENTE.email;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.blue800 } };
  fillBg(ws.getCell(`E${row}`), COLOR.slate50);
  ws.getCell(`E${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) {
    setBorder(ws.getCell(`${col}${row}`), { top: { style: 'hair', color: { argb: COLOR.slate200 } }, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });
  }
  row += 1;

  // Spacer
  ws.getRow(row).height = 14;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. DETALLE — section-label + tabla 6 cols (mirror PDF exacto)
  //    PDF cols: # / Código / Descripción / Cant. / Precio Unit. / Importe
  //    (NO hay columna ITBIS por fila — solo en totales)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'DETALLE DE PRODUCTOS Y SERVICIOS';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Header tabla (thead PDF: slate-100 bg, 9px caps slate-700)
  const headers = [
    { txt: '#',                  align: 'center' },
    { txt: 'Código',             align: 'left'   },
    { txt: 'Descripción',        align: 'left'   },
    { txt: 'Cant.',              align: 'center' },
    { txt: 'Precio Unit.',       align: 'right'  },
    { txt: 'Importe',            align: 'right'  },
  ];
  ws.getRow(row).height = 26;
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h.txt;
    c.font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate700 } };
    fillBg(c, COLOR.slate100);
    c.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0 };
    c.border = {
      top:    { style: 'thin',   color: { argb: COLOR.slate300 } },
      bottom: { style: 'medium', color: { argb: COLOR.slate300 } },
      left:   { style: 'hair',   color: { argb: COLOR.slate200 } },
      right:  { style: 'hair',   color: { argb: COLOR.slate200 } },
    };
  });
  const headerRow = row;
  row += 1;

  // Items con datos demo + fórmulas vivas en Importe
  const firstItemRow = row;
  ITEMS.forEach((it, i) => {
    // Altura variable según si tiene detalle (2 líneas) o no
    const hasDetalle = !!it.detalle;
    ws.getRow(row).height = hasDetalle ? 36 : 24;

    // # (auto-numerado, mono slate-400)
    ws.getCell(`A${row}`).value = i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_MONO, size: 8.5, color: { argb: COLOR.slate400 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    // Código (mono bold slate-800)
    ws.getCell(`B${row}`).value = it.codigo;
    ws.getCell(`B${row}`).font  = { name: FONT_MONO, size: 9, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    // Descripción (rich text: título bold slate-900 + detalle slate-500)
    ws.getCell(`C${row}`).value = {
      richText: [
        { text: it.descripcion, font: { name: FONT, size: 10, bold: true, color: { argb: COLOR.slate900 } } },
        ...(hasDetalle ? [
          { text: '\n', font: { name: FONT, size: 8 } },
          { text: it.detalle, font: { name: FONT, size: 8.5, color: { argb: COLOR.slate500 } } },
        ] : []),
      ],
    };
    ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };

    // Cant. (mono center)
    ws.getCell(`D${row}`).value = it.cantidad;
    ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`D${row}`).numFmt = '#,##0';

    // Precio Unit. (mono right)
    ws.getCell(`E${row}`).value = it.precioUnitario;
    ws.getCell(`E${row}`).font  = { name: FONT_MONO, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`E${row}`).numFmt = '#,##0.00';

    // Importe (fórmula viva: =D*E)
    ws.getCell(`F${row}`).value = { formula: `D${row}*E${row}`, result: it.cantidad * it.precioUnitario };
    ws.getCell(`F${row}`).font  = { name: FONT_MONO, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';

    // Zebra + bordes hair
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const c = ws.getCell(`${col}${row}`);
      if (i % 2 === 1) fillBg(c, COLOR.slate50);
      setBorder(c, {
        top:    { style: 'hair', color: { argb: COLOR.slate200 } },
        bottom: { style: 'hair', color: { argb: COLOR.slate200 } },
        left:   { style: 'hair', color: { argb: COLOR.slate200 } },
        right:  { style: 'hair', color: { argb: COLOR.slate200 } },
      });
    }
    row += 1;
  });

  // 3 filas vacías para expansión (con fórmulas pre-cargadas)
  for (let i = 0; i < 3; i += 1) {
    ws.getRow(row).height = 22;
    ws.getCell(`A${row}`).value = ITEMS.length + i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_MONO, size: 8.5, color: { argb: COLOR.slate300 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    ws.getCell(`D${row}`).numFmt = '#,##0';
    ws.getCell(`E${row}`).numFmt = '#,##0.00';

    ws.getCell(`F${row}`).value = { formula: `IFERROR(D${row}*E${row},0)`, result: 0 };
    ws.getCell(`F${row}`).font  = { name: FONT_MONO, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';

    for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) {
      setBorder(ws.getCell(`${col}${row}`), {
        top:    { style: 'hair', color: { argb: COLOR.slate200 } },
        bottom: { style: 'hair', color: { argb: COLOR.slate200 } },
        left:   { style: 'hair', color: { argb: COLOR.slate200 } },
        right:  { style: 'hair', color: { argb: COLOR.slate200 } },
      });
    }
    row += 1;
  }
  const lastFormulaRow = row - 1;

  // ─── Watermark COTIZACIÓN flotante sobre la tabla ─────────────────────────
  const wmPng = await _watermarkPng();
  const wmId  = wb.addImage({ buffer: wmPng, extension: 'png' });
  ws.addImage(wmId, {
    tl: { col: 0.5, row: firstItemRow + 1 },
    ext: { width: 580, height: 145 },
    editAs: 'absolute',
  });

  // Spacer post tabla
  ws.getRow(row).height = 10;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. TOTALES — alineados a la derecha (D-E labels + F valor)
  //    PDF: width 280px, padding 7px 14px, grand row slate-100 + border-top
  //    2px slate-400. Subtotal/ITBIS/Total Neto.
  // ═══════════════════════════════════════════════════════════════════════════
  const { subtotal, itbis, total } = calcular(ITEMS);
  const subtotalRow = row;
  const itbisRow    = row + 1;
  const totalRow    = row + 2;
  const totalesDef = [
    { lbl: 'Subtotal',    formula: `SUM(F${firstItemRow}:F${lastFormulaRow})`, result: subtotal, grand: false },
    { lbl: 'ITBIS (18%)', formula: `F${subtotalRow}*0.18`,                      result: itbis,    grand: false },
    { lbl: 'Total Neto',  formula: `F${subtotalRow}+F${itbisRow}`,              result: total,    grand: true  },
  ];
  totalesDef.forEach((t, i) => {
    const r = row + i;
    ws.getRow(r).height = t.grand ? 30 : 22;

    // Label (D-E merged)
    ws.mergeCells(`D${r}:E${r}`);
    const lblCell = ws.getCell(`D${r}`);
    lblCell.value = t.lbl;
    lblCell.font  = {
      name: FONT, size: t.grand ? 11 : 9,
      bold: true,
      color: { argb: t.grand ? COLOR.slate700 : COLOR.slate600 },
    };
    lblCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    if (t.grand) fillBg(lblCell, COLOR.slate100);
    setBorder(lblCell, {
      top:    t.grand ? BORDER_THICK : BORDER_HAIR,
      bottom: BORDER_HAIR,
      left:   BORDER_HAIR,
      right:  BORDER_HAIR,
    });
    const eCell = ws.getCell(`E${r}`);
    if (t.grand) fillBg(eCell, COLOR.slate100);
    setBorder(eCell, lblCell.border);

    // Valor F (mono RD$)
    const valCell = ws.getCell(`F${r}`);
    valCell.value = { formula: t.formula, result: t.result };
    valCell.font  = {
      name: FONT_MONO, size: t.grand ? 14 : 10.5,
      bold: true, color: { argb: COLOR.slate900 },
    };
    valCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    valCell.numFmt = '"RD$" #,##0.00';
    if (t.grand) fillBg(valCell, COLOR.slate100);
    setBorder(valCell, {
      top:    t.grand ? BORDER_THICK : BORDER_HAIR,
      bottom: BORDER_HAIR,
      left:   BORDER_HAIR,
      right:  BORDER_HAIR,
    });
  });
  row = totalRow + 1;

  // Spacer
  ws.getRow(row).height = 14;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. CONDICIONES GENERALES — 4 cajas con borde izquierdo blue-800
  //    PDF: cond-grid 4 cols, slate-50 bg, border-left 3px blue-800, padding
  //    7px 10px, label 7.5px caps slate-500 + value 9.5px slate-900 bold.
  //    Mapeo en 6 cols: A-B / C / D-E / F (4 cajas).
  // ═══════════════════════════════════════════════════════════════════════════
  const condDef = [
    { lbl: 'VALIDEZ',         val: CONDICIONES.validez,  span: ['A', 'B'] },
    { lbl: 'FORMA DE PAGO',   val: CONDICIONES.pago,     span: ['C', 'C'] },
    { lbl: 'ENTREGA',         val: CONDICIONES.entrega,  span: ['D', 'E'] },
    { lbl: 'GARANTÍA',        val: CONDICIONES.garantia, span: ['F', 'F'] },
  ];
  ws.getRow(row).height = 34;
  condDef.forEach(({ lbl, val, span: [s, e] }) => {
    if (s !== e) ws.mergeCells(`${s}${row}:${e}${row}`);
    const c = ws.getCell(`${s}${row}`);
    c.value = {
      richText: [
        { text: lbl,  font: { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate500 } } },
        { text: '\n', font: { name: FONT, size: 5 } },
        { text: val,  font: { name: FONT, size: 9.5, bold: true, color: { argb: COLOR.slate900 } } },
      ],
    };
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
    setBorder(c, {
      top:    BORDER_THIN,
      bottom: BORDER_THIN,
      right:  BORDER_THIN,
      left:   BORDER_BLUE_L,
    });
    if (s !== e) {
      for (let col = s.charCodeAt(0) + 1; col <= e.charCodeAt(0); col += 1) {
        const c2 = ws.getCell(`${String.fromCharCode(col)}${row}`);
        fillBg(c2, COLOR.slate50);
        setBorder(c2, { top: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN, left: { style: 'none' } });
      }
    }
  });
  row += 1;

  // Spacer
  ws.getRow(row).height = 12;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. NOTAS DEL PROYECTO — borde izquierdo slate-400 (paridad .notes PDF)
  //    PDF: 10px 14px padding, slate-50 bg, border-left 3px slate-400.
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'NOTAS';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  setBorder(ws.getCell(`A${row}`), { top: BORDER_THIN, bottom: { style: 'none' }, left: BORDER_SLATE_L, right: BORDER_THIN });
  for (let c = 2; c <= 6; c += 1) {
    const cell = ws.getCell(row, c);
    fillBg(cell, COLOR.slate50);
    setBorder(cell, { top: BORDER_THIN, bottom: { style: 'none' }, left: { style: 'none' }, right: BORDER_THIN });
  }
  row += 1;

  ws.getRow(row).height = 56;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = NOTAS;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 9.5, color: { argb: COLOR.slate700 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 };
  setBorder(ws.getCell(`A${row}`), { top: { style: 'none' }, bottom: BORDER_THIN, left: BORDER_SLATE_L, right: BORDER_THIN });
  for (let c = 2; c <= 6; c += 1) {
    const cell = ws.getCell(row, c);
    fillBg(cell, COLOR.slate50);
    setBorder(cell, { top: { style: 'none' }, bottom: BORDER_THIN, left: { style: 'none' }, right: BORDER_THIN });
  }
  row += 1;

  // Spacer
  ws.getRow(row).height = 24;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. FIRMAS — 2 cols con línea + nombre caps + rol
  //    PDF: 2 cols con gap 80px, sig-line 1.2px slate-900, sig-name 10px bold
  //    caps slate-900, sig-role 8.5px slate-500.
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 44;
  ws.mergeCells(`A${row}:C${row}`);
  ws.mergeCells(`D${row}:F${row}`);
  setBorder(ws.getCell(`A${row}`), { top: { style: 'none' }, bottom: { style: 'thin', color: { argb: COLOR.slate900 } }, left: { style: 'none' }, right: { style: 'none' } });
  setBorder(ws.getCell(`D${row}`), { top: { style: 'none' }, bottom: { style: 'thin', color: { argb: COLOR.slate900 } }, left: { style: 'none' }, right: { style: 'none' } });
  row += 1;

  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'ACEPTACIÓN DEL CLIENTE';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = `${EMPRESA.representanteNombre} ${EMPRESA.representanteApellido}`.toUpperCase();
  ws.getCell(`D${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 13;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Firma · Sello · Fecha';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = `${EMPRESA.representanteCargo} · ${EMPRESA.razonSocial}`;
  ws.getCell(`D${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. FOOTER PRINT — paginación + razón social
  // ═══════════════════════════════════════════════════════════════════════════
  ws.headerFooter = {
    differentFirst: false,
    oddFooter:
      `&L&7&K475569${EMPRESA.razonSocial} · RNC ${EMPRESA.rnc}` +
      `&C&7&K94A3B8Documento Electrónico Verificable · ${EMPRESA.website}` +
      `&R&7&K94A3B8Página &P de &N`,
  };

  // Print titles: repite header tabla en cada página impresa
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;

  // Print area: hasta la última fila usada
  ws.pageSetup.printArea = `A1:F${row}`;

  return wb;
}

async function main() {
  const wb = await construirLibro();
  const outPath = path.resolve(__dirname, '..', '..', '..', 'Plantilla_Cotizacion_Manual_RA.xlsx');
  await wb.xlsx.writeFile(outPath);
  // eslint-disable-next-line no-console
  console.log(`[generarPlantillaExcel] OK -> ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[generarPlantillaExcel] ERROR:', err);
    process.exit(1);
  });
}

module.exports = { construirLibro };
