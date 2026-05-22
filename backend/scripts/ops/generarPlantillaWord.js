/**
 * backend/scripts/ops/generarPlantillaWord.js
 *
 * Generador de plantilla DOCX editable offline (Cotización RA Networks & Solutions).
 * Hereda la maquetación del template PDF oficial: membrete superior centralizado,
 * espaciado compacto antes de la tabla, tabla 12 filas iniciales abierta para
 * expansión, pie de página unificado con espacio delimitado para anexo fotográfico.
 *
 * Cuándo usar: respaldo offline editable a mano cuando el técnico necesita
 * cotizar en Word y entregar PDF impreso desde el mismo equipo sin acceso al ERP.
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.docx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaWord.js
 */

const path = require('path');
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle,
  Header, Footer, PageNumber, ShadingType, HeightRule,
  TabStopType, TabStopPosition, PageBreak,
} = require('docx');

// ─── Paleta corporativa (hex) ───────────────────────────────────────────────
const COLOR = {
  slate900: '0F172A',
  slate800: '1E293B',
  slate700: '334155',
  slate600: '475569',
  slate500: '64748B',
  slate400: '94A3B8',
  slate300: 'CBD5E1',
  slate200: 'E2E8F0',
  slate100: 'F1F5F9',
  slate50:  'F8FAFC',
  blue800:  '1E40AF',
  white:    'FFFFFF',
};

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

const FILAS_INICIALES = 12;

function _hoyISO() {
  return new Date().toISOString().slice(0, 10);
}
function _plus30() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

// ─── Helpers de borde de celda ──────────────────────────────────────────────
const BORDER_HAIR = (color = COLOR.slate200) => ({
  style: BorderStyle.SINGLE, size: 4, color,
});
const BORDER_THICK = (color = COLOR.slate400) => ({
  style: BorderStyle.SINGLE, size: 12, color,
});
const ALL_BORDERS_HAIR = {
  top:    BORDER_HAIR(),
  bottom: BORDER_HAIR(),
  left:   BORDER_HAIR(),
  right:  BORDER_HAIR(),
};

// Texto run conciso (default body + overrides).
function R(text, opts = {}) {
  return new TextRun({
    text: String(text ?? ''),
    font: opts.font ?? 'Calibri',
    size: opts.size ?? 20,                  // half-points (20 = 10pt)
    bold: !!opts.bold,
    italics: !!opts.italics,
    color: opts.color ?? COLOR.slate900,
    allCaps: !!opts.caps,
    characterSpacing: opts.spacing ?? 0,
  });
}

// Párrafo conciso.
function P(children, opts = {}) {
  return new Paragraph({
    alignment: opts.align ?? AlignmentType.LEFT,
    spacing:   { before: opts.before ?? 0, after: opts.after ?? 0, line: opts.line ?? 240 },
    children:  Array.isArray(children) ? children : [children],
    heading:   opts.heading,
  });
}

// Celda con shading + borde uniforme.
function cell(children, opts = {}) {
  return new TableCell({
    children: Array.isArray(children) ? children : [children],
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120, ...(opts.margins ?? {}) },
    borders: opts.borders ?? ALL_BORDERS_HAIR,
    verticalAlign: opts.vAlign ?? 'center',
    columnSpan: opts.span,
  });
}

// ─── Header: membrete superior centralizado ─────────────────────────────────
function buildHeader() {
  return new Header({
    children: [
      P(R(EMPRESA.razonSocial, { size: 28, bold: true, color: COLOR.slate900 }), {
        align: AlignmentType.CENTER,
        after: 30,
      }),
      P(R(EMPRESA.nombreComercial, { size: 16, bold: true, color: COLOR.blue800, spacing: 24 }), {
        align: AlignmentType.CENTER,
        after: 30,
      }),
      P(R(EMPRESA.tagline, { size: 14, italics: true, color: COLOR.slate500 }), {
        align: AlignmentType.CENTER,
        after: 60,
      }),
      P([
        R(`RNC ${EMPRESA.rnc}  ·  ${EMPRESA.direccion}`, { size: 14, color: COLOR.slate600 }),
      ], { align: AlignmentType.CENTER, after: 30 }),
      P([
        R(`${EMPRESA.telefono}  ·  ${EMPRESA.email}  ·  ${EMPRESA.website}`, { size: 14, color: COLOR.slate600 }),
      ], { align: AlignmentType.CENTER, after: 80 }),
      // Línea divisora (border-bottom de párrafo)
      new Paragraph({
        border: {
          bottom: { color: COLOR.slate300, space: 4, style: BorderStyle.SINGLE, size: 6 },
        },
        children: [],
      }),
    ],
  });
}

