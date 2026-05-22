/**
 * backend/scripts/ops/generarPlantillaExcel.js
 *
 * Cotización XLSX espejo 1:1 del PDF oficial (COT-914502 / Escuela Benito
 * Juárez). Genera una hoja editable donde el técnico de ACR captura los
 * precios y las fórmulas vivas recalculan Importe / Subtotal / ITBIS /
 * Total Neto al instante.
 *
 * Datos REALES (no placeholder): empresa ACR (RNC 133692678, tels reales,
 * email/web reales), cliente "Escuela Benito Juárez", 12 items con códigos
 * y descripciones EXACTAS del PDF de producción.
 *
 * Espejo visual del PDF:
 *   1. Banda corporate slate-300 3pt
 *   2. Header: logo aspecto 1.79:1 (sin distorsión) + razón social +
 *      "ACR NETWORKS" caps + eslogan italic | corp-meta derecho con
 *      RNC / TEL / EMAIL / WEB en labels caps slate-400
 *   3. Title-bar: COTIZACIÓN 17pt izq + número chip mono 16pt der +
 *      emisión / vence + estado Borrador (slate-50 chip)
 *   4. Cliente: 3 cajas (Razón Social / Contacto / Dirección)
 *   5. Tabla items: 6 cols (# / Código / Descripción / Cant. / Precio Unit. /
 *      Importe) — ITBIS NO va por fila, solo en totales (paridad PDF)
 *   6. Totales: Subtotal · ITBIS · Total Neto (Grand row slate-100)
 *   7. Condiciones generales (legal-note izq) + 3 cajas (Validez / Entrega /
 *      Garantía) con borde izq blue-800
 *   8. Firmas duales con línea
 *   9. Footer print con paginación
 *   10. Watermarks: COTIZACIÓN azul + BORRADOR ámbar apilados rotados -20deg
 *
 * Fórmulas vivas:
 *   · Importe por fila → =D{r}*E{r}
 *   · Subtotal         → =SUM(F{a}:F{b})
 *   · ITBIS (18%)      → =F_subtotal*0.18
 *   · Total Neto       → =F_subtotal+F_itbis
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

// ─── Watermarks (COTIZACIÓN + BORRADOR — paridad PDF .watermark.*) ──────────
async function _watermarkCotizacionPng() {
  // .watermark.cotizacion: #1e40af opacity 0.045, font 110px, weight 900, -20deg.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="280" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 280">
  <g transform="rotate(-20 600 140)">
    <text x="600" y="195"
          text-anchor="middle"
          font-family="Helvetica, 'Helvetica Neue', Arial, sans-serif"
          font-size="170"
          font-weight="900"
          letter-spacing="14"
          fill="#1e40af"
          fill-opacity="0.07">COTIZACIÓN</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function _watermarkBorradorPng() {
  // .estado-Borrador watermark (ámbar tenue del PDF cotizador-libre)
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="280" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 280">
  <g transform="rotate(-20 600 140)">
    <text x="600" y="195"
          text-anchor="middle"
          font-family="Helvetica, 'Helvetica Neue', Arial, sans-serif"
          font-size="140"
          font-weight="900"
          letter-spacing="20"
          fill="#d97706"
          fill-opacity="0.10">BORRADOR</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function construirLibro() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'ACR NETWORKS & SOLUTIONS, S.R.L.';
  wb.company  = 'ACR NETWORKS & SOLUTIONS, S.R.L.';
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
      margins: { left: 0.35, right: 0.35, top: 0.35, bottom: 0.5, header: 0.2, footer: 0.25 },
      horizontalCentered: true,
    },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 105 }],
  });

  // ─── Anchos de columna (proporciones PDF) ─────────────────────────────────
  ws.getColumn('A').width =  5;     // #
  ws.getColumn('B').width = 18;     // Código (códigos largos: CCTV-DAH-HFW1839T)
  ws.getColumn('C').width = 54;     // Descripción (flex)
  ws.getColumn('D').width =  8;     // Cant.
  ws.getColumn('E').width = 14;     // Precio Unit.
  ws.getColumn('F').width = 16;     // Importe

  let row = 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BANDA CORPORATE — 3pt slate-300, full width
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 4;
  ws.mergeCells(`A${row}:F${row}`);
  fillBg(ws.getCell(`A${row}`), COLOR.slate300);
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. HEADER — logo (1.79:1 sin distorsión) + brand + corp-meta
  // ═══════════════════════════════════════════════════════════════════════════
  const headerStartRow = row;

  // Logo: el PNG es 669×373 (aspecto 1.79:1). Para no distorsionarlo le doy
  // 100px ancho × 56px alto. Anchor: arranca arriba-izq de A2 con offset 0.
  const logoBuf = logoBuffer();
  if (logoBuf) {
    const imgId = wb.addImage({ buffer: logoBuf, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: 0, row: headerStartRow - 1 + 0.1 },   // arranca dentro de A2 con pequeño offset
      ext: { width: 100, height: 56 },                   // aspecto exacto 1.79:1
      editAs: 'oneCell',
    });
  }

  // Row 2: razón social (col B-D) | RNC (col E-F rich)
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

  // Row 3: nombre comercial (B-D) | TEL (E-F)
  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.nombreComercial;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 9, bold: true, color: { argb: COLOR.blue800 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'TEL  ',                                                  font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: `${EMPRESA.telefono} / ${EMPRESA.telefono2}`,             font: { name: FONT_MONO, size: 9, color: { argb: COLOR.slate700 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 4: eslogan (B-D italic) | EMAIL (E-F)
  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = EMPRESA.eslogan;
  ws.getCell(`B${row}`).font  = { name: FONT, size: 8, italic: true, color: { argb: COLOR.slate500 } };
  ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'EMAIL  ',     font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.email, font: { name: FONT, size: 9, color: { argb: COLOR.slate700 } } },
    ],
  };
  ws.getCell(`E${row}`).alignment = { horizontal: 'right', vertical: 'middle' };
  row += 1;

  // Row 5: (vacío izq) | WEB
  ws.getRow(row).height = 14;
  ws.mergeCells(`B${row}:D${row}`);
  ws.getCell(`B${row}`).value = '';
  ws.mergeCells(`E${row}:F${row}`);
  ws.getCell(`E${row}`).value = {
    richText: [
      { text: 'WEB  ',           font: { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate400 } } },
      { text: EMPRESA.website,   font: { name: FONT, size: 9, color: { argb: COLOR.blue800 } } },
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
  // 3. TITLE-BAR — COTIZACIÓN izq + número chip + emisión/vence/estado der
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

  // Sub-línea title-bar: estado izq + emisión/vence der
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`A${row}`).value = '';
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
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

  // Estado-stamp: chip slate-50 alineado derecha
  ws.getRow(row).height = 18;
  ws.mergeCells(`A${row}:E${row}`);
  ws.getCell(`A${row}`).value = '';
  ws.getCell(`F${row}`).value = ESTADO;
  ws.getCell(`F${row}`).font  = { name: FONT, size: 8.5, bold: true, color: { argb: COLOR.slate600 } };
  fillBg(ws.getCell(`F${row}`), COLOR.slate50);
  ws.getCell(`F${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
  setBorder(ws.getCell(`F${row}`), { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN });
  row += 1;

  // Spacer post title-bar
  ws.getRow(row).height = 10;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CLIENTE — section-label + 3 cajas grid (Razón / Contacto / Dirección)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'C L I E N T E';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Client-grid labels row
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

  // Client-grid values row
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
  // 5. DETALLE — section-label + tabla 6 cols (mirror exact PDF)
  // ═══════════════════════════════════════════════════════════════════════════
  ws.getRow(row).height = 16;
  ws.mergeCells(`A${row}:F${row}`);
  ws.getCell(`A${row}`).value = 'D E T A L L E   D E   P R O D U C T O S   Y   S E R V I C I O S';
  ws.getCell(`A${row}`).font  = { name: FONT, size: 8, bold: true, color: { argb: COLOR.slate600 } };
  ws.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getCell(`A${row}`).border = { bottom: { style: 'hair', color: { argb: COLOR.slate200 } } };
  row += 1;

  // Header tabla (thead PDF: slate-100 bg, caps slate-700)
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

  // Items con datos REALES + fórmulas vivas en Importe
  const firstItemRow = row;
  ITEMS.forEach((it, i) => {
    const hasDetalle = !!it.detalle;
    ws.getRow(row).height = hasDetalle ? 38 : 26;

    // # (auto-numerado, mono slate-400)
    ws.getCell(`A${row}`).value = i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate400 } };
    ws.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(`A${row}`).numFmt = '00';

    // Código (mono bold slate-800, wrap por si es largo)
    ws.getCell(`B${row}`).value = it.codigo;
    ws.getCell(`B${row}`).font  = { name: FONT_MONO, size: 9, bold: true, color: { argb: COLOR.slate800 } };
    ws.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };

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

    // Precio Unit. (editable, mono right) — arranca en 0 (borrador)
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
  const lastItemRow = row - 1;

  // 3 filas vacías para expansión (con fórmulas pre-cargadas)
  for (let i = 0; i < 3; i += 1) {
    ws.getRow(row).height = 22;
    ws.getCell(`A${row}`).value = ITEMS.length + i + 1;
    ws.getCell(`A${row}`).font  = { name: FONT_MONO, size: 9, color: { argb: COLOR.slate300 } };
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

  // ─── Watermarks COTIZACIÓN + BORRADOR flotantes (paridad PDF) ─────────────
  const wmCotPng = await _watermarkCotizacionPng();
  const wmBorPng = await _watermarkBorradorPng();
  const wmCotId  = wb.addImage({ buffer: wmCotPng, extension: 'png' });
  const wmBorId  = wb.addImage({ buffer: wmBorPng, extension: 'png' });
  // COTIZACIÓN un poco arriba, BORRADOR debajo
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
  // 6. TOTALES — D-E labels + F valor mono (paridad PDF totals 280px)
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
  // 7. CONDICIONES GENERALES — caja izq (legal note) + 3 cajas der (paridad PDF)
  // ═══════════════════════════════════════════════════════════════════════════
  // Caja superior: bloque legal-note ocupando A-F
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

  // 3 cajas: Validez / Entrega / Garantía con borde izquierdo blue-800 thick
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

  // Spacer
  ws.getRow(row).height = 28;
  row += 1;

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. FIRMAS — 2 cols con línea + nombre caps + rol
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
  // 9. FOOTER PRINT
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
