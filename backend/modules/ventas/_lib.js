/**
 * backend/modules/ventas/_lib.js
 *
 * Cross-cutting helpers compartidos por sub-modulos de ventas.
 * Factory cierra sobre deps (prisma, supabase, email, PDF helpers).
 */

const PDFDocument = require('pdfkit');
const { z }       = require('zod');
const crypto      = require('crypto');

module.exports = function createVentasLib(deps) {
  const { prisma } = deps;

// ─── PDF Builder (shared por rutas legacy + envío por email) ─────────────────
// Delegación al motor corporativo nuevo (Puppeteer + renderPdfDoc).
// Antes era pdfkit; ahora se unifica para que TODOS los PDFs (legacy + nuevos +
// email automático) salgan con el mismo diseño y datos desde EmpresaPerfil.

async function buildFacturaPDFBuffer(factura) {
  const empresa = await prisma.empresaPerfil.findUnique({ where: { id: 1 } })
  const empresaConAssets = empresa
    ? { ...empresa, assets: await inlineAssets(empresa.assets ?? {}) }
    : { razonSocial: '', rnc: '', assets: {} }
  const c = factura.cliente ?? {}
  // Hash computado UNA sola vez; mismo valor para QR + texto verify.
  const legacyHash      = facturaVerifyHash(factura, 'pdf-legacy')
  const legacyVerifyUrl = `${PUBLIC_VERIFY_BASE}/verify/${legacyHash}`
  // Soporta tanto factura.lineas (POS) como factura.orden.lineas (OT) — coge la primera no vacía.
  const lineasSrc = (factura.lineas?.length ? factura.lineas : factura.orden?.lineas) ?? []
  const items = lineasSrc.map(l => ({
    codigo:         l.producto?.sku ?? l.itemCatalogo?.sku ?? (l.producto?.id ? `ART-${String(l.producto.id).padStart(3, '0')}` : null),
    descripcion:    l.descripcion ?? l.itemCatalogo?.nombre ?? '—',
    detalle:        l.itemCatalogo?.descripcion ?? null,
    sku:            l.producto?.sku ?? null,
    cantidad:       l.cantidad,
    precioUnitario: Number(l.precioUnitario),
  }))
  const html = renderPdfDoc({
    tipo:         factura.esCotizacion ? 'cotizacion'
                  : factura.esNotaCredito ? 'nota-credito'
                  : factura.esNotaDebito  ? 'nota-debito'
                  : 'factura',
    numero:       factura.noFactura,
    ncf:          factura.ncf ?? null,
    tipoNcf:      factura.tipoNcf ?? null,
    empresa:      empresaConAssets,
    cliente: {
      razonSocial: c.razonSocial,
      noCliente:   c.noCliente,
      rnc:         c.rnc,
      contacto:    c.nombreContacto ?? c.contacto ?? null,
      cedula:      c.cedula,
      direccion:   c.direccion,
      sector:      c.sector,
      provincia:   c.provincia,
      telefono:    c.telefono ?? c.telefonoPrincipal ?? c.telefonoContacto ?? null,
      email:       c.email,
    },
    items,
    subtotal:     Number(factura.subtotal),
    itbis:        Number(factura.itbis ?? 0),
    total:        Number(factura.total),
    fechaEmision: factura.fechaEmision,
    fechaVence:   factura.fechaVence,
    estado:       factura.estado,
    notas:        factura.notas,
    condiciones:  mergeCondiciones(empresa, factura),
    esNotaCredito:           !!factura.esNotaCredito,
    esNotaDebito:            !!factura.esNotaDebito,
    facturaOrigen:           factura.facturaOrigen
      ? { noFactura: factura.facturaOrigen.noFactura, ncf: factura.facturaOrigen.ncf, tipoNcf: factura.facturaOrigen.tipoNcf }
      : null,
    motivoNotaModificatoria: factura.motivoNotaModificatoria ?? null,
    verify:       { hash: legacyHash, url: legacyVerifyUrl },
    verifyQrDataUri: await renderVerifyQr(legacyVerifyUrl),
  })
  return generarPdfDocumento(html)
}

// (Ruta /api/facturas/:id/pdf registrada arriba, unificada con renderPdfDoc.)



// ─── Auto-secuenciador centralizado (núcleo ERP) ──────────────────────────────
// Atómico vía UPDATE-RETURNING sobre EmpresaPerfil.id=1 con jsonb_set. La fila
// se bloquea exclusivamente durante el UPDATE; dos cajeros concurrentes serializan
// y reciben códigos distintos (no race). Defaults se aplican si la entidad no
// existe aún en secuenciasConfig — un INSERT diferido no hace falta.
const SECUENCIA_DEFAULTS = {
  factura:      { prefijo: 'FAC', actual: 0, padding: 6 },
  cotizacion:   { prefijo: 'COT', actual: 0, padding: 6 },
  producto:     { prefijo: 'ART', actual: 0, padding: 6 },
  servicio:     { prefijo: 'SVC', actual: 0, padding: 6 },
  cliente:      { prefijo: 'CLI', actual: 0, padding: 6 },
  rma:          { prefijo: 'RMA', actual: 0, padding: 5 },
  plan:         { prefijo: 'PLN', actual: 0, padding: 6 },
  // OT + compras añadidos para paridad con shared/services/sequences.service.js.
  ordenTrabajo: { prefijo: 'OT',  actual: 0, padding: 6 },
  compra:       { prefijo: 'CMP', actual: 0, padding: 6 },
  // Secuenciador interno para el "noFactura" de Notas de Crédito (NC-000001).
  // El NCF B04 sigue su PROPIA secuencia DGII en ConfiguracionNCF — son
  // numeradores independientes (no confundir interno vs fiscal).
  notaCredito: { prefijo: 'NC',  actual: 0, padding: 6 },
  // Idem para Nota de Débito interna (ND-000001) — NCF B03 vive aparte en
  // ConfiguracionNCF para que el numerador fiscal nunca dependa del interno.
  notaDebito:  { prefijo: 'ND',  actual: 0, padding: 6 },
}

async function generarSiguienteCodigo(entidad, tx) {
  const def = SECUENCIA_DEFAULTS[entidad]
  if (!def) throw new Error(`Entidad de secuencia desconocida: "${entidad}".`)
  const db = tx ?? prisma
  // jsonb_set asegura que la rama exista. Si la entidad no había sido configurada,
  // sembramos con defaults antes de incrementar.
  const seedPath = `{${entidad}}`
  const actualPath = `{${entidad},actual}`
  const rows = await db.$queryRawUnsafe(`
    UPDATE "EmpresaPerfil"
    SET    "secuenciasConfig" =
      jsonb_set(
        jsonb_set(
          COALESCE("secuenciasConfig", '{}'::jsonb),
          '${seedPath}',
          COALESCE("secuenciasConfig"->'${entidad}', $1::jsonb),
          true
        ),
        '${actualPath}',
        (
          (COALESCE(("secuenciasConfig"->'${entidad}'->>'actual')::int, ${def.actual}) + 1)::text
        )::jsonb,
        true
      )
    WHERE  id = 1
    RETURNING
      COALESCE("secuenciasConfig"->'${entidad}'->>'prefijo', $2)        AS prefijo,
      (("secuenciasConfig"->'${entidad}'->>'actual')::int)              AS actual,
      COALESCE(("secuenciasConfig"->'${entidad}'->>'padding')::int, $3) AS padding
  `, JSON.stringify(def), def.prefijo, def.padding)
  if (!rows || rows.length === 0) {
    // Fila id=1 no existe — crearla con defaults y reintentar una sola vez.
    await db.empresaPerfil.upsert({
      where:  { id: 1 },
      update: {},
      create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig: { [entidad]: def } },
    })
    return generarSiguienteCodigo(entidad, tx)
  }
  const { prefijo, actual, padding } = rows[0]
  return `${prefijo}-${String(actual).padStart(Number(padding) || 6, '0')}`
}

