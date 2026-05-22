/**
 * backend/scripts/ops/generarPlantillaExcel.js
 *
 * Plantilla XLSX editable con PARIDAD VISUAL 1:1 al template PDF oficial
 * (`backend/services/pdf-templates.js`). Mantiene fórmulas vivas Excel —
 * el técnico altera Cant/Precio y la hoja recalcula Importe/Subtotal/
 * ITBIS/Total Neto sin tocar fórmulas.
 *
 * Espejo del PDF:
 *   · banda corporate (slate-300, 3px)
 *   · header empresa: razón social (14.5px bold), nombre comercial (10px
 *     blue-800 caps), eslogan (9px italic slate-500) — corp-meta derecho
 *     con RNC/Dirección/Teléfono/Email
 *   · title-bar slate-100 + COTIZACIÓN (17px slate-900 bold caps) + número
 *     box (19px black-900 caps en chip slate-200) + emisión/vence
 *   · client-grid 3 col (Razón Social / RNC-Contacto / Dirección) con
 *     fondo slate-50, bordes slate-200
 *   · marca de agua "Cotización" rotada -20deg, azul #1e40af opacidad
 *     0.045 — renderizada via sharp SVG→PNG e insertada como imagen
 *     fija sobre el área de items
 *   · tabla items: header slate-100 (9px caps slate-700) + filas 10px
 *     slate-900, zebra slate-50, bordes hair slate-200
 *   · totales: subtotal/ITBIS (10px caps slate-600 + valor mono
 *     slate-900) + grand row slate-100 con borde superior medium slate-400
 *     (14px bold caps)
 *   · condiciones generales + firmas dual + footer print con paginación
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.xlsx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaExcel.js
 */

const path = require('path');
const ExcelJS = require('exceljs');
const sharp   = require('sharp');

// ─── Paleta corporativa (ARGB exceljs: alpha + RGB hex) ─────────────────────
const COLOR = {
  slate900: 'FF0F172A',  // corp dark
  slate800: 'FF1E293B',
  slate700: 'FF334155',
  slate600: 'FF475569',
  slate500: 'FF64748B',
  slate400: 'FF94A3B8',
  slate300: 'FFCBD5E1',
  slate200: 'FFE2E8F0',
  slate100: 'FFF1F5F9',  // title-bar bg / table header
  slate50:  'FFF8FAFC',  // zebra
  blue800:  'FF1E40AF',  // accent
  white:    'FFFFFFFF',
};

// Fuentes PDF reales (px). Excel mide en pt → 1px ≈ 0.75pt. Mapeo:
//   PDF 10px  → 8pt  (body items)
//   PDF 14.5px→ 12pt (razón social)
//   PDF 17px  → 14pt (doc-type)
//   PDF 19px  → 16pt (número doc)
//   PDF 14px  → 11pt (grand total val)
//   PDF 9px   → 7.5pt (header tabla)
//   PDF 8.5px → 7pt  (labels)
const FONT_FAMILY = 'Calibri';
const FONT_MONO   = 'Consolas';

// ─── Datos defaults (alineados al cotizador-libre + EmpresaPerfil) ──────────
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

const ITEMS_INICIALES = 15;
const ITBIS_RATE      = 0.18;

function _hoyISO() { return new Date().toISOString().slice(0, 10); }
function _plus30() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

const BORDER_HAIR  = { style: 'hair',   color: { argb: COLOR.slate200 } };
const BORDER_THIN  = { style: 'thin',   color: { argb: COLOR.slate200 } };
const BORDER_MED   = { style: 'thin',   color: { argb: COLOR.slate300 } };
const BORDER_THICK = { style: 'medium', color: { argb: COLOR.slate400 } };

function fillBorder(cell, borders) {
  cell.border = {
    top:    borders?.top    ?? BORDER_HAIR,
    bottom: borders?.bottom ?? BORDER_HAIR,
    left:   borders?.left   ?? BORDER_HAIR,
    right:  borders?.right  ?? BORDER_HAIR,
  };
}

