// node --test tests/cotizador-libre-service.test.js
//
// Cubre el service del Cotizador Libre con generarPdfDocumento + repo mockeados
// (sin Puppeteer real). Protege contra regresión de:
//   1. Cache de EmpresaPerfil — findEmpresaPerfil debe llamarse 1x por PDF.
//   2. Filtrado de fotos con dataUri corrupto ANTES del anexo (no revienta).
//   3. Contacto del cliente visible aunque RNC vaya vacío (fix empty-string ??).
//   4. Margen @page 35mm aplicado (title-bar más arriba).

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const createSvc = require('../modules/ventas/cotizador-libre/service')
const { invalidateEmpresaPerfilCache } = require('../shared/empresa-perfil-cache')

const VALID_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function buildSvc() {
  let empCalls = 0
  const repo = {
    findEmpresaPerfil: async () => {
      empCalls++
      return { razonSocial: 'ACR', rnc: '1', telefono: '1', email: 'a@a.do', website: 'acr.do', eslogan: 'x', assets: {} }
    },
    findOne: async () => null,
  }
  let html = ''
  const generarPdfDocumento = async (h) => { html = h; return Buffer.from('PDF') }
  const svc = createSvc({ generarPdfDocumento, QRCode: null, repo })
  return { svc, getHtml: () => html, getEmpCalls: () => empCalls }
}

// El cache de EmpresaPerfil es un singleton de módulo (TTL 60s); reseteamos
// entre tests para que el conteo de llamadas sea determinista.
beforeEach(() => invalidateEmpresaPerfilCache())

test('service · cache EmpresaPerfil: findEmpresaPerfil 1x por PDF', async () => {
  const { svc, getEmpCalls } = buildSvc()
  await svc.generarPdf({
    numeroDocumento: 'COT-1', cliente: { razonSocial: 'Cli' },
    items: [{ descripcion: 'x', cantidad: 1, precioUnit: 10 }],
  })
  assert.equal(getEmpCalls(), 1, 'el cache debe colapsar las 2 lecturas del perfil en 1 query')
})

test('service · descarta fotos con dataUri corrupto antes del anexo', async () => {
  const { svc, getHtml } = buildSvc()
  await svc.generarPdf({
    numeroDocumento: 'COT-2', cliente: { razonSocial: 'Cli' },
    items: [
      { descripcion: 'ok',  cantidad: 1, precioUnit: 10, fotos: [{ dataUri: VALID_PNG }] },
      { descripcion: 'bad', cantidad: 1, precioUnit: 10, fotos: [{ dataUri: 'data:image/gif;base64,ZZ' }, { dataUri: 'nope' }] },
    ],
  })
  const html = getHtml()
  assert.equal(html.includes(VALID_PNG),       true,  'foto válida presente en el anexo')
  assert.equal(html.includes('data:image/gif'), false, 'foto gif corrupta descartada')
  assert.equal(html.includes('"nope"'),        false, 'dataUri inválido descartado')
})

test('service · contacto aparece aunque RNC vaya vacío ("")', async () => {
  const { svc, getHtml } = buildSvc()
  await svc.generarPdf({
    numeroDocumento: 'COT-3',
    cliente: { razonSocial: 'Escuela', rnc: '', contacto: 'Sr. Yordania', telefono: '809' },
    items: [{ descripcion: 'x', cantidad: 1, precioUnit: 10 }],
  })
  assert.equal(getHtml().includes('Sr. Yordania'), true)
})

test('service · @page usa margen 35mm (title-bar más arriba)', async () => {
  const { svc, getHtml } = buildSvc()
  await svc.generarPdf({
    numeroDocumento: 'COT-4', cliente: { razonSocial: 'Cli' },
    items: [{ descripcion: 'x', cantidad: 1, precioUnit: 10 }],
  })
  assert.equal(getHtml().includes('margin: 35mm 0 35mm 0'), true)
})