// Compute effective unit price after sequential discounts (% first, then fixed)
function efectivoUnitario(pu, pct, monto) {
  const afterPct = pu * (1 - pct / 100)
  return Math.round(Math.max(0, afterPct - monto) * 100) / 100
}
function totalLinea(pu, pct, monto, cant) {
  return Math.round(efectivoUnitario(pu, pct, monto) * cant * 100) / 100
}

// assertCondicionesPagoCompatibles vive a nivel de módulo (fuera del factory)
// — service.js / carrito lo importan como named export directo. Ver final del
// archivo.

// desglosarItbis vive a nivel de módulo por la misma razón. Ver final del archivo.

function formatCarrito(c) {
  if (!c) return null
  const lineas = (c.lineas ?? []).map(l => {
    const pu  = Number(l.precioUnitario)
    const pct = Number(l.descuentoPorcentaje)
    const mon = Number(l.descuentoMonto)
    const eu  = efectivoUnitario(pu, pct, mon)
    return { ...l, precioUnitario: pu, descuentoPorcentaje: pct, descuentoMonto: mon, precioEfectivo: eu, subtotalLinea: Math.round(eu * l.cantidad * 100) / 100 }
  })
  const subtotal = Math.round(lineas.reduce((s, l) => s + l.subtotalLinea, 0) * 100) / 100
  const itbisAmt = c.applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  return { ...c, lineas, totales: { subtotal, itbis: itbisAmt, total: Math.round((subtotal + itbisAmt) * 100) / 100 } }
}

