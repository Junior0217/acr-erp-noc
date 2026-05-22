/**
 * backend/scripts/ops/generarPlantillaWord.js
 *
 * Plantilla DOCX editable con datos demo COMPLETOS (paridad con el PDF
 * generado por el pipeline oficial). Construida con la librería `docx`
 * para producir un OOXML válido que Word abre limpio sin warning de
 * conversión (a diferencia del approach Office-HTML del ciclo anterior).
 *
 * Contenido: empresa real con logo embebido, datos del cliente, fechas,
 * número, 8 items pre-llenados con cálculos, totales reales, 4 cajas de
 * condiciones (validez, pago, entrega, garantía), bloque de notas del
 * proyecto, firmas duales y anexo fotográfico 2×2 con page-break previo.
 *
 * Salida: Plantilla_Cotizacion_Manual_RA.docx en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarPlantillaWord.js
 */

const path = require('path');
const fs   = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle,
  Header, Footer, PageNumber, ShadingType, HeightRule,
  ImageRun, PageBreak, VerticalAlign,
} = require('docx');

const {
  EMPRESA, CLIENTE, ITEMS, NUMERO,
  CONDICIONES, NOTAS,
  calcular, fechaEmision, fechaVence, fechaISO,
  logoBuffer,
} = require('./_demoCotizacion');

// ─── Paleta (hex sin prefijo, formato docx) ─────────────────────────────────
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

// ─── Helpers ────────────────────────────────────────────────────────────────
function R(text, opts = {}) {
  return new TextRun({
    text: String(text ?? ''),
    font: opts.font ?? 'Calibri',
    size: opts.size ?? 20,           // half-points → 20 = 10pt
    bold: !!opts.bold,
    italics: !!opts.italics,
    color: opts.color ?? COLOR.slate900,
    allCaps: !!opts.caps,
    characterSpacing: opts.spacing ?? 0,
    underline: opts.underline ? { type: 'single', color: opts.color ?? COLOR.slate900 } : undefined,
  });
}

function P(children, opts = {}) {
  return new Paragraph({
    alignment: opts.align ?? AlignmentType.LEFT,
    spacing: { before: opts.before ?? 0, after: opts.after ?? 0, line: opts.line ?? 240 },
    children: Array.isArray(children) ? children : [children],
    heading: opts.heading,
  });
}

const BORDER_HAIR  = (color = COLOR.slate200) => ({ style: BorderStyle.SINGLE, size: 4,  color });
const BORDER_THIN  = (color = COLOR.slate200) => ({ style: BorderStyle.SINGLE, size: 6,  color });
const BORDER_MED   = (color = COLOR.slate300) => ({ style: BorderStyle.SINGLE, size: 8,  color });
const BORDER_THICK = (color = COLOR.slate400) => ({ style: BorderStyle.SINGLE, size: 12, color });
const BORDER_NONE  = { style: BorderStyle.NONE, size: 0, color: COLOR.white };
const ALL_HAIR     = { top: BORDER_HAIR(), bottom: BORDER_HAIR(), left: BORDER_HAIR(), right: BORDER_HAIR() };
const ALL_NONE     = { top: BORDER_NONE, bottom: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE };

function cell(children, opts = {}) {
  return new TableCell({
    children: Array.isArray(children) ? children : [children],
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120, ...(opts.margins ?? {}) },
    borders: opts.borders ?? ALL_HAIR,
    verticalAlign: opts.vAlign ?? VerticalAlign.CENTER,
    columnSpan: opts.span,
  });
}

