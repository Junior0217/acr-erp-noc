// node --test tests/pdf-regression.test.js
//
// Regresión visual base para el template de PDFs. Protege contra:
//   1. Reaparición del prefijo "SKU:" en descripciones (eliminado en 61861d0)
//   2. Reaparición de la dirección de la EMPRESA en el header corp-meta (61861d0)
//   3. Reaparición del campo "Registro Mercantil" en el footer (eliminado en este lote)
//   4. Pérdida del fallback emp.website cuando no hay verify.url (este lote)
//   5. Pérdida del watermark "Cotización" o "Anulada" según estado
//   6. Cambio accidental en la tabla itemsRows (columnas: # · Código · Descripción · Cant · PU · Importe)

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { renderDocumento } = require('../services/pdf-templates')

// ── Fixtures mínimos ─────────────────────────────────────────────────────────

const empresaFix = {
  id:                1,
  razonSocial:       'ACR Networks & Solutions',
  nombreComercial:   null,
  rnc:               '131-12345-6',
  registroMercantil: 'RM-2024-99999',
  telefono:          '809-555-0100',
  email:             'contacto@acr.do',
  website:           'www.acrnetworks.do',
  direccion:         'Av. Test 123',
  sector:            'Sector A',
  provincia:         'Distrito Nacional',
  assets:            {},
  condicionesDefault: {},
  representanteCargo: 'Gerente',
}

const clienteFix = {
  razonSocial:    'Cliente Test S.R.L.',
  rnc:            '131-99999-8',
  noCliente:      'CLI-001',
  contacto:       'Juan Pérez',
  telefono:       '809-555-0200',
  direccion:      'Calle Cliente 45',
  sector:         'Sector B',
  provincia:      'Santiago',
  email:          'cli@test.do',
}

const itemsFix = [
  { codigo: 'PROD-001', descripcion: 'Cámara CCTV 4K Hikvision', cantidad: 2, precioUnitario: 1500 },
  { codigo: 'PROD-002', descripcion: 'Cable UTP Cat6 305m',       cantidad: 1, precioUnitario: 4500 },
]

function baseArgs(overrides = {}) {
  return {
    tipo:         'factura',
    numero:       'FAC-000001',
    ncf:          'B01000000001',
    tipoNcf:      'Fiscal',
    empresa:      empresaFix,
    cliente:      clienteFix,
    items:        itemsFix,
    subtotal:     7500,
    itbis:        1350,
    total:        8850,
    fechaEmision: new Date('2026-05-19T10:00:00Z'),
    fechaVence:   new Date('2026-06-19T10:00:00Z'),
    estado:       'Emitida',
    notas:        null,
    condiciones:  {},
    verify:       { hash: 'abc123', url: 'https://acr.do/verify/abc123' },
    verifyQrDataUri: 'data:image/png;base64,iVBORw0KGgo=',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('PDF · NO renderiza el prefijo "SKU:" en descripción de líneas', () => {
  const html = renderDocumento(baseArgs())
  // El SKU vive en columna .codigo, NO como prefijo dentro de la descripción.
  assert.equal(/SKU:\s*PROD-/i.test(html), false, 'No debe aparecer "SKU: PROD-..." en el HTML')
})

test('PDF · header corp-meta NO incluye la dirección de la EMPRESA', () => {
  const html = renderDocumento(baseArgs())
  // direccionEmp fue removido del header (corpRows) — se mantiene solo en el QR/website.
  // Verifica que "Av. Test 123" NO aparezca dentro de corp-meta. Esto es un
  // smoke test débil pero suficiente: si vuelve, aparecerá repetido.
  const idxCorp = html.indexOf('class="corp-meta"')
  assert.notEqual(idxCorp, -1, 'corp-meta debe existir')
  const corpBlock = html.slice(idxCorp, idxCorp + 800)
  assert.equal(corpBlock.includes('Av. Test 123'), false, 'corp-meta NO debe imprimir la dirección de la empresa')
})

test('PDF · footer NO incluye el campo Registro Mercantil', () => {
  const html = renderDocumento(baseArgs({ tipo: 'cotizacion' }))
  // emp.registroMercantil fue removido del footer en este lote. NUNCA debe verse al cliente.
  assert.equal(html.includes('RM/Cám. Comercio'), false, 'No debe imprimir el bloque "RM/Cám. Comercio"')
  assert.equal(html.includes('RM-2024-99999'),     false, 'El valor de registroMercantil NO debe aparecer en el HTML')
})

test('PDF · tabla de items tiene columnas en orden: # · Código · Descripción · Cant · PU · Importe', () => {
  const html = renderDocumento(baseArgs())
  const idxHead = html.indexOf('<th class="col-num">')
  assert.notEqual(idxHead, -1)
  const head = html.slice(idxHead, idxHead + 400)
  const orden = ['col-num', 'col-cod', '>Descripción', 'col-cant', 'col-pu', 'col-amt']
  let cursor = 0
  for (const token of orden) {
    const i = head.indexOf(token, cursor)
    assert.notEqual(i, -1, `Token "${token}" no encontrado en el orden esperado de columnas`)
    cursor = i + token.length
  }
})

test('PDF · cotización tiene watermark "Cotización"', () => {
  const html = renderDocumento(baseArgs({ tipo: 'cotizacion' }))
  assert.equal(html.includes('class="watermark cotizacion"'), true)
})

test('PDF · factura anulada tiene watermark "Anulada"', () => {
  const html = renderDocumento(baseArgs({ estado: 'Anulada' }))
  assert.equal(html.includes('class="watermark"') && html.includes('Anulada'), true)
})

test('PDF · footer fallback a emp.website cuando verify.url es null', () => {
  const html = renderDocumento(baseArgs({
    tipo:   'cotizacion',
    verify: null,
    verifyQrDataUri: '',
  }))
  // Sin verify.url, debe imprimir emp.website como link de respaldo.
  assert.equal(html.includes('www.acrnetworks.do'), true, 'Sin verify.url debe aparecer emp.website como fallback')
})

test('PDF · QR url se imprime cuando verify.url está set', () => {
  const html = renderDocumento(baseArgs())
  assert.equal(html.includes('https://acr.do/verify/abc123'), true)
})

test('PDF · totales — subtotal e ITBIS y grand total se imprimen correctos', () => {
  const html = renderDocumento(baseArgs())
  assert.equal(html.includes('RD$ 7,500.00'), true, 'subtotal debe imprimirse formateado')
  assert.equal(html.includes('RD$ 1,350.00'), true, 'ITBIS debe imprimirse formateado')
  assert.equal(html.includes('RD$ 8,850.00'), true, 'total grand debe imprimirse formateado')
})

test('PDF · sección de cliente usa "Facturar a" en facturas y "Cliente" en cotizaciones', () => {
  const htmlFac = renderDocumento(baseArgs())
  assert.equal(htmlFac.includes('Facturar a'), true)
  const htmlCot = renderDocumento(baseArgs({ tipo: 'cotizacion' }))
  assert.equal(htmlCot.includes('>Cliente<'), true)
})
