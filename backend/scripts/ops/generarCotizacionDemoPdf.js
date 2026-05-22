/**
 * backend/scripts/ops/generarCotizacionDemoPdf.js
 *
 * Genera una cotización PDF de DEMOSTRACIÓN con datos reales completos
 * usando el MISMO pipeline de producción (`renderDocumento` + Puppeteer).
 *
 * Propósito: tener un archivo PDF que sea el referente visual exacto
 * — bit por bit — de cómo luce una cotización al ser emitida desde el
 * Módulo de Ventas. Sirve para:
 *
 *   1. Validar paridad con las plantillas .xlsx y .docx (lado a lado).
 *   2. Distribuir un sample para reuniones comerciales sin tocar la BD.
 *   3. Inspeccionar visualmente el resultado del template oficial sin
 *      tener que arrancar el servidor + autenticarse + crear datos.
 *
 * Requisitos: Chrome o Edge instalado (Puppeteer dev local) — el script
 * `pdf-generator.js` detecta automáticamente la ruta del ejecutable.
 *
 * Salida: Cotizacion_Demo_RA.pdf en la raíz del repo.
 * Ejecutar: node backend/scripts/ops/generarCotizacionDemoPdf.js
 */

const path = require('path');
const fs   = require('fs');

const { renderDocumento } = require('../../services/pdf-templates');
const { generarPdfDocumento, cerrarBrowser, inlineAssets } = require('../../services/pdf-generator');

const {
  EMPRESA, CLIENTE, ITEMS, NUMERO,
  CONDICIONES, NOTAS,
  calcular, fechaEmision, fechaVence,
  logoDataUri,
} = require('./_demoCotizacion');

async function main() {
  const { subtotal, itbis, total } = calcular(ITEMS);
  const emision = fechaEmision();
  const vence   = fechaVence();

  // Empresa para el template: requiere assets inline (logoClaro, sello, firma).
  const assets = await inlineAssets({ logoClaro: logoDataUri() });
  const empresaPdf = { ...EMPRESA, assets };

  const html = renderDocumento({
    tipo:        'cotizacion',
    numero:      NUMERO,
    empresa:     empresaPdf,
    cliente:     CLIENTE,
    items:       ITEMS,
    subtotal,
    itbis,
    total,
    fechaEmision: emision,
    fechaVence:   vence,
    estado:       'Emitida',
    notas:        NOTAS,
    condiciones:  CONDICIONES,
    verify:           null,
    verifyQrDataUri:  null,
  });

  const pdfBuf = await generarPdfDocumento(html, {
    format: 'Letter',
    margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
  });

  const outPath = path.resolve(__dirname, '..', '..', '..', 'Cotizacion_Demo_RA.pdf');
  fs.writeFileSync(outPath, pdfBuf);

  // eslint-disable-next-line no-console
  console.log(`[generarCotizacionDemoPdf] OK -> ${outPath} (${pdfBuf.length} bytes)`);
}

if (require.main === module) {
  main()
    .then(() => cerrarBrowser())
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error('[generarCotizacionDemoPdf] ERROR:', err);
      try { await cerrarBrowser(); } catch {}
      process.exit(1);
    });
}

module.exports = { main };