function fmtMoney(n) {
  return new Intl.NumberFormat('es-DO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);
}

// ─── Header: logo + razón social/comercial/eslogan + RNC/dirección ──────────
function buildHeader() {
  const logoBuf = logoBuffer();

  const brandRuns = [
    R(EMPRESA.razonSocial, { size: 28, bold: true, color: COLOR.slate900 }),
  ];
  const commercialPara = P(
    R(EMPRESA.nombreComercial, { size: 16, bold: true, color: COLOR.blue800, caps: true, spacing: 24 }),
    { align: AlignmentType.LEFT, after: 30 }
  );
  const sloganPara = P(
    R(EMPRESA.eslogan, { size: 14, italics: true, color: COLOR.slate500 }),
    { align: AlignmentType.LEFT, after: 30 }
  );

  // Header table: logo izq (1500) | brand (5000) | corp-meta (4500)
  const headerTbl = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      ...ALL_NONE,
      insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE,
    },
    rows: [
      new TableRow({
        height: { value: 1600, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: 1500, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            borders: ALL_NONE,
            children: logoBuf ? [
              new Paragraph({
                alignment: AlignmentType.LEFT,
                children: [new ImageRun({
                  data: logoBuf,
                  transformation: { width: 70, height: 70 },
                })],
              }),
            ] : [P(R(' '))],
          }),
          new TableCell({
            width: { size: 5000, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            borders: ALL_NONE,
            children: [
              P(brandRuns, { align: AlignmentType.LEFT, after: 30 }),
              commercialPara,
              sloganPara,
            ],
          }),
          new TableCell({
            width: { size: 4500, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            borders: ALL_NONE,
            children: [
              P([
                R('RNC  ',          { size: 13, color: COLOR.slate400, caps: true, bold: true, spacing: 30 }),
                R(EMPRESA.rnc,      { size: 18, color: COLOR.slate900, bold: true, font: 'Consolas' }),
              ], { align: AlignmentType.RIGHT, after: 40 }),
              P(R(EMPRESA.direccion, { size: 14, color: COLOR.slate700 }),
                { align: AlignmentType.RIGHT, after: 30, line: 240 }),
              P([
                R('Tel.  ', { size: 13, color: COLOR.slate400, caps: true, bold: true, spacing: 20 }),
                R(EMPRESA.telefono, { size: 14, color: COLOR.slate700, font: 'Consolas' }),
              ], { align: AlignmentType.RIGHT, after: 20 }),
              P(R(EMPRESA.email, { size: 14, color: COLOR.slate700 }),
                { align: AlignmentType.RIGHT, after: 20 }),
              P(R(EMPRESA.website, { size: 14, color: COLOR.blue800, bold: true }),
                { align: AlignmentType.RIGHT }),
            ],
          }),
        ],
      }),
    ],
  });

  return new Header({
    children: [
      // Banda corporate
      new Paragraph({
        spacing: { before: 0, after: 0 },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate300 },
        children: [R(' ', { size: 4 })],
      }),
      headerTbl,
      // Línea hairline inferior
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.slate200, space: 1 } },
        spacing: { before: 0, after: 0 },
        children: [],
      }),
    ],
  });
}

// ─── Footer corporativo ─────────────────────────────────────────────────────
function buildFooter() {
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: COLOR.slate200, space: 4 } },
        spacing: { before: 0, after: 60 },
        children: [],
      }),
      P([
        R(EMPRESA.razonSocial, { size: 14, bold: true, color: COLOR.slate700 }),
        R('  ·  ', { size: 14, color: COLOR.slate400 }),
        R(`RNC ${EMPRESA.rnc}`, { size: 14, color: COLOR.slate600, font: 'Consolas' }),
        R('  ·  ', { size: 14, color: COLOR.slate400 }),
        R('Documento Electrónico Verificable', { size: 12, color: COLOR.slate600, italics: true }),
      ], { align: AlignmentType.CENTER, after: 30 }),
      P([
        R('Página ', { size: 12, color: COLOR.slate500 }),
        new TextRun({ children: [PageNumber.CURRENT], size: 12, color: COLOR.slate500 }),
        R(' de ', { size: 12, color: COLOR.slate500 }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 12, color: COLOR.slate500 }),
        R('  ·  ', { size: 12, color: COLOR.slate400 }),
        R(EMPRESA.website, { size: 12, color: COLOR.blue800, bold: true }),
      ], { align: AlignmentType.CENTER }),
    ],
  });
}