const lineaPOSSchema = z.object({
  productoId:          z.number().int().positive(),
  cantidad:            z.number().int().positive(),
  precioUnitario:      z.number().positive().optional(),
  descuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
  descuentoMonto:      z.number().min(0).optional().default(0),
})

const facturaManualSchema = z.object({
  // Rigor Enterprise: clienteId OBLIGATORIO. Cero clientes walk-in / manuales.
  // Toda factura/cotización debe vincularse a un cliente real de la tabla Cliente.
  clienteId:    z.string().uuid({ message: 'clienteId es obligatorio (selecciona o crea un cliente en CRM).' }),
  itbis:        z.boolean().optional().default(true),
  diasVence:    z.number().int().min(0).max(365).optional().default(30),
  esCotizacion: z.boolean().optional().default(false),
  lineas:       z.array(lineaPOSSchema).min(1, 'Se requiere al menos una línea.'),
})

// Shared transaction: used by /api/facturas/manual and /api/carrito/checkout
// C2: puedeOverridePrecio gating + empleadoId trace.

// Auto-incrementador atómico de NCF (ConfiguracionNCF). Usado por NC/ND y facturas
// fiscales. Atómico vía UPDATE-RETURNING — concurrentes serializan en write-lock.
async function nextNomenclatura(tx, tipo) {
  const rows = await tx.$queryRaw`
    UPDATE "ConfiguracionNCF"
    SET    "secuenciaActual" = "secuenciaActual" + 1
    WHERE  "tipoNcf" = ${tipo}
    RETURNING "prefijo", "secuenciaActual"
  `;
  if (!rows || rows.length === 0) throw new Error(`Contador de nomenclatura "${tipo}" no encontrado.`);
  return `${rows[0].prefijo}${String(rows[0].secuenciaActual).padStart(3, '0')}`;
}

  return {
    buildFacturaPDFBuffer,
    nextNomenclatura,
    // Helpers de carrito (consumidos por modules/ventas/carrito/Blueprint).
    formatCarrito,
    efectivoUnitario,
    totalLinea,
    // generarSiguienteCodigo ya vive en server.js — accesible vía deps.
  };
};

// ─── Hardening compartido: pago vs crédito (TOP-LEVEL — named export) ─────────
//
// CRÍTICO: esta función DEBE vivir a nivel de módulo, NO dentro del factory
// createVentasLib. service.js (pos/carrito) la importan así:
//   const { assertCondicionesPagoCompatibles } = require('../_lib')
// Si estuviera dentro del factory, el require plano la devuelve `undefined` y
// CADA venta/factura/cotización lanza "assertCondicionesPagoCompatibles is not
// a function" → 500 genérico. Es pura (solo usa sus args), así que no necesita
// el closure de deps.
//
// Defense-in-depth contra request directos / cookie hijack que intenten emitir
// una factura a crédito ocultando la fila de "Forma de Pago" del PDF. La UI ya
// bloquea el switch cuando el cliente tiene diasCredito > 0, pero el backend
// NUNCA debe confiar en el frontend.
//
// Reglas:
//   - Si cliente.diasCredito > 0 → la condición de pago DEBE imprimirse.
//   - condicionesOverride.pago.incluir === false → rechazo 409.
//   - Las cotizaciones NO disparan este guard (no son fiscales aún).
function assertCondicionesPagoCompatibles(cliente, condicionesOverride, opts = {}) {
  const { esCotizacion = false, errorClass } = opts
  if (esCotizacion) return
  const incluir = condicionesOverride?.pago?.incluir
  if (incluir !== false) return
  const dias = Number(cliente?.diasCredito ?? 0)
  if (dias <= 0) return
  const Ctor = errorClass || Error
  const err = new Ctor(409, 'PAGO_REQUERIDO_CREDITO',
    'No se puede ocultar la "Forma de Pago" en una factura a crédito. El cliente tiene días de crédito activos — la condición de pago debe imprimirse para soporte legal de cobranza.')
  if (typeof err.status !== 'number') err.status = 409
  if (typeof err.code !== 'string')   err.code = 'PAGO_REQUERIDO_CREDITO'
  throw err
}
module.exports.assertCondicionesPagoCompatibles = assertCondicionesPagoCompatibles