function fillBg(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// ─── Watermark "Cotización" como PNG (paridad PDF) ──────────────────────────
async function _generarWatermarkPng() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1100" height="280" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 280">
  <g transform="rotate(-20 550 140)">
    <text x="550" y="180"
          text-anchor="middle"
          font-family="Helvetica, 'Helvetica Neue', Arial, sans-serif"
          font-size="160"
          font-weight="900"
          letter-spacing="13"
          fill="#1e40af"
          fill-opacity="0.07"
          style="text-transform: uppercase;">COTIZACIÓN</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function construirLibro() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'ACR Networks & Solutions';
  wb.company  = 'ACR Networks & Solutions';
  wb.title    = 'Cotización Manual RA';
  wb.subject  = 'Plantilla editable offline · paridad PDF 1:1';
  wb.keywords = 'cotizacion, manual, RA, offline, ACR, plantilla';
  wb.created  = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('Cotización RA', {
    properties: {
      tabColor: { argb: COLOR.blue800 },
      defaultRowHeight: 15,
    },
    pageSetup:  {
      paperSize: 1,                  // Letter
      orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.35, bottom: 0.45, header: 0.2, footer: 0.25 },
      printArea: 'A1:G55',
      horizontalCentered: true,
    },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 110 }],
    pageMargins: { left: 0.4, right: 0.4, top: 0.35, bottom: 0.45 },
  });

  // Anchos col en proporción PDF (col-num=30px, col-cod=86px, desc fluid,
  // col-cant=56px, col-pu=90px, col-amt=100px). + col F para ITBIS.
  ws.getColumn('A').width =  5;    // #
  ws.getColumn('B').width = 16;    // Código / Modelo
  ws.getColumn('C').width = 44;    // Descripción Técnica
  ws.getColumn('D').width =  9;    // Cantidad
  ws.getColumn('E').width = 15;    // Precio Unitario
  ws.getColumn('F').width = 13;    // ITBIS (18%)
  ws.getColumn('G').width = 16;    // Importe

  let row = 1;

  // ─── Banda corporate (slate-300, 3px ≈ row height 4) ──────────────────────
  ws.getRow(row).height = 4;
  ws.mergeCells(`A${row}:G${row}`);
  fillBg(ws.getCell(`A${row}`), COLOR.slate300);
  row += 1;

  // ─── Header (rows 2-4) ────────────────────────────────────────────────────
  // Row 2: razón social (12pt bold slate-900) | RNC der (10pt bold slate-900)
  ws.getRow(row).height = 26;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 14, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = [
    { text: 'RNC ', font: { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate400 }, bold: true } },
    { text: EMPRESA.rnc, font: { name: FONT_FAMILY, size: 9.5, color: { argb: COLOR.slate900 }, bold: true } },
  ];
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 3: nombre comercial (10px blue-800 caps) | Dirección (val-direccion)
  ws.getRow(row).height = 15;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = EMPRESA.nombreComercial;
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 8.5, bold: true, color: { argb: COLOR.blue800 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = EMPRESA.direccion;
  ws.getCell(`D${row}`).font  = { name: FONT_FAMILY, size: 8.5, color: { argb: COLOR.slate700 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 4: eslogan (8pt italic slate-500) | tel + email (8pt slate-500)
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = EMPRESA.eslogan;
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = `Tel ${EMPRESA.telefono}  ·  ${EMPRESA.email}  ·  ${EMPRESA.website}`;
  ws.getCell(`D${row}`).font  = { name: FONT_FAMILY, size: 7.5, color: { argb: COLOR.slate500 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // ─── Separador hairline (border-bottom del header PDF) ────────────────────
  ws.getRow(row).height = 3;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).border = { bottom: BORDER_THIN };
  row += 1;

  // ─── Title-bar (slate-100, COTIZACIÓN izq + número/fechas der) ────────────
  ws.getRow(row).height = 30;
  // Izq: doc-type
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'COTIZACIÓN';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 14, bold: true, color: { argb: COLOR.slate800 } };
  ws.getCell(`A${row}`).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  ws.getCell(`A${row}`).border = {
    top:    BORDER_THIN,
    bottom: BORDER_THIN,
  };
  // Der: número doc (16pt mono)
  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = 'COT-MANUAL-001';
  ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 14, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`D${row}`).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  ws.getCell(`D${row}`).border = {
    top:    BORDER_THIN,
    bottom: BORDER_THIN,
  };
  // Llenar B,C,E,F con fill slate-100 + bordes para banda continua
  for (const col of ['B', 'C', 'E', 'F']) {
    const c = ws.getCell(`${col}${row}`);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
    c.border = { top: BORDER_THIN, bottom: BORDER_THIN };
  }
  row += 1;

  // Fila inferior título: subtítulo + emisión/vence
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Plantilla Manual · Edición Offline';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = [
    { text: 'Emisión: ', font: { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate400 }, bold: true } },
    { text: _hoyISO(),   font: { name: FONT_FAMILY, size: 8.5, color: { argb: COLOR.slate900 }, bold: true } },
    { text: '  ·  Válida hasta: ', font: { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate400 }, bold: true } },
    { text: _plus30(),   font: { name: FONT_FAMILY, size: 8.5, color: { argb: COLOR.slate900 }, bold: true } },
  ];
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  row += 1;

  // Spacer
  ws.getRow(row).height = 10;
  row += 1;

  // ─── Section-label: Cliente ───────────────────────────────────────────────
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'CLIENTE';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // ─── Client-grid (3 col: Razón Social / RNC / Dirección) ──────────────────
  // Mismo layout PDF: lbl encima en uppercase tiny, val abajo bold
  const grid = [
    { lbl: 'Razón Social', val: '', span: ['A', 'C'], extra: 'Cliente / No. Cotización: COT-MANUAL-001' },
    { lbl: 'RNC',          val: '', span: ['D', 'E'], extra: 'Teléfono' },
    { lbl: 'Dirección',    val: '', span: ['F', 'G'], extra: 'Email' },
  ];

  // Fila 1: labels
  ws.getRow(row).height = 14;
  for (const cell of grid) {
    ws.mergeCells(`${cell.span[0]}${row}:${cell.span[1]}${row}`);
    const c = ws.getCell(`${cell.span[0]}${row}`);
    c.value = cell.lbl;
    c.font  = { name: FONT_FAMILY, size: 7, bold: true, color: { argb: COLOR.slate500 } };
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    // Borde superior + lados
    c.border = {
      top: { style: 'thin', color: { argb: COLOR.slate200 } },
      bottom: { style: 'hair', color: { argb: COLOR.slate200 } },
      left: { style: 'thin', color: { argb: COLOR.slate200 } },
      right: { style: 'thin', color: { argb: COLOR.slate200 } },
    };
    // Replicar fill/border en la celda vecina dentro del merge
    for (let col = cell.span[0].charCodeAt(0) + 1; col <= cell.span[1].charCodeAt(0); col += 1) {
      const c2 = ws.getCell(`${String.fromCharCode(col)}${row}`);
      fillBg(c2, COLOR.slate50);
      c2.border = c.border;
    }
  }
  row += 1;

  // Fila 2: valores (vacíos)
  ws.getRow(row).height = 20;
  for (const cell of grid) {
    ws.mergeCells(`${cell.span[0]}${row}:${cell.span[1]}${row}`);
    const c = ws.getCell(`${cell.span[0]}${row}`);
    c.value = '';
    c.font  = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    c.border = {
      top: { style: 'hair', color: { argb: COLOR.slate200 } },
      bottom: { style: 'thin', color: { argb: COLOR.slate200 } },
      left: { style: 'thin', color: { argb: COLOR.slate200 } },
      right: { style: 'thin', color: { argb: COLOR.slate200 } },
    };
    for (let col = cell.span[0].charCodeAt(0) + 1; col <= cell.span[1].charCodeAt(0); col += 1) {
      const c2 = ws.getCell(`${String.fromCharCode(col)}${row}`);
      fillBg(c2, COLOR.slate50);
      c2.border = c.border;
    }
  }
  row += 1;

  // Spacer
  ws.getRow(row).height = 14;
  row += 1;

  // ─── Section-label: Detalle ───────────────────────────────────────────────
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'DETALLE DE PRODUCTOS Y SERVICIOS';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // ─── Tabla items: header (slate-100, 7.5pt caps slate-700) ────────────────
  const headers = [
    { txt: 'Ítems',                 align: 'center' },
    { txt: 'Código / Modelo',       align: 'left'   },
    { txt: 'Descripción Técnica',   align: 'left'   },
    { txt: 'Cant.',                 align: 'center' },
    { txt: 'Precio Unit. (RD$)',    align: 'right'  },
    { txt: 'ITBIS (18%)',           align: 'right'  },
    { txt: 'Importe (RD$)',         align: 'right'  },
  ];
  ws.getRow(row).height = 24;
  headers.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h.txt;
    cell.font  = { name: FONT_FAMILY, size: 8, bold: true, color: { argb: COLOR.slate700 } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
    cell.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0, wrapText: true };
    cell.border = {
      top:    { style: 'thin', color: { argb: COLOR.slate300 } },
      bottom: { style: 'medium', color: { argb: COLOR.slate300 } },
      left:   { style: 'hair', color: { argb: COLOR.slate200 } },
      right:  { style: 'hair', color: { argb: COLOR.slate200 } },
    };
  });
  const headerRow = row;
  row += 1;

  // ─── Tabla items: filas vacías con fórmulas vivas ─────────────────────────
  const firstItemRow = row;
  for (let i = 0; i < ITEMS_INICIALES; i += 1) {
    ws.getRow(row).height = 21;

    // # (auto-numerado, slate-400 mini)
    ws.getCell(`A${row}`).value = i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate400 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    // Código (mono slate-800 bold)
    ws.getCell(`B${row}`).value = '';
    ws.getCell(`B${row}`).font  = { name: FONT_MONO, size: 8, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    // Descripción (10pt body slate-900, wrap)
    ws.getCell(`C${row}`).value = '';
    ws.getCell(`C${row}`).font  = { name: FONT_FAMILY, size: 9.5, color: { argb: COLOR.slate900 } };
    ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };

    // Cantidad (centro mono)
    ws.getCell(`D${row}`).value = null;
    ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate900 } };
    ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`D${row}`).numFmt = '#,##0';

    // Precio Unitario (mono der)
    ws.getCell(`E${row}`).value = null;
    ws.getCell(`E${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate900 } };
    ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`E${row}`).numFmt = '#,##0.00';

    // ITBIS — fórmula viva: =Cant*Precio*0.18 (IFERROR para celdas vacías)
    ws.getCell(`F${row}`).value = { formula: `IFERROR(D${row}*E${row}*${ITBIS_RATE},0)`, result: 0 };
    ws.getCell(`F${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate700 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';

    // Importe — fórmula viva: =Cant*Precio (bold)
    ws.getCell(`G${row}`).value = { formula: `IFERROR(D${row}*E${row},0)`, result: 0 };
    ws.getCell(`G${row}`).font  = { name: FONT_MONO, size: 9.5, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`G${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`G${row}`).numFmt = '#,##0.00';

    // Zebra (slate-50 en filas pares = i impar) + bordes hair
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const c = ws.getCell(`${col}${row}`);
      if (i % 2 === 1) fillBg(c, COLOR.slate50);
      c.border = {
        top:    { style: 'hair', color: { argb: COLOR.slate200 } },
        bottom: { style: 'hair', color: { argb: COLOR.slate200 } },
        left:   { style: 'hair', color: { argb: COLOR.slate200 } },
        right:  { style: 'hair', color: { argb: COLOR.slate200 } },
      };
    }
    row += 1;
  }
  const lastItemRow = row - 1;

  // ─── Inserta watermark "Cotización" sobre la tabla ────────────────────────
  const wmPng = await _generarWatermarkPng();
  const wmId  = wb.addImage({ buffer: wmPng, extension: 'png' });
  // tl col/row 0-indexed; col 0.5 = mitad de col A. Centramos sobre cols B-F.
  ws.addImage(wmId, {
    tl: { col: 1.0, row: firstItemRow - 0.5 },
    ext: { width: 540, height: 140 },
    editAs: 'absolute',
  });

  // Spacer
  ws.getRow(row).height = 8;
  row += 1;

  // ─── Bloque Totales (alineado a la derecha, mismo patrón PDF) ─────────────
  const totSubtotalRow = row;
  const totItbisRow    = row + 1;
  const totTotalRow    = row + 2;
  const totalesDef = [
    { lbl: 'Subtotal',    formula: `SUM(G${firstItemRow}:G${lastItemRow})`, grand: false },
    { lbl: 'ITBIS (18%)', formula: `SUM(F${firstItemRow}:F${lastItemRow})`, grand: false },
    { lbl: 'Total Neto',  formula: `G${totSubtotalRow}+G${totItbisRow}`,    grand: true  },
  ];
  totalesDef.forEach((t, i) => {
    const r = row + i;
    ws.getRow(r).height = t.grand ? 28 : 22;

    // Label cell (E-F merged)
    ws.mergeCells(`E${r}:F${r}`);
    const lblCell = ws.getCell(`E${r}`);
    lblCell.value = t.lbl;
    lblCell.font  = {
      name: FONT_FAMILY,
      size: t.grand ? 11 : 8,
      bold: true,
      color: { argb: t.grand ? COLOR.slate700 : COLOR.slate600 },
    };
    lblCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    if (t.grand) fillBg(lblCell, COLOR.slate100);
    lblCell.border = {
      top:    t.grand ? BORDER_THICK : BORDER_HAIR,
      bottom: BORDER_HAIR,
      left:   BORDER_HAIR,
      right:  BORDER_HAIR,
    };
    // Replicar fill/border en F (merge sibling)
    const fCell = ws.getCell(`F${r}`);
    if (t.grand) fillBg(fCell, COLOR.slate100);
    fCell.border = lblCell.border;

    // Val cell (G col, fórmula)
    const valCell = ws.getCell(`G${r}`);
    valCell.value = { formula: t.formula, result: 0 };
    valCell.font  = {
      name: FONT_MONO,
      size: t.grand ? 13 : 9.5,
      bold: true,
      color: { argb: COLOR.slate900 },
    };
    valCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    valCell.numFmt = '"RD$" #,##0.00';
    if (t.grand) fillBg(valCell, COLOR.slate100);
    valCell.border = {
      top:    t.grand ? BORDER_THICK : BORDER_HAIR,
      bottom: BORDER_HAIR,
      left:   BORDER_HAIR,
      right:  BORDER_HAIR,
    };
  });
  row = totTotalRow + 1;

  // Spacer
  ws.getRow(row).height = 14;
  row += 1;

  // ─── Condiciones Generales (caja izquierda, paridad legal-note PDF) ───────
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'CONDICIONES GENERALES';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, bold: true, color: { argb: COLOR.slate700 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  row += 1;

  const condiciones = [
    'Esta cotización tiene carácter informativo y no constituye documento fiscal.',
    'Los precios pueden estar sujetos a cambio sin previo aviso fuera del período de validez (30 días desde la emisión).',
    'Para emisión de factura formal se requiere confirmación por escrito.',
    'Tiempo de entrega: a confirmar contra disponibilidad de stock al momento de la orden de compra.',
    'Forma de pago: 50% al confirmar la orden / 50% contra entrega — salvo acuerdo distinto por escrito.',
  ];
  for (const c of condiciones) {
    ws.getRow(row).height = 14;
    ws.mergeCells(`A${row}:G${row}`);
    ws.getCell(`A${row}`).value = `·  ${c}`;
    ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, color: { argb: COLOR.slate600 } };
    ws.getCell(`A${row}`).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate50 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    row += 1;
  }

  // Spacer
  ws.getRow(row).height = 18;
  row += 1;

  // ─── Firmas (2 cols centradas con underline) ──────────────────────────────
  ws.getRow(row).height = 46;
  ws.mergeCells(`A${row}:C${row}`);
  ws.mergeCells(`E${row}:G${row}`);
  for (const a of [`A${row}`, `E${row}`]) {
    ws.getCell(a).border = { bottom: { style: 'thin', color: { argb: COLOR.slate900 } } };
  }
  row += 1;
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'ACEPTACIÓN DEL CLIENTE';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 8, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 8, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;
  ws.getRow(row).height = 13;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Firma · Sello · Fecha';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = 'Representante Autorizado · Firma · Sello';
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 7, color: { argb: COLOR.slate500 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  // ─── Footer print (corpora unificado: razón · RNC · web · página) ─────────
  ws.headerFooter = {
    differentFirst: false,
    oddFooter:
      `&L&7&K475569${EMPRESA.razonSocial} · RNC ${EMPRESA.rnc}` +
      `&C&7&K94A3B8Documento offline · ${EMPRESA.website}` +
      `&R&7&K94A3B8Página &P de &N`,
  };

  // ─── Anexo fotográfico (caja delimitada, page-break PDF) ──────────────────
  row += 2;
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'ANEXO FOTOGRÁFICO';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.slate700 } };
  ws.getCell(`A${row}`).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;
  ws.getRow(row).height = 12;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'Insertar fotografías del levantamiento · Cuadrícula 2×2 simétrica';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  // 2 filas × 2 cajas delimitadas (col A-C / E-G)
  for (let i = 0; i < 2; i += 1) {
    ws.getRow(row).height = 90;
    ws.mergeCells(`A${row}:C${row}`);
    ws.mergeCells(`E${row}:G${row}`);
    for (const a of [`A${row}`, `E${row}`]) {
      const c = ws.getCell(a);
      c.value = '[ FOTO ]';
      c.font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.slate400 } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.border = {
        top:    { style: 'dashed', color: { argb: COLOR.slate300 } },
        bottom: { style: 'dashed', color: { argb: COLOR.slate300 } },
        left:   { style: 'dashed', color: { argb: COLOR.slate300 } },
        right:  { style: 'dashed', color: { argb: COLOR.slate300 } },
      };
    }
    row += 1;
    ws.getRow(row).height = 12;
    ws.mergeCells(`A${row}:C${row}`);
    ws.mergeCells(`E${row}:G${row}`);
    ws.getCell(`A${row}`).value = 'Pie de foto / ubicación';
    ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 7.5, color: { argb: COLOR.slate500 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`E${row}`).value = 'Pie de foto / ubicación';
    ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 7.5, color: { argb: COLOR.slate500 } };
    ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    row += 1;
    ws.getRow(row).height = 6;
    row += 1;
  }

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