// ─── Title-bar ──────────────────────────────────────────────────────────────
function buildTitleBar() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:    BORDER_HAIR(),
      bottom: BORDER_HAIR(),
      left:   BORDER_NONE,
      right:  BORDER_NONE,
      insideHorizontal: BORDER_NONE,
      insideVertical:   BORDER_NONE,
    },
    rows: [
      new TableRow({
        height: { value: 700, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: 60, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 },
            margins: { top: 160, bottom: 80, left: 240, right: 100 },
            verticalAlign: VerticalAlign.CENTER,
            borders: ALL_NONE,
            children: [
              P(R('COTIZACIÓN', { size: 36, bold: true, color: COLOR.slate800, caps: true, spacing: 40 }),
                { align: AlignmentType.LEFT, after: 30 }),
              P(R('Documento Electrónico Verificable', { size: 14, color: COLOR.slate500, italics: true, spacing: 20 }),
                { align: AlignmentType.LEFT }),
            ],
          }),
          new TableCell({
            width: { size: 40, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 },
            margins: { top: 160, bottom: 80, left: 100, right: 240 },
            verticalAlign: VerticalAlign.CENTER,
            borders: ALL_NONE,
            children: [
              P(R(NUMERO, { size: 30, bold: true, color: COLOR.slate900, font: 'Consolas' }),
                { align: AlignmentType.RIGHT, after: 60 }),
              P([
                R('Emisión: ',  { size: 14, color: COLOR.slate400, caps: true, bold: true }),
                R(fechaISO(fechaEmision()), { size: 16, color: COLOR.slate900, bold: true, font: 'Consolas' }),
              ], { align: AlignmentType.RIGHT, after: 20 }),
              P([
                R('Válida hasta: ', { size: 14, color: COLOR.slate400, caps: true, bold: true }),
                R(fechaISO(fechaVence()), { size: 16, color: COLOR.slate900, bold: true, font: 'Consolas' }),
              ], { align: AlignmentType.RIGHT }),
            ],
          }),
        ],
      }),
    ],
  });
}

// ─── Cliente block ──────────────────────────────────────────────────────────
function buildClienteBlock() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        height: { value: 320, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: 42, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 },
            margins: { top: 140, bottom: 140, left: 200, right: 200 },
            verticalAlign: VerticalAlign.TOP,
            borders: ALL_HAIR,
            children: [
              P(R('RAZÓN SOCIAL', { size: 13, bold: true, color: COLOR.slate500, caps: true, spacing: 26 }), { after: 50 }),
              P(R(CLIENTE.razonSocial, { size: 22, bold: true, color: COLOR.slate900 }), { after: 40 }),
              P([
                R('Cliente #: ', { size: 14, color: COLOR.slate400, bold: true }),
                R(CLIENTE.noCliente, { size: 14, color: COLOR.slate600, font: 'Consolas' }),
              ], { after: 20 }),
              P(R(CLIENTE.contacto, { size: 14, color: COLOR.slate600 })),
            ],
          }),
          new TableCell({
            width: { size: 28, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 },
            margins: { top: 140, bottom: 140, left: 200, right: 200 },
            verticalAlign: VerticalAlign.TOP,
            borders: ALL_HAIR,
            children: [
              P(R('RNC / CONTACTO', { size: 13, bold: true, color: COLOR.slate500, caps: true, spacing: 26 }), { after: 50 }),
              P(R(CLIENTE.rnc, { size: 22, bold: true, color: COLOR.slate900, font: 'Consolas' }), { after: 40 }),
              P([
                R('Tel.  ', { size: 14, color: COLOR.slate400, bold: true }),
                R(CLIENTE.telefono, { size: 14, color: COLOR.slate600, font: 'Consolas' }),
              ]),
            ],
          }),
          new TableCell({
            width: { size: 30, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 },
            margins: { top: 140, bottom: 140, left: 200, right: 200 },
            verticalAlign: VerticalAlign.TOP,
            borders: ALL_HAIR,
            children: [
              P(R('DIRECCIÓN', { size: 13, bold: true, color: COLOR.slate500, caps: true, spacing: 26 }), { after: 50 }),
              P(R(CLIENTE.direccion, { size: 16, color: COLOR.slate800, bold: true }), { after: 40, line: 260 }),
              P(R(CLIENTE.email, { size: 14, color: COLOR.slate600 })),
            ],
          }),
        ],
      }),
    ],
  });
}

