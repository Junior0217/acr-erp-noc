/**
 * backend/scripts/ops/generarPlantillaExcel.js
 *
 * Cotización XLSX espejo 1:1 del PDF oficial (COT-914502 / Escuela Benito
 * Juárez). 100% editable, fórmulas vivas en Importe / Subtotal / ITBIS /
 * Total Neto. Replica visual del PDF de ACR — paleta, fuentes, tamaños,
 * bordes, watermarks, anexo fotográfico — con paginación corporativa.
 *
 * Issues corregidos (vs ciclo anterior):
 *   ① Logo solapado: brand text arranca en col C (cols A+B = espacio logo).
 *   ② Descripciones no editables: plain text con \n (no rich-text rígido).
 *   ③ Header sin paginar: texto company en headerFooter.oddHeader → aparece
 *     en cada página impresa idéntico al membrete del PDF.
 *   ④ Sin anexo fotográfico: 12 slots en 3 páginas (2×2 cada) con
 *     page-breaks idéntico al ANEXO TÉCNICO del PDF.
 *
 * Layout de columnas (proporciones PDF):
 *   A:  5 chars  → # (logo se solapa visualmente sobre A+B en header)
 *   B: 18 chars  → Código
 *   C: 50 chars  → Descripción / brand text en header
 *   D:  8 chars  → Cant.
 *   E: 14 chars  → Precio Unit. / corp-meta en header
 *   F: 16 chars  → Importe
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.xlsx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaExcel.js
 */

const path = require('path');
const ExcelJS = require('exceljs');
const sharp   = require('sharp');

