'use strict';
/**
 * Golden test de desglosarItbis() — conversión "precio CON ITBIS" → base imponible.
 * Corre sin framework: `node modules/ventas/__tests__/desglose-itbis.test.cjs`.
 * Sale con código 1 si alguna aserción falla — apto para CI.
 *
 * INVARIANTE FISCAL (la razón de existir de este helper):
 *   subtotal + round(subtotal * tasa) === suma de (precioConItbis * cantidad)
 * Es decir: el total del documento DEBE cerrar exacto contra el precio que se
 * le pactó al cliente, pese a que cada unitario se redondee a 2 decimales.
 */
const { desglosarItbis } = require('../_lib.js');

let fallos = 0;
function check(nombre, cond, extra) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${nombre}${cond || extra === undefined ? '' : ` → ${extra}`}`);
  if (!cond) fallos++;
}

// Replica EXACTA de como pos/service.js calcula los totales (lineas 588-591).
// Si esta replica y el helper divergen, el test falla — que es el punto.
function totalizarComoElService(lineas, tasa) {
  const subtotal = Math.round(lineas.reduce(
    (s, l) => s + Math.round(l.precioUnitario * l.cantidad * 100) / 100, 0) * 100) / 100;
  const itbis = Math.round(subtotal * tasa * 100) / 100;
  return { subtotal, itbis, total: Math.round((subtotal + itbis) * 100) / 100 };
}

function esperaCuadre(nombre, entrada, tasa = 0.18) {
  const r = desglosarItbis(entrada, tasa);
  const pactado = Math.round(entrada.reduce((s, l) => s + l.precioConItbis * l.cantidad, 0) * 100) / 100;
  const real = totalizarComoElService(r.lineas, tasa);
  check(`${nombre}: total cierra en ${pactado.toFixed(2)}`,
    real.total === pactado, `dio ${real.total.toFixed(2)}`);
  check(`${nombre}: helper y service coinciden`,
    r.subtotal === real.subtotal && r.itbis === real.itbis && r.total === real.total,
    `helper=${r.subtotal}/${r.itbis}/${r.total} service=${real.subtotal}/${real.itbis}/${real.total}`);
  check(`${nombre}: sin residuo pendiente`, r.residuo === 0, `residuo=${r.residuo}`);
  check(`${nombre}: conserva cantidad de lineas`, r.lineas.length === entrada.length);
  return r;
}

console.log('\n[1] Caso real COT-000220 (ServiCorp · Integración Alarma AJAX)');
{
  const r = esperaCuadre('COT-000220', [
    { precioConItbis: 21600, cantidad: 1 }, { precioConItbis: 8800,  cantidad: 3 },
    { precioConItbis: 10490, cantidad: 3 }, { precioConItbis: 1240,  cantidad: 3 },
    { precioConItbis: 2330,  cantidad: 2 }, { precioConItbis: 5000,  cantidad: 1 },
    { precioConItbis: 6700,  cantidad: 1 }, { precioConItbis: 3600,  cantidad: 1 },
    { precioConItbis: 1900,  cantidad: 2 }, { precioConItbis: 2950,  cantidad: 1 },
  ]);
  check('COT-000220: subtotal 93,135.59', r.subtotal === 93135.59, String(r.subtotal));
  check('COT-000220: itbis 16,764.41',    r.itbis === 16764.41,    String(r.itbis));
  check('COT-000220: total 109,900.00',   r.total === 109900,      String(r.total));
  check('COT-000220: panel queda en 18,305.08',
    r.lineas[0].precioUnitario === 18305.08, String(r.lineas[0].precioUnitario));
}

console.log('\n[2] División exacta (sin necesidad de ajuste)');
{
  const r = esperaCuadre('118 x1', [{ precioConItbis: 118, cantidad: 1 }]);
  check('118/1.18 = 100.00 exacto', r.lineas[0].precioUnitario === 100, String(r.lineas[0].precioUnitario));
  check('no se aplicó ajuste', r.lineas[0].ajuste === 0, String(r.lineas[0].ajuste));
}

console.log('\n[3] Ajuste de centavos repartido entre líneas');
{
  // El MultiTransmitter de COT-000220 (3 uds) es justo el que absorbe el ajuste
  // cuando convive con líneas de cantidad 1 que afinan el resto.
  const r = esperaCuadre('mixto 3+1', [{ precioConItbis: 8800, cantidad: 3 }, { precioConItbis: 2950, cantidad: 1 }]);
  check('alguna línea reporta su ajuste', r.lineas.some(l => l.ajuste !== 0),
    r.lineas.map(l => l.ajuste).join(','));
  check('ningún ajuste supera 1 centavo', r.lineas.every(l => Math.abs(l.ajuste) <= 0.01),
    r.lineas.map(l => l.ajuste).join(','));
}

console.log('\n[4] Caso SIN solución exacta: debe reportarlo, no mentir');
{
  // Una sola línea de cantidad 3: el subtotal solo salta de 3 en 3 centavos y
  // el objetivo cae entre dos escalones. No existe unitario uniforme que cierre.
  const r = desglosarItbis([{ precioConItbis: 8800, cantidad: 3 }], 0.18);
  check('marca exacto = false', r.exacto === false, String(r.exacto));
  check('reporta la diferencia', Math.abs(r.diferencia) === 0.01, String(r.diferencia));
  check('la diferencia es mínima (1 centavo)', Math.abs(r.diferencia) <= 0.01, String(r.diferencia));
  check('aun así expone totalPactado', r.totalPactado === 26400, String(r.totalPactado));
}

console.log('\n[5] Barrido: 400 combinaciones aleatorias');
{
  let inexactos = 0, peorDif = 0, malReportados = 0;
  // Semilla fija → test determinista y reproducible en CI.
  let seed = 20261125;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rnd() * 8);
    const lineas = Array.from({ length: n }, () => ({
      precioConItbis: Math.round((50 + rnd() * 49950) * 100) / 100,
      cantidad: 1 + Math.floor(rnd() * 12),
    }));
    const r = desglosarItbis(lineas, 0.18);
    const pactado = Math.round(lineas.reduce((s, l) => s + l.precioConItbis * l.cantidad, 0) * 100) / 100;
    const real = totalizarComoElService(r.lineas, 0.18);
    // El flag `exacto` NUNCA debe mentir: si dice true, el service debe cuadrar.
    if (r.exacto !== (real.total === pactado)) malReportados++;
    if (real.total !== pactado) { inexactos++; peorDif = Math.max(peorDif, Math.abs(r.diferencia)); }
  }
  // Esta es LA garantía del helper: puede no cuadrar (ver [4]), pero jamás
  // puede decir que cuadró cuando el service va a guardar otra cosa.
  check('el flag `exacto` nunca miente', malReportados === 0, `${malReportados} mal reportados`);
  // Cota del desvío: con gcd(cantidades)=G el subtotal solo salta de G en G,
  // así que el peor caso escala con G (hasta 12 en este barrido).
  check('ningún desvío supera 7 centavos', peorDif <= 0.07, `peor ${peorDif}`);
  check('mayoría cierra exacto', inexactos < 160, `${inexactos}/400 inexactos`);
}

console.log('\n[6] Límite conocido: ~15% de los totales no son representables');
{
  // f(S) = S + round(S*0.18) salta de 1 o 2 centavos. Cuando salta 2, ese total
  // NO tiene preimagen: no existe base imponible que lo produzca, con ninguna
  // combinación de precios. Verificado: 15.3% de los totales en un rango real.
  // Con una línea de cantidad 1 el subtotal es siempre alcanzable (gcd=1), así
  // que lo único que puede impedir el cuadre es ese límite matemático.
  let malos = 0, sinPreimagen = 0;
  const f = S => S + Math.round((S / 100) * 0.18 * 100);
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(rnd() * 6);
    const lineas = Array.from({ length: n }, () => ({
      precioConItbis: Math.round((50 + rnd() * 49950) * 100) / 100,
      cantidad: 1 + Math.floor(rnd() * 12),
    }));
    lineas.push({ precioConItbis: Math.round((50 + rnd() * 9950) * 100) / 100, cantidad: 1 });
    const r = desglosarItbis(lineas, 0.18);
    const pactadoC = Math.round(lineas.reduce((s, l) => s + l.precioConItbis * l.cantidad, 0) * 100);
    // ¿Existe ALGÚN subtotal que produzca ese total? Búsqueda alrededor del ideal.
    const ideal = Math.round(pactadoC / 1.18);
    let tiene = false;
    for (let S = ideal - 4; S <= ideal + 4 && !tiene; S++) if (f(S) === pactadoC) tiene = true;
    if (!tiene) sinPreimagen++;
    // Con gcd=1, si el total ES representable, el helper DEBE encontrarlo.
    if (tiene && !r.exacto) malos++;
  }
  check('cuando el total es representable, SIEMPRE lo encuentra', malos === 0, `${malos} perdidos`);
  check('detectó casos sin preimagen (límite real)', sinPreimagen > 0, `${sinPreimagen}/200`);
}

console.log('\n[7] Tasa configurable y bordes');
{
  esperaCuadre('tasa 0.16', [{ precioConItbis: 1160, cantidad: 2 }, { precioConItbis: 580, cantidad: 3 }], 0.16);
  const cero = desglosarItbis([{ precioConItbis: 1000, cantidad: 2 }], 0);
  check('tasa 0 → unitario intacto', cero.lineas[0].precioUnitario === 1000, String(cero.lineas[0].precioUnitario));
  check('tasa 0 → itbis 0', cero.itbis === 0, String(cero.itbis));
  check('lista vacía no explota', desglosarItbis([], 0.18).total === 0);
}

console.log('\n[8] Validación de entrada (no debe aceptar basura silenciosamente)');
{
  const malos = [
    ['cantidad 0',        [{ precioConItbis: 100, cantidad: 0 }]],
    ['cantidad negativa', [{ precioConItbis: 100, cantidad: -2 }]],
    ['precio negativo',   [{ precioConItbis: -100, cantidad: 1 }]],
    ['precio NaN',        [{ precioConItbis: NaN, cantidad: 1 }]],
    ['cantidad decimal',  [{ precioConItbis: 100, cantidad: 1.5 }]],
  ];
  for (const [nombre, entrada] of malos) {
    let lanzo = false;
    try { desglosarItbis(entrada, 0.18); } catch { lanzo = true; }
    check(`rechaza ${nombre}`, lanzo);
  }
  let tasaMala = false;
  try { desglosarItbis([{ precioConItbis: 100, cantidad: 1 }], 1.5); } catch { tasaMala = true; }
  check('rechaza tasa fuera de rango', tasaMala);
}

console.log(`\n${fallos === 0 ? 'TODO OK' : fallos + ' FALLO(S)'}\n`);
process.exitCode = fallos === 0 ? 0 : 1;
