/**
 * backend/scripts/ops/generarPlantillaExcel.js
 *
 * Plantilla XLSX editable con paridad visual del PDF oficial (`pdf-templates.js`).
 * Datos demo COMPLETOS (cliente, items, totales calculados, validez, formas de
 * pago, garantía) compartidos con el PDF y el DOCX via `_demoCotizacion.js` —
 * los tres archivos coinciden 1:1 al inspeccionarlos lado a lado.
 *
 * Mantiene fórmulas vivas Excel: el técnico edita Cant/Precio y Importe/ITBIS/
 * Subtotal/Total se recalculan solos. Los datos demo arrancan llenos.
 *
 * Características:
 *   · Banda corporate slate-300 (3px)
 *   · Logo PNG real (backend/assets/logo-acr.png) embebido en la celda izquierda
 *     del header — mismo logo que el PDF
 *   · Header empresa: razón social, nombre comercial, eslogan, RNC, dirección,
 *     teléfono, email, website
 *   · Title-bar slate-100 con COTIZACIÓN + número + emisión/vence
 *   · Marca de agua "COTIZACIÓN" azul rotada -20deg (sharp SVG→PNG)
 *   · Bloque cliente: razón social, RNC, dirección, teléfono, email, número
 *   · Tabla items 7 col con datos demo y fórmulas vivas
 *   · Totales: Subtotal/ITBIS/Total Neto con SUM
 *   · Condiciones generales (validez, pago, entrega, garantía)
 *   · Notas / proyecto
 *   · Firmas dual + footer print
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.xlsx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaExcel.js
 */

const path = require('path');
const ExcelJS = require('exceljs');
const sharp   = require('sharp');