// ─── Footer: pie unificado + espacio delimitado para anexo fotográfico ──────
function buildFooter() {
  return new Footer({
    children: [
      // Línea divisora superior
      new Paragraph({
        border: {
          top: { color: COLOR.slate300, space: 4, style: BorderStyle.SINGLE, size: 6 },
        },
        spacing: { before: 0, after: 80 },
        children: [],
      }),
      P([
        R(EMPRESA.razonSocial, { size: 14, bold: true, color: COLOR.slate700 }),
        R('  ·  ', { size: 14, color: COLOR.slate400 }),
        R(`RNC ${EMPRESA.rnc}`, { size: 14, color: COLOR.slate600 }),
        R('  ·  ', { size: 14, color: COLOR.slate400 }),
        R('Plantilla offline editable', { size: 14, color: COLOR.slate600 }),
      ], { align: AlignmentType.CENTER, after: 30 }),
      P([
        R('Página ', { size: 12, color: COLOR.slate500 }),
        new TextRun({ children: [PageNumber.CURRENT], size: 12, color: COLOR.slate500 }),
        R(' de ', { size: 12, color: COLOR.slate500 }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 12, color: COLOR.slate500 }),
        R(`  ·  ${EMPRESA.website}`, { size: 12, color: COLOR.blue800 }),
      ], { align: AlignmentType.CENTER }),
    ],
  });
}

// ─── Title-bar: COTIZACIÓN ──────────────────────────────────────────────────
function buildTitleBar() {
  const tbl = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: COLOR.slate200 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.slate200 },
      left:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      right:  { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
    },
    rows: [
      new TableRow({
        height: { value: 600, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 },
            margins: { top: 120, bottom: 120, left: 200, right: 200 },
            verticalAlign: 'center',
            children: [
              P(R('COTIZACIÓN', {
                size: 36, bold: true, color: COLOR.slate900, spacing: 36,
              }), { align: AlignmentType.CENTER }),
              P(R('Plantilla Manual · Edición Offline', {
                size: 14, color: COLOR.slate500, spacing: 20,
              }), { align: AlignmentType.CENTER }),
            ],
          }),
        ],
      }),
    ],
  });
  return tbl;
}

// ─── Datos del cliente (table 4 cols: lbl-val-lbl-val × 5 rows) ─────────────
function buildClienteBlock() {
  const filas = [
    ['Razón Social',  '',           'No. Cotización', 'COT-MANUAL-001'],
    ['RNC / Cédula',  '',           'Fecha Emisión',  _hoyISO()],
    ['Dirección',     '',           'Válida Hasta',   _plus30()],
    ['Teléfono',      '',           'Atención',       ''],
    ['Email',         '',           'Proyecto',       ''],
  ];

  const labelCell = (txt) => cell(
    P(R(txt, { size: 14, bold: true, color: COLOR.slate500, caps: true, spacing: 24 })),
    { width: 1800, fill: COLOR.slate50 }
  );
  const valCell = (txt) => cell(
    P(R(txt, { size: 20, bold: true, color: COLOR.slate900 })),
    { width: 3600 }
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: filas.map(([l1, v1, l2, v2]) => new TableRow({
      height: { value: 380, rule: HeightRule.ATLEAST },
      children: [labelCell(l1), valCell(v1), labelCell(l2), valCell(v2)],
    })),
  });
}

