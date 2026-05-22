/**
 * backend/scripts/ops/generarPlantillaExcel.js
 *
 * Generador de plantilla XLSX editable offline (Cotización RA Networks & Solutions).
 * Hereda paleta corporativa del template PDF oficial (slate-900/slate-100/blue-800)
 * para que la copia editable lea exactamente igual al PDF formal.
 *
 * Cuándo usar: el técnico de campo necesita cotizar sin conectividad. Abre el .xlsx
 * en Excel/Numbers/LibreOffice, edita Cantidad y Precio Unit., y las fórmulas vivas
 * recalculan Importe + ITBIS + Subtotal + Total Neto al instante.
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.xlsx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaExcel.js
 */

const path = require('path');
const ExcelJS = require('exceljs');

// ─── Paleta corporativa (ARGB para exceljs: alpha + RGB) ────────────────────
const COLOR = {
  slate900:  'FF0F172A',  // corp dark
  slate800:  'FF1E293B',
  slate700:  'FF334155',
  slate600:  'FF475569',
  slate500:  'FF64748B',
  slate400:  'FF94A3B8',
  slate300:  'FFCBD5E1',
  slate200:  'FFE2E8F0',
  slate100:  'FFF1F5F9',  // title-bar bg / table header
  slate50:   'FFF8FAFC',  // zebra
  blue800:   'FF1E40AF',  // accent
  white:     'FFFFFFFF',
};

const FONT_FAMILY = 'Calibri';

// ─── Datos defaults (mismos del cotizador-libre) ────────────────────────────
const EMPRESA = {
  razonSocial:     'ACR Networks & Solutions, SRL',
  nombreComercial: 'ACR NETWORKS & SOLUTIONS',
  tagline:         'Infraestructura de Redes · Seguridad Electrónica · Fibra Óptica',
  rnc:             '1-32-12345-6',
  direccion:       'Santo Domingo, República Dominicana',
  telefono:        '+1 809 000 0000',
  email:           'contacto@acrnetworks.do',
  website:         'https://acrnetworks.do',
};

const ITEMS_INICIALES = 15;            // 15 líneas vacías listas para llenar
const ITBIS_RATE      = 0.18;

function _hoyISO() {
  return new Date().toISOString().slice(0, 10);
}
function _plus30() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

// Borde fino slate-200 (matchea border de tabla items PDF).
const BORDER_THIN  = { style: 'thin',  color: { argb: COLOR.slate200 } };
const BORDER_MED   = { style: 'thin',  color: { argb: COLOR.slate300 } };
const BORDER_THICK = { style: 'medium', color: { argb: COLOR.slate400 } };

function aplicarBordeFino(cell) {
  cell.border = { top: BORDER_THIN, left: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };
}