const {
  EMPRESA, CLIENTE, ITEMS, NUMERO,
  CONDICIONES, NOTAS, ITBIS_RATE,
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

const BORDER_HAIR  = { style: 'hair',   color: { argb: COLOR.slate200 } };
const BORDER_THIN  = { style: 'thin',   color: { argb: COLOR.slate200 } };
const BORDER_MED   = { style: 'thin',   color: { argb: COLOR.slate300 } };
const BORDER_THICK = { style: 'medium', color: { argb: COLOR.slate400 } };

function fillBg(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

async function _watermarkPng() {
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
          fill-opacity="0.07">COTIZACIÓN</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function construirLibro() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'ACR Networks & Solutions';
  wb.company  = 'ACR Networks & Solutions';
  wb.title    = `Cotización ${NUMERO}`;
  wb.subject  = 'Cotización editable offline · paridad PDF';
  wb.keywords = 'cotizacion, ACR, offline, plantilla';
  wb.created  = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('Cotización', {
    properties: { tabColor: { argb: COLOR.blue800 }, defaultRowHeight: 15 },
    pageSetup: {
      paperSize: 1,
      orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.35, bottom: 0.45, header: 0.2, footer: 0.25 },
      horizontalCentered: true,
    },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 110 }],
  });

  ws.getColumn('A').width =  5;    // #
  ws.getColumn('B').width = 14;    // Código
  ws.getColumn('C').width = 44;    // Descripción
  ws.getColumn('D').width =  9;    // Cant.
  ws.getColumn('E').width = 14;    // Precio Unit.
  ws.getColumn('F').width = 12;    // ITBIS
  ws.getColumn('G').width = 15;    // Importe

  let row = 1;

  // ─── Banda corporate ──────────────────────────────────────────────────────
  ws.getRow(row).height = 4;
  ws.mergeCells(`A${row}:G${row}`);
  fillBg(ws.getCell(`A${row}`), COLOR.slate300);
  row += 1;

  // ─── Header empresa (rows 2-5): logo izq + brand info center + corp-meta der
  // Logo PNG real (anclado a A2-A5) + razón social en B-D + RNC/dirección en E-G
  const logoBuf = logoBuffer();
  if (logoBuf) {
    const imgId = wb.addImage({ buffer: logoBuf, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: 0.1, row: 1.1 },
      ext: { width: 70, height: 70 },
      editAs: 'oneCell',
    });
  }
  // Reservar 4 filas para el header
  ws.getRow(row).height = 18;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 14, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = [
    { text: 'RNC  ', font: { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate400 } } },
    { text: EMPRESA.rnc, font: { name: FONT, size: 10, bold: true, color: { argb: COLOR.slate900 } } },
  ];
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.nombreComercial;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.blue800 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = EMPRESA.direccion;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate700 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
  row += 1;

  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.eslogan;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 7.5, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = `Tel. ${EMPRESA.telefono}  ·  ${EMPRESA.email}`;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = '';
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = EMPRESA.website;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.blue800 }, underline: true };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Separador
  ws.getRow(row).height = 3;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).border = { bottom: BORDER_THIN };
  row += 1;

  // ─── Title-bar ────────────────────────────────────────────────────────────
  ws.getRow(row).height = 30;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'COTIZACIÓN';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 16, bold: true, color: { argb: COLOR.slate800 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate100);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  ws.getCell(`A${row}`).border = { top: BORDER_THIN, bottom: BORDER_THIN };

  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = NUMERO;
  ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 15, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate100);
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  ws.getCell(`D${row}`).border = { top: BORDER_THIN, bottom: BORDER_THIN };
  for (const col of ['B', 'C', 'E', 'F']) {
    const c = ws.getCell(`${col}${row}`);
    fillBg(c, COLOR.slate100);
    c.border = { top: BORDER_THIN, bottom: BORDER_THIN };
  }
  row += 1;

  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Documento Electrónico Verificable';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 7.5, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
  ws.mergeCells(`D${row}:G${row}`);
  ws.getCell(`D${row}`).value = [
    { text: 'Emisión: ',        font: { name: FONT, size: 8, color: { argb: COLOR.slate400 }, bold: true } },
    { text: fechaISO(fechaEmision()), font: { name: FONT, size: 8.5, color: { argb: COLOR.slate900 }, bold: true } },
    { text: '   ·   Válida hasta: ',  font: { name: FONT, size: 8, color: { argb: COLOR.slate400 }, bold: true } },
    { text: fechaISO(fechaVence()),   font: { name: FONT, size: 8.5, color: { argb: COLOR.slate900 }, bold: true } },
  ];
  ws.getCell(`D${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 2 };
  row += 1;

  // ─── Cliente ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 10;
  row += 1;
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'CLIENTE';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Client-grid 3 col: Razón Social/Cliente / RNC + Tel/Contacto / Dirección + Email
  ws.getRow(row).height = 14;
  for (const [start, end, lbl] of [['A', 'C', 'Razón Social'], ['D', 'E', 'RNC / Contacto'], ['F', 'G', 'Dirección']]) {
    ws.mergeCells(`${start}${row}:${end}${row}`);
    const c = ws.getCell(`${start}${row}`);
    c.value = lbl;
    c.font  = { name: FONT, size: 7, bold: true, color: { argb: COLOR.slate500 } };
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    c.border = {
      top: { style: 'thin', color: { argb: COLOR.slate200 } },
      left: { style: 'thin', color: { argb: COLOR.slate200 } },
      right: { style: 'thin', color: { argb: COLOR.slate200 } },
    };
    for (let col = start.charCodeAt(0) + 1; col <= end.charCodeAt(0); col += 1) {
      const c2 = ws.getCell(`${String.fromCharCode(col)}${row}`);
      fillBg(c2, COLOR.slate50);
      c2.border = c.border;
    }
  }
  row += 1;

  ws.getRow(row).height = 18;
  // Razón social
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = CLIENTE.razonSocial;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 11, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  // RNC
  ws.mergeCells(`D${row}:E${row}`);
  ws.getCell(`D${row}`).value = CLIENTE.rnc;
  ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 10, bold: true, color: { argb: COLOR.slate900 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate50);
  ws.getCell(`D${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  // Dirección
  ws.mergeCells(`F${row}:G${row}`);
  ws.getCell(`F${row}`).value = CLIENTE.direccion;
  ws.getCell(`F${row}`).font  = { name: FONT, size: 9, color: { argb: COLOR.slate800 } };
  fillBg(ws.getCell(`F${row}`), COLOR.slate50);
  ws.getCell(`F${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
  for (const [start, end] of [['A', 'C'], ['D', 'E'], ['F', 'G']]) {
    for (let col = start.charCodeAt(0); col <= end.charCodeAt(0); col += 1) {
      const c = ws.getCell(`${String.fromCharCode(col)}${row}`);
      c.border = { left: BORDER_THIN, right: BORDER_THIN };
    }
  }
  row += 1;

  ws.getRow(row).height = 16;
  // Sub: cliente#
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = `Cliente #: ${CLIENTE.noCliente}  ·  ${CLIENTE.contacto}`;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  // Tel.
  ws.mergeCells(`D${row}:E${row}`);
  ws.getCell(`D${row}`).value = `Tel. ${CLIENTE.telefono}`;
  ws.getCell(`D${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`D${row}`), COLOR.slate50);
  ws.getCell(`D${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  // Email
  ws.mergeCells(`F${row}:G${row}`);
  ws.getCell(`F${row}`).value = CLIENTE.email;
  ws.getCell(`F${row}`).font  = { name: FONT, size: 8.5, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`F${row}`), COLOR.slate50);
  ws.getCell(`F${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  for (const [start, end] of [['A', 'C'], ['D', 'E'], ['F', 'G']]) {
    for (let col = start.charCodeAt(0); col <= end.charCodeAt(0); col += 1) {
      const c = ws.getCell(`${String.fromCharCode(col)}${row}`);
      c.border = { left: BORDER_THIN, right: BORDER_THIN, bottom: BORDER_THIN };
    }
  }
  row += 1;

  // ─── Detalle ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 12;
  row += 1;
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'DETALLE DE PRODUCTOS Y SERVICIOS';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Header tabla
  const headers = [
    { txt: '#',                       align: 'center' },
    { txt: 'Código',                  align: 'left'   },
    { txt: 'Descripción',             align: 'left'   },
    { txt: 'Cant.',                   align: 'center' },
    { txt: 'Precio Unit. (RD$)',      align: 'right'  },
    { txt: 'ITBIS (18%)',             align: 'right'  },
    { txt: 'Importe (RD$)',           align: 'right'  },
  ];
  ws.getRow(row).height = 24;
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h.txt;
    c.font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate700 } };
    fillBg(c, COLOR.slate100);
    c.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0, wrapText: true };
    c.border = {
      top: { style: 'thin', color: { argb: COLOR.slate300 } },
      bottom: { style: 'medium', color: { argb: COLOR.slate300 } },
      left: BORDER_HAIR,
      right: BORDER_HAIR,
    };
  });
  const headerRow = row;
  row += 1;

  // Filas demo prellenadas + fórmulas vivas
  const firstItemRow = row;
  ITEMS.forEach((it, i) => {
    ws.getRow(row).height = 28;

    ws.getCell(`A${row}`).value = i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate400 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    ws.getCell(`B${row}`).value = it.codigo;
    ws.getCell(`B${row}`).font  = { name: FONT_MONO, size: 8.5, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    // Descripción + detalle (richText: title bold + subtitle gray)
    ws.getCell(`C${row}`).value = {
      richText: [
        { text: it.descripcion, font: { name: FONT, size: 10, bold: true, color: { argb: COLOR.slate900 } } },
        ...(it.detalle ? [
          { text: '\n', font: { name: FONT, size: 9 } },
          { text: it.detalle, font: { name: FONT, size: 8.5, color: { argb: COLOR.slate500 } } },
        ] : []),
      ],
    };
    ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };

    ws.getCell(`D${row}`).value = it.cantidad;
    ws.getCell(`D${row}`).font  = { name: FONT_MONO, size: 9.5, color: { argb: COLOR.slate900 } };
    ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`D${row}`).numFmt = '#,##0';

    ws.getCell(`E${row}`).value = it.precioUnitario;
    ws.getCell(`E${row}`).font  = { name: FONT_MONO, size: 9.5, color: { argb: COLOR.slate900 } };
    ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`E${row}`).numFmt = '#,##0.00';

    // ITBIS = Cant * Precio * 0.18 (fórmula viva)
    ws.getCell(`F${row}`).value = { formula: `IFERROR(D${row}*E${row}*${ITBIS_RATE},0)`, result: it.cantidad * it.precioUnitario * ITBIS_RATE };
    ws.getCell(`F${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate700 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';

    // Importe = Cant * Precio (fórmula viva, bold)
    ws.getCell(`G${row}`).value = { formula: `IFERROR(D${row}*E${row},0)`, result: it.cantidad * it.precioUnitario };
    ws.getCell(`G${row}`).font  = { name: FONT_MONO, size: 9.5, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`G${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`G${row}`).numFmt = '#,##0.00';

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
  });
  const lastItemRow = row - 1;

  // 3 filas vacías para expansión
  for (let i = 0; i < 3; i += 1) {
    ws.getRow(row).height = 20;
    ws.getCell(`A${row}`).value = ITEMS.length + i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT, size: 8, color: { argb: COLOR.slate300 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    ws.getCell(`F${row}`).value = { formula: `IFERROR(D${row}*E${row}*${ITBIS_RATE},0)`, result: 0 };
    ws.getCell(`F${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate700 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';

    ws.getCell(`G${row}`).value = { formula: `IFERROR(D${row}*E${row},0)`, result: 0 };
    ws.getCell(`G${row}`).font  = { name: FONT_MONO, size: 9.5, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`G${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`G${row}`).numFmt = '#,##0.00';

    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      ws.getCell(`${col}${row}`).border = {
        top:    { style: 'hair', color: { argb: COLOR.slate200 } },
        bottom: { style: 'hair', color: { argb: COLOR.slate200 } },
        left:   { style: 'hair', color: { argb: COLOR.slate200 } },
        right:  { style: 'hair', color: { argb: COLOR.slate200 } },
      };
    }
    row += 1;
  }
  const lastFormulaRow = row - 1;

  // ─── Watermark COTIZACIÓN ─────────────────────────────────────────────────
  const wmPng = await _watermarkPng();
  const wmId  = wb.addImage({ buffer: wmPng, extension: 'png' });
  ws.addImage(wmId, {
    tl: { col: 1.0, row: firstItemRow - 0.5 },
    ext: { width: 540, height: 140 },
    editAs: 'absolute',
  });

  ws.getRow(row).height = 8;
  row += 1;

  // ─── Totales ──────────────────────────────────────────────────────────────
  const { subtotal, itbis, total } = calcular(ITEMS);
  const totSubtotalRow = row;
  const totItbisRow    = row + 1;
  const totTotalRow    = row + 2;
  const totalesDef = [
    { lbl: 'Subtotal',     formula: `SUM(G${firstItemRow}:G${lastFormulaRow})`, result: subtotal, grand: false },
    { lbl: 'ITBIS (18%)',  formula: `SUM(F${firstItemRow}:F${lastFormulaRow})`, result: itbis,    grand: false },
    { lbl: 'Total Neto',   formula: `G${totSubtotalRow}+G${totItbisRow}`,        result: total,    grand: true  },
  ];
  totalesDef.forEach((t, i) => {
    const r = row + i;
    ws.getRow(r).height = t.grand ? 28 : 22;
    ws.mergeCells(`E${r}:F${r}`);
    const lblCell = ws.getCell(`E${r}`);
    lblCell.value = t.lbl;
    lblCell.font  = {
      name: FONT, size: t.grand ? 11 : 8.5, bold: true,
      color: { argb: t.grand ? COLOR.slate700 : COLOR.slate600 },
    };
    lblCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    if (t.grand) fillBg(lblCell, COLOR.slate100);
    lblCell.border = {
      top: t.grand ? BORDER_THICK : BORDER_HAIR, bottom: BORDER_HAIR,
      left: BORDER_HAIR, right: BORDER_HAIR,
    };
    const fCell = ws.getCell(`F${r}`);
    if (t.grand) fillBg(fCell, COLOR.slate100);
    fCell.border = lblCell.border;

    const valCell = ws.getCell(`G${r}`);
    valCell.value = { formula: t.formula, result: t.result };
    valCell.font  = {
      name: FONT_MONO, size: t.grand ? 13 : 10, bold: true,
      color: { argb: COLOR.slate900 },
    };
    valCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    valCell.numFmt = '"RD$" #,##0.00';
    if (t.grand) fillBg(valCell, COLOR.slate100);
    valCell.border = {
      top: t.grand ? BORDER_THICK : BORDER_HAIR, bottom: BORDER_HAIR,
      left: BORDER_HAIR, right: BORDER_HAIR,
    };
  });
  row = totTotalRow + 1;

  ws.getRow(row).height = 12;
  row += 1;

  // ─── Condiciones (grid 4 col paridad PDF) ─────────────────────────────────
  const condDef = [
    { lbl: 'Validez',         val: CONDICIONES.validez  },
    { lbl: 'Forma de Pago',   val: CONDICIONES.pago     },
    { lbl: 'Tiempo Entrega',  val: CONDICIONES.entrega  },
    { lbl: 'Garantía',        val: CONDICIONES.garantia },
  ];
  ws.getRow(row).height = 30;
  // 4 columnas en 7 celdas: A-B / C-D / E / F-G (mejor: distribuir A B C-D E-F G)
  // Más simple: ocupar A-B, C-D, E-F, G como 4 cajas
  const condRanges = [['A','B'], ['C','C'], ['D','E'], ['F','G']];
  condDef.forEach(({lbl, val}, idx) => {
    const [s, e] = condRanges[idx];
    if (s !== e) ws.mergeCells(`${s}${row}:${e}${row}`);
    const c = ws.getCell(`${s}${row}`);
    c.value = { richText: [
      { text: lbl + '\n', font: { name: FONT, size: 7.5, bold: true, color: { argb: COLOR.slate500 } } },
      { text: val,        font: { name: FONT, size: 9, bold: true, color: { argb: COLOR.slate900 } } },
    ]};
    fillBg(c, COLOR.slate50);
    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
    c.border = {
      top: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN,
      left: { style: 'thick', color: { argb: COLOR.blue800 } },
    };
    if (s !== e) {
      for (let col = s.charCodeAt(0) + 1; col <= e.charCodeAt(0); col += 1) {
        const c2 = ws.getCell(`${String.fromCharCode(col)}${row}`);
        fillBg(c2, COLOR.slate50);
        c2.border = { top: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };
      }
    }
  });
  row += 1;

  ws.getRow(row).height = 12;
  row += 1;

  // ─── Notas ────────────────────────────────────────────────────────────────
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'NOTAS DEL PROYECTO';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate700 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { left: { style: 'thick', color: { argb: COLOR.slate400 } }, top: BORDER_THIN, right: BORDER_THIN };
  for (let c = 2; c <= 7; c += 1) {
    const cell = ws.getCell(row, c);
    fillBg(cell, COLOR.slate50);
    cell.border = { top: BORDER_THIN, right: BORDER_THIN };
  }
  row += 1;

  ws.getRow(row).height = 50;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = NOTAS;
  ws.getCell(`A${row}`).font  = { name: FONT, size: 9, color: { argb: COLOR.slate700 } };
  fillBg(ws.getCell(`A${row}`), COLOR.slate50);
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 };
  ws.getCell(`A${row}`).border = { left: { style: 'thick', color: { argb: COLOR.slate400 } }, bottom: BORDER_THIN, right: BORDER_THIN };
  for (let c = 2; c <= 7; c += 1) {
    const cell = ws.getCell(row, c);
    fillBg(cell, COLOR.slate50);
    cell.border = { bottom: BORDER_THIN, right: BORDER_THIN };
  }
  row += 1;

  ws.getRow(row).height = 18;
  row += 1;

  // ─── Firmas ───────────────────────────────────────────────────────────────
  ws.getRow(row).height = 44;
  ws.mergeCells(`A${row}:C${row}`);
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`A${row}`).border = { bottom: { style: 'thin', color: { argb: COLOR.slate900 } } };
  ws.getCell(`E${row}`).border = { bottom: { style: 'thin', color: { argb: COLOR.slate900 } } };
  row += 1;

  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'ACEPTACIÓN DEL CLIENTE';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = `${EMPRESA.representanteNombre} ${EMPRESA.representanteApellido}`.toUpperCase();
  ws.getCell(`E${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 12;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Firma · Sello · Fecha';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 7, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = `${EMPRESA.representanteCargo} · ${EMPRESA.razonSocial}`;
  ws.getCell(`E${row}`).font  = { name: FONT, size: 7, color: { argb: COLOR.slate500 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  // ─── Footer print ─────────────────────────────────────────────────────────
  ws.headerFooter = {
    differentFirst: false,
    oddFooter:
      `&L&7&K475569${EMPRESA.razonSocial} · RNC ${EMPRESA.rnc}` +
      `&C&7&K94A3B8Documento Electrónico Verificable · ${EMPRESA.website}` +
      `&R&7&K94A3B8Página &P de &N`,
  };

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