// ─── Tabla items (header + 12 filas vacías) ─────────────────────────────────
function buildItemsTable() {
  const headers = ['Ítems', 'Código / Modelo', 'Descripción Técnica', 'Cantidad', 'Precio Unit. (RD$)', 'ITBIS (18%)', 'Importe (RD$)'];
  const widths  = [600, 1500, 4000, 900, 1500, 1300, 1500];

  const headerCells = headers.map((h, i) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 },
    margins: { top: 100, bottom: 100, left: 100, right: 100 },
    verticalAlign: 'center',
    borders: {
      top:    BORDER_HAIR(COLOR.slate300),
      bottom: BORDER_THICK(COLOR.slate300),
      left:   BORDER_HAIR(COLOR.slate200),
      right:  BORDER_HAIR(COLOR.slate200),
    },
    children: [P(R(h, { size: 16, bold: true, color: COLOR.slate700, caps: true, spacing: 20 }), {
      align: i <= 2 ? AlignmentType.LEFT : (i === 3 ? AlignmentType.CENTER : AlignmentType.RIGHT),
    })],
  }));

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 480, rule: HeightRule.ATLEAST },
    children: headerCells,
  });

  const dataRows = Array.from({ length: FILAS_INICIALES }, (_, i) => new TableRow({
    height: { value: 380, rule: HeightRule.ATLEAST },
    children: widths.map((w, ci) => new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: i % 2 === 1 ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 } : undefined,
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
      verticalAlign: 'center',
      borders: ALL_BORDERS_HAIR,
      children: [P(R(ci === 0 ? String(i + 1) : '', {
        size: 18, color: ci === 0 ? COLOR.slate500 : COLOR.slate900,
      }), {
        align: ci <= 2 ? AlignmentType.LEFT : (ci === 3 ? AlignmentType.CENTER : AlignmentType.RIGHT),
      })],
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

// ─── Bloque Totales (alineado a la derecha) ─────────────────────────────────
function buildTotalesBlock() {
  const filas = [
    ['Subtotal',     '',  false],
    ['ITBIS (18%)',  '',  false],
    ['Total Neto',   '',  true ],
  ];
  return new Table({
    width: { size: 50, type: WidthType.PERCENTAGE },
    alignment: AlignmentType.RIGHT,
    rows: filas.map(([lbl, val, grand]) => new TableRow({
      height: { value: grand ? 520 : 380, rule: HeightRule.ATLEAST },
      children: [
        new TableCell({
          shading: grand
            ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 }
            : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          verticalAlign: 'center',
          borders: {
            top:    grand ? BORDER_THICK() : BORDER_HAIR(),
            bottom: BORDER_HAIR(),
            left:   BORDER_HAIR(),
            right:  BORDER_HAIR(),
          },
          children: [P(R(lbl, {
            size: grand ? 22 : 16,
            bold: true,
            color: grand ? COLOR.slate900 : COLOR.slate600,
            caps: !grand,
            spacing: 20,
          }), { align: AlignmentType.RIGHT })],
        }),
        new TableCell({
          shading: grand
            ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 }
            : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          verticalAlign: 'center',
          borders: {
            top:    grand ? BORDER_THICK() : BORDER_HAIR(),
            bottom: BORDER_HAIR(),
            left:   BORDER_HAIR(),
            right:  BORDER_HAIR(),
          },
          children: [P(R(val || 'RD$ 0.00', {
            size: grand ? 26 : 18,
            bold: true,
            color: COLOR.slate900,
            font: 'Consolas',
          }), { align: AlignmentType.RIGHT })],
        }),
      ],
    })),
  });
}

// ─── Condiciones + firmas ───────────────────────────────────────────────────
function buildCondiciones() {
  const condiciones = [
    'Esta cotización tiene carácter informativo y no constituye documento fiscal.',
    'Los precios pueden estar sujetos a cambio sin previo aviso fuera del período de validez (30 días desde la fecha de emisión).',
    'Para emisión de factura formal se requiere confirmación por escrito.',
    'Tiempo de entrega: a confirmar contra disponibilidad de stock al momento de la orden de compra.',
    'Forma de pago: 50% al confirmar la orden / 50% contra entrega — salvo acuerdo distinto por escrito.',
  ];
  return [
    P(R('CONDICIONES GENERALES', { size: 16, bold: true, color: COLOR.slate700, caps: true, spacing: 32 }), {
      before: 240, after: 80,
    }),
    ...condiciones.map((c) =>
      P([
        R('·  ', { size: 16, color: COLOR.slate400, bold: true }),
        R(c, { size: 16, color: COLOR.slate600 }),
      ], { after: 40, line: 280 })
    ),
  ];
}

function buildFirmas() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:    { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      bottom: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      left:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      right:  { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
    },
    rows: [
      new TableRow({
        height: { value: 1400, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            verticalAlign: 'bottom',
            borders: {
              top:    { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              left:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              right:  { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              bottom: { style: BorderStyle.SINGLE, size: 12, color: COLOR.slate900 },
            },
            children: [P(R(' '))],
          }),
          new TableCell({
            borders: {
              top:    { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              bottom: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              left:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              right:  { style: BorderStyle.NONE, size: 0, color: COLOR.white },
            },
            children: [P(R(' '))],
            width: { size: 1000, type: WidthType.DXA },
          }),
          new TableCell({
            verticalAlign: 'bottom',
            borders: {
              top:    { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              left:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              right:  { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              bottom: { style: BorderStyle.SINGLE, size: 12, color: COLOR.slate900 },
            },
            children: [P(R(' '))],
          }),
        ],
      }),
      new TableRow({
        height: { value: 320, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            borders: {
              top: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              bottom: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              left: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              right: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
            },
            children: [
              P(R('ACEPTACIÓN DEL CLIENTE', { size: 16, bold: true, color: COLOR.slate900, caps: true, spacing: 20 }), { align: AlignmentType.CENTER, after: 30 }),
              P(R('Firma · Sello · Fecha', { size: 13, color: COLOR.slate500 }), { align: AlignmentType.CENTER }),
            ],
          }),
          new TableCell({
            borders: {
              top: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              bottom: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              left: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              right: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
            },
            children: [P(R(' '))],
            width: { size: 1000, type: WidthType.DXA },
          }),
          new TableCell({
            borders: {
              top: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              bottom: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              left: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
              right: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
            },
            children: [
              P(R(`${EMPRESA.razonSocial}`, { size: 16, bold: true, color: COLOR.slate900 }), { align: AlignmentType.CENTER, after: 30 }),
              P(R('Representante Autorizado · Firma · Sello', { size: 13, color: COLOR.slate500 }), { align: AlignmentType.CENTER }),
            ],
          }),
        ],
      }),
    ],
  });
}