// ─── Desglose de ITBIS: precio CON impuesto → base imponible (TOP-LEVEL) ─────
//
// Caso de uso real: un suplidor/cliente pacta precios que YA incluyen el ITBIS
// ("el panel son 21,600 con todo"). El documento fiscal, en cambio, debe
// imprimir la BASE imponible por línea y el ITBIS desglosado al pie. Dividir
// cada unitario entre 1.18 y redondear a 2 decimales NO cierra: la suma de los
// redondeos se desvía del precio pactado (en COT-000220 daba 3 centavos de más).
//
// Este helper calcula el subtotal objetivo y reparte la diferencia en centavos
// sobre los precios unitarios, de modo que se cumpla el INVARIANTE:
//
//   subtotal + round(subtotal * tasa) === Σ (precioConItbis * cantidad)
//
// Debe vivir a nivel de módulo (NO dentro del factory createVentasLib) por la
// misma razón que assertCondicionesPagoCompatibles: se importa como named
// export plano desde pos/service.js. Es pura — no toca deps ni Prisma.
//
// Entrada: [{ precioConItbis, cantidad }]  ·  tasa en fracción (0.18 = 18%)
// Salida:  { lineas: [{ precioUnitario, ajuste, precioConItbis, cantidad }],
//            subtotal, itbis, total, totalPactado, residuo }
//   - ajuste  : centavos movidos en ese unitario para cuadrar (0 si no hizo falta)
//   - residuo : centavos que NO se pudieron repartir. Debe ser 0; si no lo es,
//               el llamador tiene un descuadre que DEBE reportar, no esconder.
function desglosarItbis(lineasIn, tasa = 0.18) {
  if (!Array.isArray(lineasIn)) throw new Error('desglosarItbis: se esperaba un array de líneas.')
  if (!Number.isFinite(tasa) || tasa < 0 || tasa > 1) {
    throw new Error(`desglosarItbis: tasa inválida (${tasa}). Debe ser fracción entre 0 y 1 (0.18 = 18%).`)
  }
  // Todo el cálculo ocurre en CENTAVOS enteros: evita que el error de punto
  // flotante (0.1 + 0.2 !== 0.3) contamine un documento fiscal.
  const aCent = n => Math.round(n * 100)

  const lineas = lineasIn.map((l, i) => {
    const pci  = Number(l.precioConItbis)
    const cant = Number(l.cantidad)
    if (!Number.isFinite(pci) || pci < 0)  throw new Error(`desglosarItbis: línea ${i + 1} con precioConItbis inválido (${l.precioConItbis}).`)
    if (!Number.isInteger(cant) || cant <= 0) throw new Error(`desglosarItbis: línea ${i + 1} con cantidad inválida (${l.cantidad}). Debe ser entero positivo.`)
    return { ...l, _pciC: aCent(pci), _cant: cant }
  })

  if (lineas.length === 0) {
    return { lineas: [], subtotal: 0, itbis: 0, total: 0, totalPactado: 0, residuo: 0, diferencia: 0, exacto: true }
  }
  const totalPactadoC = lineas.reduce((s, l) => s + l._pciC * l._cant, 0)

  // 1) Precio base por línea y subtotal de partida (todo en centavos).
  for (const l of lineas) l._puC = Math.round(l._pciC / (1 + tasa))
  const subBaseC = lineas.reduce((s, l) => s + l._puC * l._cant, 0)

  // 2) ¿Qué subtotales son ALCANZABLES? Mover 1 centavo en un unitario de
  //    cantidad N desplaza el subtotal en N centavos, así que el conjunto
  //    alcanzable es { subBase + k*g }, con g = gcd(cantidades). Se elige el k
  //    cuyo total quede más cerca del pactado — y se prefiere el |k| menor,
  //    para no deformar los unitarios más de lo imprescindible.
  //    OJO: no siempre existe cuadre exacto. Con una sola línea de cantidad 3
  //    el subtotal solo salta de 3 en 3, y el objetivo puede caer entre dos
  //    escalones. En ese caso se devuelve el mejor posible y `exacto:false`;
  //    mentir con un total que no cierra sería peor que reportarlo.
  const mcd = (a, b) => (b === 0 ? a : mcd(b, a % b))
  const g = lineas.reduce((acc, l) => mcd(acc, l._cant), 0) || 1
  // CRÍTICO: el ITBIS se calcula con la MISMA aritmética que pos/service.js
  // (`Math.round(subtotalEnPesos * tasa * 100) / 100`), no con enteros. Da el
  // mismo valor salvo cuando el impuesto cae exactamente en medio centavo:
  // ahí el orden de operaciones decide el redondeo y las dos vías divergen 1
  // centavo. Este helper existe para PREDECIR lo que el service va a guardar,
  // así que replica su aritmética aunque sea la menos elegante.
  const itbisDe = SC => Math.round((SC / 100) * tasa * 100)
  const totalDe = SC => SC + itbisDe(SC)
  let mejorK = 0, mejorDif = Math.abs(totalDe(subBaseC) - totalPactadoC)
  for (let paso = 1; paso <= 40 && mejorDif !== 0; paso++) {
    for (const k of [-paso, paso]) {
      const S = subBaseC + k * g
      if (S < 0) continue
      const dif = Math.abs(totalDe(S) - totalPactadoC)
      if (dif < mejorDif) { mejorDif = dif; mejorK = k }
    }
  }
  const objetivoC = subBaseC + mejorK * g

  // 3) Repartir el desplazamiento entre los unitarios. Greedy primero (resuelve
  //    el caso común en una pasada); si deja resto, DP acotada sobre coeficientes
  //    pequeños, que sí encuentra combinaciones mixtas tipo 6*(+1) + 4*(-1) = +2
  //    donde el greedy se queda corto.
  let resto = objetivoC - subBaseC;
  for (const l of [...lineas].sort((a, b) => b._cant - a._cant)) {
    if (resto === 0) break
    const paso = Math.trunc(resto / l._cant)
    if (paso !== 0 && l._puC + paso >= 0) { l._puC += paso; resto -= paso * l._cant }
  }
  if (resto !== 0) {
    const combo = _repartirCentavos(lineas.map(l => l._cant), resto)
    if (combo) {
      combo.forEach((a, i) => { lineas[i]._puC += a })
      resto = 0
    }
  }

  // 4) Totales recalculados EXACTAMENTE como lo hace pos/service.js, para que
  //    lo que promete este helper sea lo que la factura termine guardando.
  const subtotalC = lineas.reduce((s, l) => s + Math.round(l._puC * l._cant), 0)
  const itbisC    = itbisDe(subtotalC)
  const totalC    = subtotalC + itbisC
  return {
    lineas: lineas.map(l => ({
      ...Object.fromEntries(Object.entries(l).filter(([k]) => !k.startsWith('_'))),
      precioUnitario: l._puC / 100,
      ajuste: Math.round(l._puC - l._pciC / (1 + tasa)) / 100,
    })),
    subtotal:     subtotalC / 100,
    itbis:        itbisC / 100,
    total:        totalC / 100,
    totalPactado: totalPactadoC / 100,
    residuo:      resto,
    diferencia:   (totalC - totalPactadoC) / 100,
    exacto:       totalC === totalPactadoC,
  }
}

// Busca coeficientes enteros pequeños a_i tales que Σ a_i * cant_i === objetivo.
// DP por capas sobre las sumas alcanzables, acotada en magnitud para que el
// costo sea trivial (los ajustes reales son de pocos centavos). Devuelve null
// si no hay combinación dentro de las cotas.
function _repartirCentavos(cants, objetivo, maxCoef = 4, maxSuma = 400) {
  if (objetivo === 0) return cants.map(() => 0)
  if (Math.abs(objetivo) > maxSuma) return null
  let dp = new Map([[0, cants.map(() => 0)]])
  for (let i = 0; i < cants.length; i++) {
    const siguiente = new Map(dp)
    for (const [suma, coefs] of dp) {
      for (let a = -maxCoef; a <= maxCoef; a++) {
        if (a === 0) continue
        const nueva = suma + a * cants[i]
        if (Math.abs(nueva) > maxSuma || siguiente.has(nueva)) continue
        const nc = [...coefs]; nc[i] = a
        siguiente.set(nueva, nc)
      }
    }
    dp = siguiente
    if (dp.has(objetivo)) return dp.get(objetivo)
  }
  return dp.get(objetivo) ?? null
}
module.exports.desglosarItbis = desglosarItbis
