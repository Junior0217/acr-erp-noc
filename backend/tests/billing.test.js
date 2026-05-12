// node --test tests/billing.test.js
const { test } = require('node:test')
const assert   = require('node:assert/strict')

// ── Pure billing math extracted from procesarFacturaPOS ──────────────────────

function totalLinea(precioUnitario, descuentoPct, descuentoMonto, cantidad) {
  const bruto = precioUnitario * cantidad
  const desc  = descuentoPct > 0
    ? Math.round(bruto * (descuentoPct / 100) * 100) / 100
    : Math.min(descuentoMonto, bruto)
  return Math.round((bruto - desc) * 100) / 100
}

function calcTotals(lineas, descuentoGlobalPct, descuentoGlobalMonto, applyItbis) {
  const subtotalBruto = Math.round(
    lineas.reduce((s, l) => s + totalLinea(l.precioUnitario, l.descuentoPct ?? 0, l.descuentoMonto ?? 0, l.cantidad), 0)
    * 100) / 100
  const globalDesc = descuentoGlobalPct > 0
    ? Math.round(subtotalBruto * (descuentoGlobalPct / 100) * 100) / 100
    : Math.min(descuentoGlobalMonto, subtotalBruto)
  const subtotal  = Math.round((subtotalBruto - globalDesc) * 100) / 100
  const itbisAmt  = applyItbis ? Math.round(subtotal * 0.18 * 100) / 100 : 0
  const total     = Math.round((subtotal + itbisAmt) * 100) / 100
  return { subtotalBruto, globalDesc, subtotal, itbisAmt, total }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('single line, no discount, no ITBIS', () => {
  const r = calcTotals([{ precioUnitario: 100, cantidad: 2 }], 0, 0, false)
  assert.equal(r.subtotalBruto, 200)
  assert.equal(r.globalDesc,    0)
  assert.equal(r.subtotal,      200)
  assert.equal(r.itbisAmt,      0)
  assert.equal(r.total,         200)
})

test('single line, no discount, with ITBIS 18%', () => {
  const r = calcTotals([{ precioUnitario: 1000, cantidad: 1 }], 0, 0, true)
  assert.equal(r.itbisAmt, 180)
  assert.equal(r.total,    1180)
})

test('line-level percentage discount', () => {
  // 1000 * 10% = 100 off → subtotal 900
  const r = calcTotals([{ precioUnitario: 1000, cantidad: 1, descuentoPct: 10 }], 0, 0, false)
  assert.equal(r.subtotalBruto, 900)
  assert.equal(r.total,         900)
})

test('line-level fixed amount discount', () => {
  // 500 - 50 = 450
  const r = calcTotals([{ precioUnitario: 500, cantidad: 1, descuentoMonto: 50 }], 0, 0, false)
  assert.equal(r.subtotalBruto, 450)
  assert.equal(r.total,         450)
})

test('global percentage discount applied after line subtotals', () => {
  // 2 lines: 500 + 300 = 800 bruto → 10% global = 80 → subtotal 720
  const r = calcTotals(
    [{ precioUnitario: 500, cantidad: 1 }, { precioUnitario: 300, cantidad: 1 }],
    10, 0, false,
  )
  assert.equal(r.subtotalBruto, 800)
  assert.equal(r.globalDesc,    80)
  assert.equal(r.subtotal,      720)
  assert.equal(r.total,         720)
})

test('global fixed discount capped at subtotal', () => {
  const r = calcTotals([{ precioUnitario: 100, cantidad: 1 }], 0, 999, false)
  assert.equal(r.globalDesc, 100)
  assert.equal(r.subtotal,   0)
  assert.equal(r.total,      0)
})

test('ITBIS applied on post-discount subtotal', () => {
  // 1000 bruto, 20% global = 800 subtotal, ITBIS on 800 = 144
  const r = calcTotals([{ precioUnitario: 1000, cantidad: 1 }], 20, 0, true)
  assert.equal(r.subtotal,  800)
  assert.equal(r.itbisAmt,  144)
  assert.equal(r.total,     944)
})

test('multi-line mixed ARTICULO + SERVICIO, ITBIS', () => {
  const lineas = [
    { precioUnitario: 2500, cantidad: 2 },
    { precioUnitario: 1200, cantidad: 1, descuentoPct: 5 },
  ]
  // line1 = 5000, line2 = 1200 * (1-0.05) = 1140 → bruto = 6140
  // no global discount, ITBIS on 6140 = 1105.20
  const r = calcTotals(lineas, 0, 0, true)
  assert.equal(r.subtotalBruto, 6140)
  assert.equal(r.itbisAmt,      1105.2)
  assert.equal(r.total,         7245.2)
})

test('rounding: fractional cents round correctly', () => {
  // 3 items at 0.333 each → 0.999, should round to 1.00
  const r = calcTotals([{ precioUnitario: 0.333, cantidad: 3 }], 0, 0, false)
  assert.equal(r.total, 1)
})

test('zero-price line allowed (free item)', () => {
  const r = calcTotals([{ precioUnitario: 0, cantidad: 1 }], 0, 0, true)
  assert.equal(r.total, 0)
})

test('percentage and amount discount: pct wins when pct > 0', () => {
  // both pct=10 and monto=500 set; pct wins because descuentoPct > 0
  const r = calcTotals([{ precioUnitario: 1000, cantidad: 1, descuentoPct: 10, descuentoMonto: 500 }], 0, 0, false)
  // pct discount: 1000 * 10% = 100 off
  assert.equal(r.subtotalBruto, 900)
})