// ─── Anexo fotográfico: espacio delimitado (caja punteada placeholder) ──────
function buildAnexoFotografico() {
  const anexoTitle = P(R('ANEXO FOTOGRÁFICO', {
    size: 22, bold: true, color: COLOR.slate900, caps: true, spacing: 40,
  }), { align: AlignmentType.CENTER, after: 80 });

  const anexoSub = P(R('Insertar fotografías del sitio · Levantamiento técnico previo a la instalación', {
    size: 14, italics: true, color: COLOR.slate500,
  }), { align: AlignmentType.CENTER, after: 240 });

  // Grid 2×2 con cajas delimitadas
  const slotCell = () => new TableCell({
    width: { size: 4500, type: WidthType.DXA },
    margins: { top: 200, bottom: 200, left: 200, right: 200 },
    verticalAlign: 'center',
    borders: {
      top:    { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
      bottom: { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
      left:   { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
      right:  { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
    },
    children: [
      P(R('[ FOTO ]', { size: 16, bold: true, color: COLOR.slate400, caps: true, spacing: 40 }), { align: AlignmentType.CENTER, after: 60 }),
      P(R('Insertar imagen aquí', { size: 12, color: COLOR.slate400, italics: true }), { align: AlignmentType.CENTER, after: 60 }),
      P(R('—', { size: 12, color: COLOR.slate300 }), { align: AlignmentType.CENTER, after: 600 }),
      P(R('Pie de foto / ubicación', { size: 11, color: COLOR.slate500 }), { align: AlignmentType.CENTER }),
    ],
  });

  const grid = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:    { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      bottom: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      left:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      right:  { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: COLOR.white },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: COLOR.white },
    },
    rows: [
      new TableRow({ children: [slotCell(), slotCell()] }),
      new TableRow({ children: [slotCell(), slotCell()] }),
    ],
  });

  return [
    new Paragraph({ children: [new PageBreak()] }),
    anexoTitle,
    anexoSub,
    grid,
  ];
}

// ─── Documento completo ─────────────────────────────────────────────────────
function construirDocumento() {
  return new Document({
    creator: 'ACR Networks & Solutions',
    title:   'Cotización Manual RA',
    description: 'Plantilla editable offline alineada al template PDF corporativo.',
    styles: {
      default: {
        document: {
          run:       { font: 'Calibri', size: 20, color: COLOR.slate900 },
          paragraph: { spacing: { line: 260 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 720, bottom: 720, left: 720, right: 720, header: 360, footer: 360 },
          size:   { width: 12240, height: 15840 },        // Letter (DXA)
        },
      },
      headers: { default: buildHeader() },
      footers: { default: buildFooter() },
      children: [
        // Espaciado compacto entre header y title-bar
        new Paragraph({ children: [], spacing: { before: 0, after: 80 } }),
        buildTitleBar(),
        // Espaciado compacto antes del bloque cliente
        new Paragraph({ children: [], spacing: { before: 0, after: 120 } }),
        P(R('DATOS DEL CLIENTE', { size: 14, bold: true, color: COLOR.slate600, caps: true, spacing: 30 }), { after: 60 }),
        buildClienteBlock(),
        // Espaciado compacto antes de la tabla
        new Paragraph({ children: [], spacing: { before: 0, after: 160 } }),
        P(R('DETALLE DE PRODUCTOS Y SERVICIOS', { size: 14, bold: true, color: COLOR.slate600, caps: true, spacing: 30 }), { after: 60 }),
        buildItemsTable(),
        // Espaciado compacto antes de totales
        new Paragraph({ children: [], spacing: { before: 0, after: 160 } }),
        buildTotalesBlock(),
        // Condiciones generales
        ...buildCondiciones(),
        // Espaciado antes de firmas
        new Paragraph({ children: [], spacing: { before: 240, after: 240 } }),
        buildFirmas(),
        // Anexo fotográfico (nueva página, dentro del MISMO section -> header/footer corporativo se hereda)
        ...buildAnexoFotografico(),
      ],
    }],
  });
}

async function main() {
  const doc = construirDocumento();
  const outPath = path.resolve(__dirname, '..', '..', '..', 'Plantilla_Cotizacion_Manual_RA.docx');
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
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

module.exports = { construirDocumento };