async function construirLibro() {
  const wb = new ExcelJS.Workbook();
  wb.creator        = 'ACR Networks & Solutions';
  wb.company        = 'ACR Networks & Solutions';
  wb.title          = 'Cotización Manual RA';
  wb.subject        = 'Plantilla editable offline';
  wb.keywords       = 'cotizacion, manual, RA, offline, ACR';
  wb.created        = new Date();
  wb.modified       = new Date();

  const ws = wb.addWorksheet('Cotización RA', {
    properties: { tabColor: { argb: COLOR.blue800 }, defaultRowHeight: 18 },
    pageSetup:  {
      paperSize: 1,                // Letter
      orientation: 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.3 },
      printArea: 'A1:G45',
    },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 110 }],
  });

  // Anchos de columna (matchea proporciones de tabla PDF)
  ws.getColumn('A').width =  6;   // #
  ws.getColumn('B').width = 16;   // Código/Modelo
  ws.getColumn('C').width = 46;   // Descripción Técnica
  ws.getColumn('D').width = 10;   // Cantidad
  ws.getColumn('E').width = 16;   // Precio Unit.
  ws.getColumn('F').width = 14;   // ITBIS (18%)
  ws.getColumn('G').width = 16;   // Importe

  let row = 1;

  // ─── Banda corporate (row 1, slate-300, ~3px) ─────────────────────────────
  ws.getRow(row).height = 4;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate300 } };
  row += 1;

  // ─── Header empresa (rows 2-4) ────────────────────────────────────────────
  ws.getRow(row).height = 30;
  ws.mergeCells(`A${row}:D${row}`);
  ws.getCell(`A${row}`).value = EMPRESA.razonSocial;
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 16, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = `RNC ${EMPRESA.rnc}`;
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:D${row}`);
  ws.getCell(`A${row}`).value = EMPRESA.nombreComercial;
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.blue800 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = EMPRESA.direccion;
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 9, color: { argb: COLOR.slate700 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:D${row}`);
  ws.getCell(`A${row}`).value = EMPRESA.tagline;
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 8, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = `${EMPRESA.telefono}  ·  ${EMPRESA.email}`;
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // ─── Title-bar (slate-100 bg) ─────────────────────────────────────────────
  ws.getRow(row).height = 30;
  ws.mergeCells(`A${row}:G${row}`);
  const titleCell = ws.getCell(`A${row}`);
  titleCell.value = 'COTIZACIÓN';
  titleCell.font  = { name: FONT_FAMILY, size: 18, bold: true, color: { argb: COLOR.slate900 } };
  titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.border = { top: { style: 'thin', color: { argb: COLOR.slate200 } }, bottom: { style: 'thin', color: { argb: COLOR.slate200 } } };
  row += 1;

  // ─── Espacio ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 8;
  row += 1;

  // ─── Datos del cliente (3 filas × 2 etiq/valor) ───────────────────────────
  const clienteRows = [
    ['Razón Social',  '',  'No. Cotización',  'COT-MANUAL-001'],
    ['RNC / Cédula',  '',  'Fecha Emisión',   _hoyISO()],
    ['Dirección',     '',  'Válida Hasta',    _plus30()],
    ['Teléfono',      '',  'Atención',        ''],
    ['Email',         '',  'Proyecto',        ''],
  ];
  for (const [lbl1, val1, lbl2, val2] of clienteRows) {
    ws.getRow(row).height = 20;
    // Label izq
    ws.getCell(`A${row}`).value = lbl1;
    ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 8, bold: true, color: { argb: COLOR.slate500 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate50 } };
    aplicarBordeFino(ws.getCell(`A${row}`));
    // Valor izq (B-C merge)
    ws.mergeCells(`B${row}:C${row}`);
    ws.getCell(`B${row}`).value = val1;
    ws.getCell(`B${row}`).font  = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    aplicarBordeFino(ws.getCell(`B${row}`));
    aplicarBordeFino(ws.getCell(`C${row}`));
    // Label der (D-E merge)
    ws.mergeCells(`D${row}:E${row}`);
    ws.getCell(`D${row}`).value = lbl2;
    ws.getCell(`D${row}`).font  = { name: FONT_FAMILY, size: 8, bold: true, color: { argb: COLOR.slate500 } };
    ws.getCell(`D${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getCell(`D${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate50 } };
    aplicarBordeFino(ws.getCell(`D${row}`));
    aplicarBordeFino(ws.getCell(`E${row}`));
    // Valor der (F-G merge)
    ws.mergeCells(`F${row}:G${row}`);
    ws.getCell(`F${row}`).value = val2;
    ws.getCell(`F${row}`).font  = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    aplicarBordeFino(ws.getCell(`F${row}`));
    aplicarBordeFino(ws.getCell(`G${row}`));
    row += 1;
  }

  // ─── Espacio ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 12;
  row += 1;

  // ─── Tabla items: header ──────────────────────────────────────────────────
  const headers = ['Ítems', 'Código / Modelo', 'Descripción Técnica', 'Cantidad', 'Precio Unitario (RD$)', 'ITBIS (18%)', 'Importe (RD$)'];
  ws.getRow(row).height = 26;
  headers.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font  = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: COLOR.slate700 } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
    cell.alignment = { horizontal: i <= 2 ? 'left' : (i === 3 ? 'center' : 'right'), vertical: 'middle', indent: 1, wrapText: true };
    cell.border = {
      top:    { style: 'thin',   color: { argb: COLOR.slate300 } },
      bottom: { style: 'medium', color: { argb: COLOR.slate300 } },
      left:   { style: 'thin',   color: { argb: COLOR.slate200 } },
      right:  { style: 'thin',   color: { argb: COLOR.slate200 } },
    };
  });
  const headerRow = row;
  row += 1;

  // ─── Tabla items: filas vacías con fórmulas vivas ─────────────────────────
  const firstItemRow = row;
  for (let i = 0; i < ITEMS_INICIALES; i += 1) {
    ws.getRow(row).height = 22;
    // # (auto-numerado)
    ws.getCell(`A${row}`).value = i + 1;
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).font = { name: FONT_FAMILY, size: 9, color: { argb: COLOR.slate500 } };
    // Código (texto)
    ws.getCell(`B${row}`).value = '';
    ws.getCell(`B${row}`).font  = { name: 'Consolas', size: 9, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    // Descripción técnica (texto, wrap)
    ws.getCell(`C${row}`).value = '';
    ws.getCell(`C${row}`).font  = { name: FONT_FAMILY, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`C${row}`).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
    // Cantidad (number)
    ws.getCell(`D${row}`).value = null;
    ws.getCell(`D${row}`).font  = { name: FONT_FAMILY, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`D${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`D${row}`).numFmt = '#,##0';
    // Precio Unitario (number)
    ws.getCell(`E${row}`).value = null;
    ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 10, color: { argb: COLOR.slate900 } };
    ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`E${row}`).numFmt = '#,##0.00';
    // ITBIS (18%) — fórmula viva: Cant * PU * 0.18
    ws.getCell(`F${row}`).value = { formula: `IFERROR(D${row}*E${row}*${ITBIS_RATE},0)`, result: 0 };
    ws.getCell(`F${row}`).font  = { name: FONT_FAMILY, size: 10, color: { argb: COLOR.slate700 } };
    ws.getCell(`F${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`F${row}`).numFmt = '#,##0.00';
    // Importe — fórmula viva: Cant * PU (sin ITBIS — el ITBIS se suma global)
    ws.getCell(`G${row}`).value = { formula: `IFERROR(D${row}*E${row},0)`, result: 0 };
    ws.getCell(`G${row}`).font  = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: COLOR.slate900 } };
    ws.getCell(`G${row}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`G${row}`).numFmt = '#,##0.00';

    // Bordes + zebra
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const c = ws.getCell(`${col}${row}`);
      if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate50 } };
      c.border = {
        top:    { style: 'hair', color: { argb: COLOR.slate200 } },
        bottom: { style: 'hair', color: { argb: COLOR.slate200 } },
        left:   { style: 'thin', color: { argb: COLOR.slate200 } },
        right:  { style: 'thin', color: { argb: COLOR.slate200 } },
      };
    }
    row += 1;
  }
  const lastItemRow = row - 1;

  // ─── Espacio ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 10;
  row += 1;

  // ─── Bloque Totales (alineado a la derecha) ───────────────────────────────
  const totales = [
    ['Subtotal',     `SUM(G${firstItemRow}:G${lastItemRow})`, false],
    ['ITBIS Global', `SUM(F${firstItemRow}:F${lastItemRow})`, false],
    ['Total Neto',   `G${row}+G${row + 1}`,                   true],
  ];
  // Nota: la fórmula del Total Neto referenciará Subtotal y ITBIS por posición — calculada abajo
  const totSubtotalRow = row;
  const totItbisRow    = row + 1;
  const totTotalRow    = row + 2;
  totales[2][1] = `G${totSubtotalRow}+G${totItbisRow}`;

  totales.forEach(([lbl, formula, grand], i) => {
    const r = row + i;
    ws.getRow(r).height = grand ? 28 : 22;
    // Label (E-F merge)
    ws.mergeCells(`E${r}:F${r}`);
    ws.getCell(`E${r}`).value = lbl;
    ws.getCell(`E${r}`).font  = {
      name: FONT_FAMILY,
      size: grand ? 12 : 10,
      bold: true,
      color: { argb: grand ? COLOR.slate900 : COLOR.slate600 },
    };
    ws.getCell(`E${r}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`E${r}`).fill = grand
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.white } };
    // Valor (G col, formula)
    ws.getCell(`G${r}`).value = { formula, result: 0 };
    ws.getCell(`G${r}`).font  = {
      name: FONT_FAMILY,
      size: grand ? 13 : 10,
      bold: true,
      color: { argb: COLOR.slate900 },
    };
    ws.getCell(`G${r}`).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
    ws.getCell(`G${r}`).numFmt = '"RD$" #,##0.00';
    ws.getCell(`G${r}`).fill = grand
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.white } };
    // Bordes
    for (const col of ['E', 'F', 'G']) {
      const c = ws.getCell(`${col}${r}`);
      c.border = {
        top:    grand ? BORDER_THICK : BORDER_THIN,
        bottom: BORDER_THIN,
        left:   BORDER_THIN,
        right:  BORDER_THIN,
      };
    }
  });
  row = totTotalRow + 1;

  // ─── Espacio ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 14;
  row += 1;

  // ─── Condiciones Generales ────────────────────────────────────────────────
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'CONDICIONES GENERALES';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.slate700 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  row += 1;

  const condiciones = [
    'Esta cotización tiene carácter informativo y no constituye documento fiscal.',
    'Los precios pueden estar sujetos a cambio sin previo aviso fuera del período de validez (30 días desde la fecha de emisión).',
    'Para emisión de factura formal se requiere confirmación por escrito.',
    'Tiempo de entrega: a confirmar contra disponibilidad de stock al momento de la orden de compra.',
    'Forma de pago: 50% al confirmar la orden / 50% contra entrega — salvo acuerdo distinto por escrito.',
  ];
  for (const c of condiciones) {
    ws.getRow(row).height = 16;
    ws.mergeCells(`A${row}:G${row}`);
    ws.getCell(`A${row}`).value = `· ${c}`;
    ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 9, color: { argb: COLOR.slate600 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    row += 1;
  }

  // ─── Espacio ──────────────────────────────────────────────────────────────
  ws.getRow(row).height = 18;
  row += 1;

  // ─── Firmas (2 cols) ──────────────────────────────────────────────────────
  ws.getRow(row).height = 50;
  ws.mergeCells(`A${row}:C${row}`);
  ws.mergeCells(`E${row}:G${row}`);
  for (const cell of [ws.getCell(`A${row}`), ws.getCell(`E${row}`)]) {
    cell.border = { bottom: { style: 'thin', color: { argb: COLOR.slate900 } } };
  }
  row += 1;
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'ACEPTACIÓN DEL CLIENTE';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = `${EMPRESA.razonSocial} · Representante Autorizado`;
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.slate900 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;
  ws.getRow(row).height = 14;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = 'Firma · Sello · Fecha';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(`E${row}:G${row}`);
  ws.getCell(`E${row}`).value = 'Firma · Sello';
  ws.getCell(`E${row}`).font  = { name: FONT_FAMILY, size: 8, color: { argb: COLOR.slate500 } };
  ws.getCell(`E${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;

  // ─── Footer (encoded en page footer del print) ────────────────────────────
  ws.headerFooter = {
    differentFirst: false,
    oddFooter: `&L&8&K475569${EMPRESA.razonSocial} · RNC ${EMPRESA.rnc}&C&8&K94A3B8Documento offline · ${EMPRESA.website}&R&8&K94A3B8Página &P de &N`,
  };

  // ─── Espacio antes del anexo ──────────────────────────────────────────────
  row += 1;
  ws.getRow(row).height = 10;
  row += 1;

  // ─── Anexo fotográfico (placeholder visual: caja vacía rotulada) ──────────
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).value = 'ANEXO FOTOGRÁFICO (insertar fotos del sitio aquí)';
  ws.getCell(`A${row}`).font  = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: COLOR.slate700 } };
  ws.getCell(`A${row}`).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.slate100 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  row += 1;
  ws.getRow(row).height = 120;
  ws.mergeCells(`A${row}:G${row}`);
  ws.getCell(`A${row}`).border = {
    top:    { style: 'dashed', color: { argb: COLOR.slate300 } },
    bottom: { style: 'dashed', color: { argb: COLOR.slate300 } },
    left:   { style: 'dashed', color: { argb: COLOR.slate300 } },
    right:  { style: 'dashed', color: { argb: COLOR.slate300 } },
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