// ─── Items table ────────────────────────────────────────────────────────────
function buildItemsTable() {
  const headers = [
    { txt: '#',                    w: 500,  align: AlignmentType.CENTER },
    { txt: 'Código',               w: 1500, align: AlignmentType.LEFT   },
    { txt: 'Descripción',          w: 4400, align: AlignmentType.LEFT   },
    { txt: 'Cant.',                w: 700,  align: AlignmentType.CENTER },
    { txt: 'Precio Unit. (RD$)',   w: 1400, align: AlignmentType.RIGHT  },
    { txt: 'ITBIS (18%)',          w: 1200, align: AlignmentType.RIGHT  },
    { txt: 'Importe (RD$)',        w: 1500, align: AlignmentType.RIGHT  },
  ];

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 480, rule: HeightRule.ATLEAST },
    children: headers.map((h) => new TableCell({
      width: { size: h.w, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 },
      margins: { top: 120, bottom: 120, left: 100, right: 100 },
      verticalAlign: VerticalAlign.CENTER,
      borders: {
        top: BORDER_HAIR(COLOR.slate300),
        bottom: BORDER_MED(COLOR.slate300),
        left: BORDER_HAIR(),
        right: BORDER_HAIR(),
      },
      children: [P(R(h.txt, { size: 16, bold: true, color: COLOR.slate700, caps: true, spacing: 20 }),
        { align: h.align })],
    })),
  });

  const dataRows = ITEMS.map((it, i) => {
    const importe = it.cantidad * it.precioUnitario;
    const itbis   = importe * 0.18;
    const zebra   = i % 2 === 1;
    const shading = zebra ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 } : undefined;

    return new TableRow({
      height: { value: 520, rule: HeightRule.ATLEAST },
      children: [
        new TableCell({
          width: { size: headers[0].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 80, right: 80 },
          verticalAlign: VerticalAlign.TOP,
          borders: ALL_HAIR,
          children: [P(R(String(i + 1).padStart(2, '0'), { size: 18, color: COLOR.slate400, font: 'Consolas' }),
            { align: AlignmentType.CENTER })],
        }),
        new TableCell({
          width: { size: headers[1].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 100, right: 100 },
          verticalAlign: VerticalAlign.TOP,
          borders: ALL_HAIR,
          children: [P(R(it.codigo, { size: 17, bold: true, color: COLOR.slate800, font: 'Consolas' }),
            { align: AlignmentType.LEFT })],
        }),
        new TableCell({
          width: { size: headers[2].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 100, right: 100 },
          verticalAlign: VerticalAlign.TOP,
          borders: ALL_HAIR,
          children: [
            P(R(it.descripcion, { size: 20, bold: true, color: COLOR.slate900 }), { align: AlignmentType.LEFT, after: 30 }),
            ...(it.detalle ? [P(R(it.detalle, { size: 16, color: COLOR.slate500, italics: true }), { align: AlignmentType.LEFT, line: 240 })] : []),
          ],
        }),
        new TableCell({
          width: { size: headers[3].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 80, right: 80 },
          verticalAlign: VerticalAlign.CENTER,
          borders: ALL_HAIR,
          children: [P(R(String(it.cantidad), { size: 18, color: COLOR.slate900, font: 'Consolas' }),
            { align: AlignmentType.CENTER })],
        }),
        new TableCell({
          width: { size: headers[4].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 100, right: 100 },
          verticalAlign: VerticalAlign.CENTER,
          borders: ALL_HAIR,
          children: [P(R(fmtMoney(it.precioUnitario), { size: 18, color: COLOR.slate900, font: 'Consolas' }),
            { align: AlignmentType.RIGHT })],
        }),
        new TableCell({
          width: { size: headers[5].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 100, right: 100 },
          verticalAlign: VerticalAlign.CENTER,
          borders: ALL_HAIR,
          children: [P(R(fmtMoney(itbis), { size: 17, color: COLOR.slate700, font: 'Consolas' }),
            { align: AlignmentType.RIGHT })],
        }),
        new TableCell({
          width: { size: headers[6].w, type: WidthType.DXA },
          shading,
          margins: { top: 100, bottom: 100, left: 100, right: 100 },
          verticalAlign: VerticalAlign.CENTER,
          borders: ALL_HAIR,
          children: [P(R(fmtMoney(importe), { size: 19, bold: true, color: COLOR.slate900, font: 'Consolas' }),
            { align: AlignmentType.RIGHT })],
        }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: BORDER_THIN(COLOR.slate300),
      bottom: BORDER_THIN(COLOR.slate300),
      left: BORDER_THIN(COLOR.slate300),
      right: BORDER_THIN(COLOR.slate300),
      insideHorizontal: BORDER_HAIR(),
      insideVertical: BORDER_HAIR(),
    },
    rows: [headerRow, ...dataRows],
  });
}

// ─── Totales wrap (legal-note izq + totals der) ─────────────────────────────
function buildTotalesWrap() {
  const { subtotal, itbis, total } = calcular(ITEMS);

  const legalCell = new TableCell({
    width: { size: 58, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 },
    margins: { top: 200, bottom: 200, left: 240, right: 240 },
    verticalAlign: VerticalAlign.TOP,
    borders: ALL_HAIR,
    children: [
      P(R('CONDICIONES GENERALES', { size: 15, bold: true, color: COLOR.slate900, caps: true, spacing: 20 }),
        { after: 80 }),
      P(R(
        'Esta cotización tiene carácter informativo y no constituye documento fiscal. Los ' +
        'precios pueden estar sujetos a cambio sin previo aviso fuera del período de validez ' +
        '(30 días desde la emisión). Para emisión de factura formal se requiere confirmación ' +
        'por escrito. El cliente se compromete a respetar la marca registrada y propiedad ' +
        'intelectual del fabricante.',
        { size: 15, color: COLOR.slate600 }
      ), { line: 280 }),
    ],
  });

  const totRow = (lbl, val, grand) => new TableRow({
    height: { value: grand ? 600 : 420, rule: HeightRule.ATLEAST },
    children: [
      new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        shading: grand ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 } : undefined,
        margins: { top: 120, bottom: 120, left: 200, right: 200 },
        verticalAlign: VerticalAlign.CENTER,
        borders: {
          top: grand ? BORDER_THICK() : BORDER_HAIR(),
          bottom: BORDER_HAIR(),
          left: BORDER_HAIR(),
          right: BORDER_HAIR(),
        },
        children: [P(R(lbl, {
          size: grand ? 22 : 17,
          bold: true,
          color: grand ? COLOR.slate900 : COLOR.slate600,
          caps: true,
          spacing: 20,
        }), { align: AlignmentType.RIGHT })],
      }),
      new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        shading: grand ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate100 } : undefined,
        margins: { top: 120, bottom: 120, left: 200, right: 200 },
        verticalAlign: VerticalAlign.CENTER,
        borders: {
          top: grand ? BORDER_THICK() : BORDER_HAIR(),
          bottom: BORDER_HAIR(),
          left: BORDER_HAIR(),
          right: BORDER_HAIR(),
        },
        children: [P(R(`RD$ ${fmtMoney(val)}`, {
          size: grand ? 28 : 19,
          bold: true,
          color: COLOR.slate900,
          font: 'Consolas',
        }), { align: AlignmentType.RIGHT })],
      }),
    ],
  });

  const totalsCell = new TableCell({
    width: { size: 42, type: WidthType.PERCENTAGE },
    margins: { top: 0, bottom: 0, left: 240, right: 0 },
    verticalAlign: VerticalAlign.TOP,
    borders: ALL_NONE,
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          totRow('Subtotal',    subtotal, false),
          totRow('ITBIS (18%)', itbis,    false),
          totRow('Total Neto',  total,    true),
        ],
      }),
    ],
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...ALL_NONE, insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE },
    rows: [
      new TableRow({
        children: [legalCell, totalsCell],
      }),
    ],
  });
}

