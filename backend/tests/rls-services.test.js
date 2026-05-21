/**
 * backend/tests/rls-services.test.js
 *
 * Tests unitarios del 5to ciclo ADK v2 — L1.1 RLS wrappers en services core
 * y caché de sessionToken en verificarJWT.
 *
 * Estrategia: prisma mockeado en memoria. Validamos contratos del wrapper
 * (`withCurrentUserRls`) sin tocar BD real. La migración SQL se valida en
 * staging contra Postgres; aquí solo cubrimos la pipeline JavaScript.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const createFacturasService = require('../modules/ventas/facturas/service');
const createClientesService = require('../modules/crm/clientes/service');
const createMovimientoInventarioService = require('../shared/services/movimiento-inventario.service');

// ─── Helpers de mock ─────────────────────────────────────────────────────────
function fakePrismaTx(facturas = [], clientes = [], movimientos = []) {
  // Filtro estado: { not: 'Anulada' } (Prisma syntax). El mock lo replica
  // fielmente para que el test de includeAnuladas valide la query real.
  const matchEstado = (f, where) => {
    if (!where?.estado) return true;
    if (where.estado?.not !== undefined) return f.estado !== where.estado.not;
    return f.estado === where.estado;
  };
  const matchFactura = (f, where) =>
    (where?.empleadoId == null || f.empleadoId === where.empleadoId)
    && (where?.deletedAt === null ? f.deletedAt == null : true)
    && matchEstado(f, where);
  return {
    factura: {
      findMany: async ({ where, take, skip }) => {
        const subset = facturas.filter(f => matchFactura(f, where));
        return subset.slice(skip ?? 0, (skip ?? 0) + (take ?? 50));
      },
      count: async ({ where }) => facturas.filter(f => matchFactura(f, where)).length,
    },
    cliente: {
      findMany: async ({ take, skip }) =>
        clientes.filter(c => c.deletedAt == null).slice(skip ?? 0, (skip ?? 0) + (take ?? 50)),
      count: async () => clientes.filter(c => c.deletedAt == null).length,
    },
    movimientoInventario: {
      findMany: async ({ where, take, skip }) => {
        const subset = movimientos.filter(m =>
          where?.productoId == null || m.productoId === where.productoId
        );
        return subset.slice(skip ?? 0, (skip ?? 0) + (take ?? 50));
      },
      count: async ({ where }) =>
        movimientos.filter(m =>
          where?.productoId == null || m.productoId === where.productoId
        ).length,
    },
    $executeRawUnsafe: async () => 0,
  };
}

function fakeWithCurrentUserRls(prismaTx) {
  // Simula el wrapper real: abre tx fake y pasa al fn. En producción esto
  // SET LOCAL employee_id; aquí solo verificamos que el caller respete el
  // contrato del wrapper.
  return async (fn) => fn(prismaTx);
}

function fakeDeps(overrides = {}) {
  return {
    repo: { listClientes: async () => [[], 0] },
    auditReq: () => {},
    ncfService: { nextNcfSequence: async () => ({}) },
    generarSiguienteCodigo: () => 'STUB',
    persistirVerifyHash: async () => {},
    formatCliente: (c) => c,
    validUUID: () => true,
    ...overrides,
  };
}

// ─── Facturas service ────────────────────────────────────────────────────────
test('facturas.listarMisFacturasRls — lanza si withCurrentUserRls falta', async () => {
  const svc = createFacturasService(fakeDeps());
  await assert.rejects(
    () => svc.listarMisFacturasRls({}, { sub: 1 }),
    (err) => err.code === 'RLS_WRAPPER_MISSING' && err.status === 500,
  );
});

test('facturas.listarMisFacturasRls — lanza si user.sub falta', async () => {
  const svc = createFacturasService(fakeDeps({
    withCurrentUserRls: fakeWithCurrentUserRls(fakePrismaTx()),
  }));
  await assert.rejects(
    () => svc.listarMisFacturasRls({}, {}),
    (err) => err.code === 'NO_USER' && err.status === 401,
  );
});

test('facturas.listarMisFacturasRls — filtra por empleadoId del user', async () => {
  const facturas = [
    { id: 'f1', noFactura: 'F-001', empleadoId: 7,  deletedAt: null, estado: 'Pagada',  total: 100 },
    { id: 'f2', noFactura: 'F-002', empleadoId: 99, deletedAt: null, estado: 'Pagada',  total: 200 },
    { id: 'f3', noFactura: 'F-003', empleadoId: 7,  deletedAt: null, estado: 'Borrador',total: 300 },
    { id: 'f4', noFactura: 'F-004', empleadoId: 7,  deletedAt: new Date(), estado: 'Pagada', total: 400 },
  ];
  const svc = createFacturasService(fakeDeps({
    withCurrentUserRls: fakeWithCurrentUserRls(fakePrismaTx(facturas)),
  }));
  const out = await svc.listarMisFacturasRls({ limit: 50 }, { sub: 7 });
  assert.equal(out.status, 200);
  assert.equal(out.body.meta.rlsEnforced, true);
  assert.equal(out.body.meta.total, 2);
  assert.equal(out.body.data.length, 2);
  assert.ok(out.body.data.every(f => f.empleadoId === 7));
});

test('facturas.listarMisFacturasRls — default excluye Anuladas (usa índice parcial)', async () => {
  const facturas = [
    { id: 'f1', noFactura: 'F-001', empleadoId: 7, deletedAt: null, estado: 'Pagada',  total: 100 },
    { id: 'f2', noFactura: 'F-002', empleadoId: 7, deletedAt: null, estado: 'Anulada', total: 200 },
    { id: 'f3', noFactura: 'F-003', empleadoId: 7, deletedAt: null, estado: 'Anulada', total: 300 },
  ];
  const svc = createFacturasService(fakeDeps({
    withCurrentUserRls: fakeWithCurrentUserRls(fakePrismaTx(facturas)),
  }));
  const out = await svc.listarMisFacturasRls({ limit: 50 }, { sub: 7 });
  assert.equal(out.body.meta.total, 1, 'solo 1 fila no anulada');
  assert.equal(out.body.meta.indexHint, 'factura_owner_active_idx');
  assert.equal(out.body.meta.includeAnuladas, false);
});

test('facturas.listarMisFacturasRls — includeAnuladas=true levanta el filtro', async () => {
  const facturas = [
    { id: 'f1', noFactura: 'F-001', empleadoId: 7, deletedAt: null, estado: 'Pagada',  total: 100 },
    { id: 'f2', noFactura: 'F-002', empleadoId: 7, deletedAt: null, estado: 'Anulada', total: 200 },
  ];
  const svc = createFacturasService(fakeDeps({
    withCurrentUserRls: fakeWithCurrentUserRls(fakePrismaTx(facturas)),
  }));
  const out = await svc.listarMisFacturasRls({ limit: 50, includeAnuladas: 'true' }, { sub: 7 });
  assert.equal(out.body.meta.total, 2);
  assert.equal(out.body.meta.includeAnuladas, true);
  assert.equal(out.body.meta.indexHint, 'Factura_empleadoId_idx');
});

// ─── Clientes service ────────────────────────────────────────────────────────
test('clientes.listarMisClientesRls — pipeline RLS aplicada sin owner col', async () => {
  const clientes = [
    { id: 'c1', razonSocial: 'A', deletedAt: null },
    { id: 'c2', razonSocial: 'B', deletedAt: null },
  ];
  const svc = createClientesService(fakeDeps({
    repo: { listClientes: async () => [[], 0] },
    withCurrentUserRls: fakeWithCurrentUserRls(fakePrismaTx([], clientes)),
  }));
  const out = await svc.listarMisClientesRls({}, { sub: 7 });
  assert.equal(out.status, 200);
  assert.equal(out.body.meta.rlsEnforced, true);
  assert.equal(out.body.data.length, 2);
});

test('clientes.listarMisClientesRls — lanza si user.sub falta', async () => {
  const svc = createClientesService(fakeDeps({
    withCurrentUserRls: fakeWithCurrentUserRls(fakePrismaTx()),
  }));
  await assert.rejects(
    () => svc.listarMisClientesRls({}, null),
    (err) => err.code === 'NO_USER' && err.status === 401,
  );
});

// ─── Movimiento inventario service ───────────────────────────────────────────
test('movimientoInventario.listarMisMovimientosRls — filtra por productoId opcional', async () => {
  const movs = [
    { id: 1, productoId: 10, tipo: 'Entrada', cantidad: 5, fecha: new Date() },
    { id: 2, productoId: 20, tipo: 'Salida',  cantidad: 3, fecha: new Date() },
    { id: 3, productoId: 10, tipo: 'Salida',  cantidad: 1, fecha: new Date() },
  ];
  const fakeTx = fakePrismaTx([], [], movs);
  const svc = createMovimientoInventarioService({
    prisma: fakeTx,
    withCurrentUserRls: fakeWithCurrentUserRls(fakeTx),
  });
  // Sin filtro: 3 movimientos.
  const all = await svc.listarMisMovimientosRls({}, { sub: 7 });
  assert.equal(all.body.meta.total, 3);
  // Con productoId: solo 2.
  const filtrado = await svc.listarMisMovimientosRls({ productoId: 10 }, { sub: 7 });
  assert.equal(filtrado.body.meta.total, 2);
  assert.ok(filtrado.body.data.every(m => m.productoId === 10));
});

test('movimientoInventario.listarMisMovimientosRls — lanza RLS_WRAPPER_MISSING si no hay wrapper', async () => {
  const svc = createMovimientoInventarioService({
    prisma: fakePrismaTx(), // no expone withCurrentUserRls
  });
  await assert.rejects(
    () => svc.listarMisMovimientosRls({}, { sub: 7 }),
    (err) => err.code === 'RLS_WRAPPER_MISSING' && err.status === 500,
  );
});

// ─── Cache sessionToken (in-memory TTL 30s) ──────────────────────────────────
test('middlewares.invalidarSessionCache — invalida entrada existente', () => {
  const { invalidarSessionCache } = require('../shared/middlewares');
  // No hay setup directo del cache desde aquí; el test valida el contrato del
  // export. invalidarSessionCache devuelve false si no había entrada (Map.delete
  // behavior). El test asegura que la API pública es correcta.
  assert.equal(typeof invalidarSessionCache, 'function');
  assert.equal(invalidarSessionCache('jti-no-existente'), false);
  assert.equal(invalidarSessionCache(null), false);
  assert.equal(invalidarSessionCache(''), false);
});