const {
  EMPRESA, CLIENTE, ITEMS, NUMERO, ESTADO,
  CONDICIONES,
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
  amber600: 'FFD97706',
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
const BORDER_DASHED  = { style: 'dashed', color: { argb: COLOR.slate300 } };

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

// ─── Watermarks (COTIZACIÓN + BORRADOR — paridad PDF) ───────────────────────
async function _watermarkCotizacionPng() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="280" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 280">
  <g transform="rotate(-20 600 140)">
    <text x="600" y="195"
          text-anchor="middle"
          font-family="Helvetica, 'Helvetica Neue', Arial, sans-serif"
          font-size="170" font-weight="900" letter-spacing="14"
          fill="#1e40af" fill-opacity="0.07">COTIZACIÓN</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function _watermarkBorradorPng() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="280" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 280">
  <g transform="rotate(-20 600 140)">
    <text x="600" y="195"
          text-anchor="middle"
          font-family="Helvetica, 'Helvetica Neue', Arial, sans-serif"
          font-size="140" font-weight="900" letter-spacing="20"
          fill="#d97706" fill-opacity="0.10">BORRADOR</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ─── Combina descripción + detalle en plain text editable (con \n) ──────────
function _descripcionPlain(it) {
  if (it.detalle) return `${it.descripcion}\n${it.detalle}`;
  return it.descripcion;
}

async function construirLibro() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = EMPRESA.razonSocial;
  wb.company  = EMPRESA.razonSocial;
  wb.title    = `Cotización ${NUMERO}`;
  wb.subject  = `Cotización ${NUMERO} · ${CLIENTE.razonSocial}`;
  wb.keywords = 'cotizacion, ACR, escuela, CCTV, plantilla, editable';
  wb.created  = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('Cotización', {
    properties: { tabColor: { argb: COLOR.blue800 }, defaultRowHeight: 15 },
    pageSetup: {
      paperSize: 1,                              // Letter
      orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      // Top margin = 0.9" deja espacio para el header de impresión (logo + empresa)
      margins: { left: 0.35, right: 0.35, top: 0.9, bottom: 0.7, header: 0.3, footer: 0.35 },
      horizontalCentered: true,
    },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 105 }],
  });

  // ─── Anchos de columna ────────────────────────────────────────────────────
  // A=5 angosta (#) — sirve también como "primera mitad del área del logo"
  // B=18 (Código) — sirve como segunda mitad del área del logo en header
  // Brand text vive en C+D (no B) para EVITAR solapamiento con el logo (100px wide)
  ws.getColumn('A').width =  5;
  ws.getColumn('B').width = 18;
  ws.getColumn('C').width = 50;
  ws.getColumn('D').width =  8;
  ws.getColumn('E').width = 14;
  ws.getColumn('F').width = 16;

  let row = 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BANDA CORPORATE (slate-300 3pt)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 4;
  ws.mergeCells(`A${row}:F${row}`);
  fillBg(ws.getCell(`A${row}`), COLOR.slate300);
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. HEADER EN HOJA (página 1)
  //    Logo en A-B (100×56 sin distorsión) | Brand C-D | Corp-meta E-F
  // ═══════════════════════════════════════════════════════════════════════════
  const headerStartRow = row;

  // Logo: 100×56 (aspecto nativo 1.79:1). Ancla en A2 con pequeño offset
  // vertical. Espacia A+B (5+18=23 chars ≈ 162px) → 100px logo cabe entero
  // sin solaparse con la columna C donde arranca el brand.
  const logoBuf = logoBuffer();
  if (logoBuf) {
    const imgId = wb.addImage({ buffer: logoBuf, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: 0.2, row: headerStartRow - 1 + 0.2 },
      ext: { width: 100, height: 56 },
      editAs: 'oneCell',
    });
  }

  // Row 2: razón social (C-D) | RNC rich (E-F)
  ws.getRow(row).height = 22;
  ws.mergeCells(`C${row}:D${row}`);
  ws.getCell(`C${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`C${row}`).font  = { name: FONT, size: 14, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'RNC  ',     font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.rnc, font: { name: FONT_MONO, size: 11, bold: true, color: { argb: COLOR.slate900 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 3: nombre comercial (C-D) | TEL (E-F)
  ws.getRow(row).height = 14;
  ws.mergeCells(`C${row}:D${row}`);
  ws.getCell(`C${row}`).value = EMPRESA.nombreComercial;
  ws.getCell(`C${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.blue800 } };
  ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'TEL  ',                                                  font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: `${EMPRESA.telefono} / ${EMPRESA.telefono2}`,             font: { name: FONT_MONO, size: 9, color: { argb: COLOR.slate700 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 4: eslogan (C-D italic) | EMAIL (E-F)
  ws.getRow(row).height = 14;
  ws.mergeCells(`C${row}:D${row}`);
  ws.getCell(`C${row}`).value = EMPRESA.eslogan;
  ws.getCell(`C${row}`).font  = { name: FONT, size: 8, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'EMAIL  ',     font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.email, font: { name: FONT, size: 9, color: { argb: COLOR.slate700 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 5: (vacío C-D) | WEB (E-F)
  ws.getRow(row).height = 14;
  ws.mergeCells(`C${row}:D${row}`);
  ws.getCell(`C${row}`).value = '';
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'WEB  ',         font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.website, font: { name: FONT, size: 9, color: { argb: COLOR.blue800 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Separador hairline
  ws.getRow(row).height = 3;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).border = { bottom: BORDER_THIN };
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. TITLE-BAR
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 34;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'COTIZACIÓN';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 18, bold: true, color: { argb: COLOR.slate800 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate100);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  setBorder(ws.getCell(`A${row}`), { top: BORDER_THIN, bottom: BORDER_THIN, left: { style: 'none' }, right: { style: 'none' } });

  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = NUMERO;
  ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 17, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate100);
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  setBorder(ws.getCell(`D${row}`), { top: BORDER_THIN, bottom: BORDER_THIN, left: { style: 'none' }, right: { style: 'none' } });
  for (const col of ['B', 'C', 'E']) {
    const c = ws.getCell(`${col}${row}`);
    fillBg(c, COLOR.slate100);
    setBorder(c, { top: BORDER_THIN, bottom: BORDER_THIN, left: { style: 'none' }, right: { style: 'none' } });
  }
  row += 1;

  // Sub-línea title-bar: vacío izq + emisión/vence der
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = '';
  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = {
    richText: [
      { text: 'Emisión: ',                font: { name: FONT, size: 9, color: { argb: COLOR.slate500 } } },
      { text: fechaISO(fechaEmision()), font: { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } } },
      { text: '  ·  Válida hasta: ',     font: { name: FONT, size: 9, color: { argb: COLOR.slate500 } } },
      { text: fechaISO(fechaVence()),   font: { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } } },
    ],
  };
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  row += 1;

  // Estado-stamp (Borrador chip slate-50)
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:E${row}`);
  ws.getCell(`A${row}`).value = '';
  ws.getCell(`F${row}`).value = ESTADO;
  ws.getCell(`F${row}`).font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`F${row}`), COLOR.slate50);
  ws.getCell(`F${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  setBorder(ws.getCell(`F${row}`), { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });
  row += 1;

  // Spacer
  ws.getRow(row).height = 10;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CLIENTE
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'C L I E N T E';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Labels row
  ws.getRow(row).height = 14;
  const gridDef = [
    { start: 'A', end: 'C', lbl: 'RAZÓN SOCIAL' },
    { start: 'D', end: 'D', lbl: 'CONTACTO' },
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

  // Values row (editable plain text)
  ws.getRow(row).height = 24;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = CLIENTE.razonSocial;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 12, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.getCell(`D${row}`).value = CLIENTE.contacto || '—';
  ws.getCell(`D${row}`).font  = { name: FONT, size: 11, color: { argb: COLOR.slate500 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate50);
  ws.getCell(`D${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = CLIENTE.direccion || '—';
  ws.getCell(`E${row}`).font  = { name: FONT, size: 11, color: { argb: COLOR.slate500 } };
  fillBg(ws.getCell(`E${row}`), COLOR.slate50);
  ws.getCell(`E${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };

  for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) {
    setBorder(ws.getCell(`${col}${row}`), { top: { style: 'hair', color: { argb: COLOR.slate200 } }, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });
  }
  row += 1;

  // Spacer
  ws.getRow(row).height = 14;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. DETALLE — tabla 6 cols
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'D E T A L L E   D E   P R O D U C T O S   Y   S E R V I C I O S';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Header tabla
  const headers = [
    { txt: '#',                  align: 'center' },
    { txt: 'CÓDIGO',             align: 'left'   },
    { txt: 'DESCRIPCIÓN',        align: 'left'   },
    { txt: 'CANT.',              align: 'center' },
    { txt: 'PRECIO\nUNIT.',      align: 'right'  },
    { txt: 'IMPORTE',            align: 'right'  },
  ];
  ws.getRow(row).height = 28;
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h.txt;
    c.font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate700 } };
    fillBg(c, COLOR.slate100);
    c.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0, wrapText: true };
    c.border = {
      top:    { style: 'thin',   color: { argb: COLOR.slate300 } },
      bottom: { style: 'medium', color: { argb: COLOR.slate300 } },
      left:   { style: 'hair',   color: { argb: COLOR.slate200 } },
      right:  { style: 'hair',   color: { argb: COLOR.slate200 } },
    };
  });
  const headerRow = row;
  row += 1;

  // Items — TODO en plain text (sin rich text) para que sea 100% editable
  const firstItemRow = row;
  ITEMS.forEach((it, i) => {
    const hasDetalle = !!it.detalle;
    // Altura calculada según líneas de descripción (1 sola línea = 24pt,
    // 2 líneas con detalle = 38pt). Si el código es largo (>18 chars) se
    // ajusta a 2 líneas vía wrapText.
    const codeLong = it.codigo.length > 18;
    ws.getRow(row).height = hasDetalle ? 42 : (codeLong ? 32 : 26);

    // # (auto-numerado, mono slate-400 — editable)
    ws.getCell(`A${row}`).value = i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate400 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    // Código (mono bold slate-800, wrap por si es largo — plain text editable)
    ws.getCell(`B${row}`).value = it.codigo;
    ws.getCell(`B${row}`).font  = { name: FONT_MONO, size: 9, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };

    // Descripción — PLAIN TEXT con \n (100% editable, no rich-text rígido)
    ws.getCell(`C${row}`).value = _descripcionPlain(it);
    ws.getCell(`C${row}`).font  = { name: FONT, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };

    // Cant. (number editable)
    ws.getCell(`D${row}`).value = it.cantidad;
    ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`D${row}`).numFmt = '#,##0';

    // Precio Unit. (number editable — empieza en 0 borrador)
    ws.getCell(`E${row}`).value = it.precioUnitario;
    ws.getCell(`E${row}`).font  = { name: FONT_MONO, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`E${row}`).numFmt = '#,##0.00';

    // Importe (fórmula viva =D*E)
    ws.getCell(`F${row}`).value = { formula: `D${row}*E${row}`, result: it.cantidad * it.precioUnitario };
    ws.getCell(`F${row}`).font  = { name: FONT_MONO, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';

    // Zebra + bordes
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

  // 3 filas vacías editables con fórmula pre-cargada
  for (let i = 0; i < 3; i += 1) {
    ws.getRow(row).height = 22;
    ws.getCell(`A${row}`).value = ITEMS.length + i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate300 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    ws.getCell(`B${row}`).font  = { name: FONT_MONO, size: 9, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };

    ws.getCell(`C${row}`).font  = { name: FONT, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };

    ws.getCell(`D${row}`).numFmt = '#,##0';
    ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };

    ws.getCell(`E${row}`).numFmt = '#,##0.00';
    ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };

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

  // Watermarks COTIZACIÓN + BORRADOR
  const wmCotPng = await _watermarkCotizacionPng();
  const wmBorPng = await _watermarkBorradorPng();
  const wmCotId  = wb.addImage({ buffer: wmCotPng, extension: 'png' });
  const wmBorId  = wb.addImage({ buffer: wmBorPng, extension: 'png' });
  ws.addImage(wmCotId, {
    tl: { col: 0.4, row: firstItemRow + 1 },
    ext: { width: 600, height: 140 },
    editAs: 'absolute',
  });
  ws.addImage(wmBorId, {
    tl: { col: 0.5, row: firstItemRow + Math.floor(ITEMS.length / 2) },
    ext: { width: 580, height: 130 },
    editAs: 'absolute',
  });

  // Spacer post tabla
  ws.getRow(row).height = 12;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. TOTALES (D-E labels + F valor mono)
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
  // 7. CONDICIONES (legal-note arriba + 3 cajas)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'CONDICIONES GENERALES';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  setBorder(ws.getCell(`A${row}`), { top: BORDER_THIN, bottom: { style: 'none' }, left: BORDER_THIN, right: BORDER_THIN });
  row += 1;

  ws.getRow(row).height = 36;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = (
    'Esta cotización tiene carácter informativo y no constituye documento fiscal. ' +
    'Los precios pueden estar sujetos a cambio sin previo aviso fuera del período ' +
    'de validez. Para emisión de factura formal se requiere confirmación por escrito.'
  );
  ws.getCell(`A${row}`).font  = { name: FONT, size: 9, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 };
  setBorder(ws.getCell(`A${row}`), { top: { style: 'none' }, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });
  row += 1;

  // Spacer
  ws.getRow(row).height = 8;
  row += 1;

  // 3 cajas (Validez / Entrega / Garantía)
  const condDef = [
    { lbl: 'VALIDEZ',  val: CONDICIONES.validez,  span: ['A', 'B'] },
    { lbl: 'ENTREGA',  val: CONDICIONES.entrega,  span: ['C', 'D'] },
    { lbl: 'GARANTÍA', val: CONDICIONES.garantia, span: ['E', 'F'] },
  ];
  ws.getRow(row).height = 44;
  condDef.forEach(({ lbl, val, span: [s, e] }) => {
    if (s !== e) ws.mergeCells(`${s}${row}:${e}${row}`);
    const c = ws.getCell(`${s}${row}`);
    c.value = {
      richText: [
        { text: lbl,  font: { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate500 } } },
        { text: '\n', font: { name: FONT, size: 4 } },
        { text: val,  font: { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } } },
      ],
    };
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 };
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

  ws.getRow(row).height = 28;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. FIRMAS
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
  ws.getCell(`D${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`D${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 13;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Firma · Sello · Fecha';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`D${row}:F${row}`);
  ws.getCell(`D${row}`).value = `Representante · ${EMPRESA.razonSocial}`;
  ws.getCell(`D${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. ANEXO TÉCNICO — 12 items en 3 páginas (4 fotos por página, 2×2)
  //    Page-break antes de cada anexo. Mismo membrete/footer corporativo
  //    aparece en cada página vía printHeader/Footer.
  // ═══════════════════════════════════════════════════════════════════════════
  const ITEMS_PER_ANNEX_PAGE = 4;
  const totalAnnexPages = Math.ceil(ITEMS.length / ITEMS_PER_ANNEX_PAGE);

  for (let pageIdx = 0; pageIdx < totalAnnexPages; pageIdx += 1) {
    // Page break antes del primer anexo (siempre nuevo print page)
    ws.getRow(row).addPageBreak();

    // Spacer
    ws.getRow(row).height = 8;
    row += 1;

    // Section-label "ANEXO TÉCNICO" (solo en página 1 del anexo) o sub-label
    if (pageIdx === 0) {
      ws.getRow(row).height = 18;
      ws.mergeCells(`A${row}:F${row}`);
      ws.getCell(`A${row}`).value = 'ANEXO TÉCNICO';
      ws.getCell(`A${row}`).font  = { name: FONT, size: 12, bold: true, color: { argb: COLOR.slate900 } };
      ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      ws.getCell(`A${row}`).border = { bottom: { style: 'thin', color: { argb: COLOR.slate200 } } };
      row += 1;

      ws.getRow(row).height = 14;
      ws.mergeCells(`A${row}:F${row}`);
      ws.getCell(`A${row}`).value = {
        richText: [
          { text: 'LEVANTAMIENTO FOTOGRÁFICO', font: { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 } } },
          { text: `   ·   ${NUMERO}   ·   ${ITEMS.length} imágenes   ·   ${fechaISO(fechaEmision())}`, font: { name: FONT, size: 8, color: { argb: COLOR.slate500 } } },
        ],
      };
      ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      row += 1;

      ws.getRow(row).height = 12;
      ws.mergeCells(`A${row}:F${row}`);
      ws.getCell(`A${row}`).value = 'CAPTURAS DE CAMPO';
      ws.getCell(`A${row}`).font  = { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate500 } };
      ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
      row += 1;
    } else {
      ws.getRow(row).height = 18;
      ws.mergeCells(`A${row}:F${row}`);
      ws.getCell(`A${row}`).value = `ANEXO TÉCNICO · Página ${pageIdx + 1} de ${totalAnnexPages}`;
      ws.getCell(`A${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate600 } };
      ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
      row += 1;
    }

    // Spacer
    ws.getRow(row).height = 6;
    row += 1;

    // 2 filas × 2 fotos = 4 slots por página
    const startItemIdx = pageIdx * ITEMS_PER_ANNEX_PAGE;
    const endItemIdx   = Math.min(startItemIdx + ITEMS_PER_ANNEX_PAGE, ITEMS.length);
    const itemsInPage  = ITEMS.slice(startItemIdx, endItemIdx);

    // Procesar de a 2 (fila izquierda + fila derecha)
    for (let r2 = 0; r2 < itemsInPage.length; r2 += 2) {
      const leftItem  = itemsInPage[r2];
      const rightItem = itemsInPage[r2 + 1];

      // Caja de foto (vacía, dashed border) — alto 100pt simula la imagen del PDF
      ws.getRow(row).height = 100;
      ws.mergeCells(`A${row}:C${row}`);
      const leftPhoto = ws.getCell(`A${row}`);
      leftPhoto.value = `[ FOTO ]\n${leftItem.codigo}`;
      leftPhoto.font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate400 } };
      fillBg(leftPhoto, COLOR.slate50);
      leftPhoto.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      setBorder(leftPhoto, { top: BORDER_DASHED, bottom: BORDER_DASHED, left: BORDER_DASHED, right: BORDER_DASHED });

      if (rightItem) {
        ws.mergeCells(`D${row}:F${row}`);
        const rightPhoto = ws.getCell(`D${row}`);
        rightPhoto.value = `[ FOTO ]\n${rightItem.codigo}`;
        rightPhoto.font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate400 } };
        fillBg(rightPhoto, COLOR.slate50);
        rightPhoto.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        setBorder(rightPhoto, { top: BORDER_DASHED, bottom: BORDER_DASHED, left: BORDER_DASHED, right: BORDER_DASHED });
      }
      row += 1;

      // Caja de descripción (item + descripción + LUGAR)
      ws.getRow(row).height = 50;
      ws.mergeCells(`A${row}:C${row}`);
      const leftDesc = ws.getCell(`A${row}`);
      const leftItemNum = startItemIdx + r2 + 1;
      leftDesc.value = `ÍTEM ${leftItemNum}.1 · ${leftItem.codigo}\n${leftItem.descripcion}${leftItem.detalle ? '\n' + leftItem.detalle : ''}\nLUGAR: (especificar ubicación de instalación)`;
      leftDesc.font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate700 } };
      leftDesc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 };
      setBorder(leftDesc, { top: { style: 'none' }, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });

      if (rightItem) {
        ws.mergeCells(`D${row}:F${row}`);
        const rightDesc = ws.getCell(`D${row}`);
        const rightItemNum = startItemIdx + r2 + 2;
        rightDesc.value = `ÍTEM ${rightItemNum}.1 · ${rightItem.codigo}\n${rightItem.descripcion}${rightItem.detalle ? '\n' + rightItem.detalle : ''}\nLUGAR: (especificar ubicación de instalación)`;
        rightDesc.font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate700 } };
        rightDesc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 };
        setBorder(rightDesc, { top: { style: 'none' }, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });
      }
      row += 1;

      // Spacer entre filas de fotos
      ws.getRow(row).height = 10;
      row += 1;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. PRINT HEADER & FOOTER (replica del membrete PDF en cada página)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.headerFooter = {
    differentFirst: false,
    differentOddEven: false,
    // Header: razón social + RNC (izq) | nombre comercial + eslogan (centro) | TEL + EMAIL (der)
    // Formato: &L=izquierda, &C=centro, &R=derecha. &K=color hex. &B=bold, &I=italic.
    // &11=font size 11pt.
    oddHeader:
      `&L&"Calibri,Bold"&11&K0F172A${EMPRESA.razonSocial}&"Calibri,Regular"&8&K475569\n` +
      `RNC ${EMPRESA.rnc}` +
      `&C&"Calibri,Bold"&9&K1E40AF${EMPRESA.nombreComercial}&"Calibri,Italic"&7&K64748B\n` +
      `${EMPRESA.eslogan}` +
      `&R&"Calibri,Bold"&8&K94A3B8TEL  &"Calibri,Regular"&K475569${EMPRESA.telefono}\n` +
      `&"Calibri,Bold"&K94A3B8EMAIL  &"Calibri,Regular"&K475569${EMPRESA.email}`,

    // Footer: razón social + RNC (izq) | documento verificable (centro) | página (der)
    oddFooter:
      `&L&7&K475569${EMPRESA.razonSocial} · RNC ${EMPRESA.rnc}` +
      `&C&7&K94A3B8Documento Electrónico Verificable · ${EMPRESA.website}` +
      `&R&7&K94A3B8Página &P de &N`,
  };

  // Print titles: header de la tabla se repite en cada página impresa
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
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