// ─── Condiciones grid 4 col (validez/pago/entrega/garantía) ─────────────────
function buildCondGrid() {
  const items = [
    { lbl: 'VALIDEZ',        val: CONDICIONES.validez },
    { lbl: 'FORMA DE PAGO',  val: CONDICIONES.pago },
    { lbl: 'ENTREGA',        val: CONDICIONES.entrega },
    { lbl: 'GARANTÍA',       val: CONDICIONES.garantia },
  ];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...ALL_NONE, insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE },
    rows: [
      new TableRow({
        height: { value: 700, rule: HeightRule.ATLEAST },
        children: items.map(({ lbl, val }) => new TableCell({
          width: { size: 25, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 },
          margins: { top: 140, bottom: 140, left: 200, right: 200 },
          verticalAlign: VerticalAlign.TOP,
          borders: {
            top: BORDER_HAIR(),
            bottom: BORDER_HAIR(),
            right: BORDER_HAIR(),
            left: { style: BorderStyle.SINGLE, size: 24, color: COLOR.blue800 },
          },
          children: [
            P(R(lbl, { size: 13, bold: true, color: COLOR.slate500, caps: true, spacing: 24 }), { after: 40 }),
            P(R(val, { size: 16, bold: true, color: COLOR.slate900 })),
          ],
        })),
      }),
    ],
  });
}

