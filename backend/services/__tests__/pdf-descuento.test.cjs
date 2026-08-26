'use strict';
/**
 * Golden test del bloque de descuento en el PDF (columna "Dto. %" + desglose
 * en totales). Corre sin framework: `node services/__tests__/pdf-descuento.test.cjs`.
 * Sale con código 1 si alguna aserción falla — apto para CI.
 */
const { renderDocumento } = require('../pdf-templates.js');

let fallos = 0;
function check(nombre, cond) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${nombre}`);
  if (!cond) fallos++;
}
const base = {
  tipo: 'cotizacion', numero: 'TEST-001',
  empresa: { razonSocial: 'ACR', rnc: '1', assets: {} },
  cliente: { razonSocial: 'Cliente Test', rnc: '101778199' },
  fechaEmision: new Date('2026-08-21'), estado: 'Borrador',
  condiciones: {}, verify: null, verifyQrDataUri: null,
};
// El body excluye el <style> para no matchear reglas CSS por error.
const body = html => html.split('</style>')[1] ?? html;

console.log('\n[1] Documento CON descuento porcentual (10%)');
{
  const items = [
    { descripcion: 'Equipo A', cantidad: 1, precioUnitario: 11993.22, descuentoPorcentaje: 10 },
    { descripcion: 'Equipo B', cantidad: 14, precioUnitario: 1964.41, descuentoPorcentaje: 10 },
  ];
  const neto = Math.round(items.reduce((s, i) =>
    s + Math.round(i.precioUnitario * 0.9 * 100) / 100 * i.cantidad, 0) * 100) / 100;
  const b = body(renderDocumento({ ...base, items, subtotal: neto,
    itbis: Math.round(neto * 0.18 * 100) / 100, total: Math.round(neto * 1.18 * 100) / 100 }));
  check('columna "Dto. %" presente',        /Dto\. %/.test(b));
  check('celda muestra "10%"',              /10%/.test(b));
  check('fila Descuento (10%) en totales',  /Descuento \(10%\)/.test(b));
  check('fila "Subtotal neto"',             /Subtotal neto/.test(b));
  check('subtotal BRUTO 39,494.96',         /39,494\.96/.test(b));
  check('subtotal NETO 35,545.48',          /35,545\.48/.test(b));
  check('descuento 3,949.48',               /3,949\.48/.test(b));
}

console.log('\n[2] Documento con descuento de MONTO fijo');
{
  const items = [{ descripcion: 'Router', cantidad: 3, precioUnitario: 4730.77, descuentoMonto: 500 }];
  const neto = Math.round((4730.77 - 500) * 3 * 100) / 100;
  const b = body(renderDocumento({ ...base, items, subtotal: neto,
    itbis: Math.round(neto * 0.18 * 100) / 100, total: Math.round(neto * 1.18 * 100) / 100 }));
  check('columna "Dto. %" presente',      /Dto\. %/.test(b));
  check('celda muestra el monto -500.00', /-500\.00/.test(b));
  check('etiqueta genérica "Descuento"',  /Descuento<\/span>/.test(b));
  check('importe con monto aplicado 12,692.31', /12,692\.31/.test(b));
}

console.log('\n[3] Documento SIN descuento (layout intacto)');
{
  const items = [{ descripcion: 'Equipo', cantidad: 2, precioUnitario: 1000 }];
  const b = body(renderDocumento({ ...base, items, subtotal: 2000, itbis: 360, total: 2360 }));
  check('SIN columna "Dto. %"',       !/Dto\. %/.test(b));
  check('SIN fila de descuento',      !/tot-row--dto/.test(b));
  check('SIN fila "Subtotal neto"',   !/Subtotal neto/.test(b));
  check('importe sin descontar 2,000.00', /2,000\.00/.test(b));
}

console.log(fallos === 0 ? '\n✅ GOLDEN TEST OK — 15/15' : `\n❌ ${fallos} aserción(es) fallaron`);
process.exit(fallos === 0 ? 0 : 1);