// ─── Notas ──────────────────────────────────────────────────────────────────
function buildNotas() {
  return [
    P(R('NOTAS DEL PROYECTO', { size: 14, bold: true, color: COLOR.slate900, caps: true, spacing: 30 }),
      { before: 200, after: 60 }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: BORDER_HAIR(),
        bottom: BORDER_HAIR(),
        right: BORDER_HAIR(),
        left: { style: BorderStyle.SINGLE, size: 24, color: COLOR.slate400 },
        insideHorizontal: BORDER_NONE,
        insideVertical: BORDER_NONE,
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.slate50 },
              margins: { top: 200, bottom: 200, left: 240, right: 240 },
              children: [P(R(NOTAS, { size: 16, color: COLOR.slate700, italics: true }), { line: 300 })],
            }),
          ],
        }),
      ],
    }),
  ];
}

// ─── Firmas ─────────────────────────────────────────────────────────────────
function buildFirmas() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...ALL_NONE, insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE },
    rows: [
      new TableRow({
        height: { value: 1400, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: 47, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlign.BOTTOM,
            borders: { top: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE,
                       bottom: { style: BorderStyle.SINGLE, size: 14, color: COLOR.slate900 } },
            children: [P(R(' '))],
          }),
          new TableCell({
            width: { size: 6, type: WidthType.PERCENTAGE },
            borders: ALL_NONE,
            children: [P(R(' '))],
          }),
          new TableCell({
            width: { size: 47, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlign.BOTTOM,
            borders: { top: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE,
                       bottom: { style: BorderStyle.SINGLE, size: 14, color: COLOR.slate900 } },
            children: [P(R(' '))],
          }),
        ],
      }),
      new TableRow({
        height: { value: 350, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: 47, type: WidthType.PERCENTAGE },
            borders: ALL_NONE,
            children: [
              P(R('ACEPTACIÓN DEL CLIENTE', { size: 16, bold: true, color: COLOR.slate900, caps: true, spacing: 20 }),
                { align: AlignmentType.CENTER, after: 30 }),
              P(R('Firma · Sello · Fecha', { size: 13, color: COLOR.slate500 }),
                { align: AlignmentType.CENTER }),
            ],
          }),
          new TableCell({ width: { size: 6, type: WidthType.PERCENTAGE }, borders: ALL_NONE, children: [P(R(' '))] }),
          new TableCell({
            width: { size: 47, type: WidthType.PERCENTAGE },
            borders: ALL_NONE,
            children: [
              P(R(`${EMPRESA.representanteNombre} ${EMPRESA.representanteApellido}`, {
                size: 16, bold: true, color: COLOR.slate900, caps: true, spacing: 20,
              }), { align: AlignmentType.CENTER, after: 30 }),
              P(R(`${EMPRESA.representanteCargo} · ${EMPRESA.razonSocial}`, { size: 13, color: COLOR.slate500 }),
                { align: AlignmentType.CENTER }),
            ],
          }),
        ],
      }),
    ],
  });
}

// ─── Anexo fotográfico (página nueva, grid 2×2) ─────────────────────────────
function buildAnexoFotografico() {
  const slotCell = (n) => new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    margins: { top: 240, bottom: 240, left: 240, right: 240 },
    verticalAlign: VerticalAlign.CENTER,
    borders: {
      top:    { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
      bottom: { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
      left:   { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
      right:  { style: BorderStyle.DASHED, size: 8, color: COLOR.slate300 },
    },
    children: [
      P(R(`[ FOTO ${n} ]`, { size: 22, bold: true, color: COLOR.slate400, caps: true, spacing: 50 }),
        { align: AlignmentType.CENTER, after: 80 }),
      P(R('Insertar imagen aquí', { size: 14, color: COLOR.slate400, italics: true }),
        { align: AlignmentType.CENTER, after: 60 }),
      P(R('—', { size: 14, color: COLOR.slate300 }), { align: AlignmentType.CENTER, after: 1000 }),
      P(R('Pie de foto / ubicación', { size: 13, color: COLOR.slate500 }),
        { align: AlignmentType.CENTER }),
    ],
  });

  return [
    new Paragraph({ children: [new PageBreak()] }),
    P(R('ANEXO FOTOGRÁFICO', { size: 28, bold: true, color: COLOR.slate900, caps: true, spacing: 40 }),
      { align: AlignmentType.CENTER, after: 100 }),
    P(R('Levantamiento técnico del sitio · Documento complementario', {
      size: 14, italics: true, color: COLOR.slate500,
    }), { align: AlignmentType.CENTER, after: 300 }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { ...ALL_NONE, insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE },
      rows: [
        new TableRow({ children: [slotCell(1), slotCell(2)] }),
        new TableRow({ children: [slotCell(3), slotCell(4)] }),
      ],
    }),
  ];
}

// ─── Documento ──────────────────────────────────────────────────────────────
function construirDocumento() {
  return new Document({
    creator: 'ACR Networks & Solutions',
    title: `Cotización ${NUMERO}`,
    description: 'Cotización editable offline · paridad PDF corporativo',
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
          margin: { top: 2400, bottom: 1400, left: 800, right: 800, header: 360, footer: 360 },
          size:   { width: 12240, height: 15840 },   // Letter
        },
      },
      headers: { default: buildHeader() },
      footers: { default: buildFooter() },
      children: [
        // Title bar
        new Paragraph({ children: [], spacing: { before: 0, after: 60 } }),
        buildTitleBar(),
        new Paragraph({ children: [], spacing: { before: 0, after: 200 } }),
        // Cliente
        P(R('CLIENTE', { size: 14, bold: true, color: COLOR.slate600, caps: true, spacing: 32 }),
          { after: 60, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.slate200, space: 4 } } }),
        buildClienteBlock(),
        new Paragraph({ children: [], spacing: { before: 0, after: 200 } }),
        // Detalle
        P(R('DETALLE DE PRODUCTOS Y SERVICIOS', { size: 14, bold: true, color: COLOR.slate600, caps: true, spacing: 32 }),
          { after: 60, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.slate200, space: 4 } } }),
        buildItemsTable(),
        new Paragraph({ children: [], spacing: { before: 0, after: 200 } }),
        // Totales wrap
        buildTotalesWrap(),
        new Paragraph({ children: [], spacing: { before: 0, after: 200 } }),
        // Condiciones grid
        buildCondGrid(),
        // Notas
        ...buildNotas(),
        // Firmas
        new Paragraph({ children: [], spacing: { before: 600, after: 0 } }),
        buildFirmas(),
        // Anexo
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
  console.log(`[generarPlantillaWord] OK -> ${outPath} (${buf.length} bytes)`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[generarPlantillaWord] ERROR:', err);
    process.exit(1);
  });
}

module.exports = { construirDocumento };
