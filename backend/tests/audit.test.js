/**
 * backend/tests/audit.test.js
 *
 * Tests unitarios del auditor de huérfanos (`backend/prisma/seeds/_audit.js`).
 * Stubea prisma en memoria para validar:
 *   1) Sin empleados soft-deleted → totalHuerfanos = 0 (path corto).
 *   2) Con N empleados soft-deleted → suma huérfanos por tabla correcta.
 *   3) formatReport produce línea grep-friendly con prefix [AUDIT:orphans].
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { runAudit, formatReport } = require('../prisma/seeds/_audit');

// ─── Helpers de mock ────────────────────────────────────────────────────────
function makePrismaStub({ empleadosSoftDeleted = [], prefs = [], sessions = [], webauthn = [] } = {}) {
  // Cuenta filas cuyo empleadoId está en el set `where.empleadoId.in`.
  const countIn = (rows, where) => {
    if (!where?.empleadoId?.in) return rows.length;
    const set = new Set(where.empleadoId.in);
    return rows.filter((r) => set.has(r.empleadoId)).length;
  };
  const findIn = (rows, where, take) => {
    const set = new Set(where?.empleadoId?.in ?? []);
    return rows.filter((r) => set.has(r.empleadoId)).slice(0, take ?? 5);
  };

  return {
    empleado: {
      findMany: async ({ where }) => {
        if (where?.deletedAt?.not === null) {
          return empleadosSoftDeleted.map((id) => ({ id }));
        }
        return [];
      },
    },
    usuarioPreferenciasPOS: {
      count:    async ({ where } = {}) => countIn(prefs, where),
      findMany: async ({ where, take }) => findIn(prefs, where, take),
    },
    sessionToken: {
      count:    async ({ where } = {}) => countIn(sessions, where),
      findMany: async ({ where, take }) => findIn(sessions, where, take),
    },
    webAuthnCredential: {
      count:    async ({ where } = {}) => countIn(webauthn, where),
      findMany: async ({ where, take }) => findIn(webauthn, where, take),
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────
test('runAudit — sin empleados soft-deleted → totalHuerfanos = 0 (path corto)', async () => {
  const prisma = makePrismaStub({
    empleadosSoftDeleted: [],
    prefs:    [{ empleadoId: 1 }, { empleadoId: 2 }],
    sessions: [{ empleadoId: 1 }],
    webauthn: [],
  });
  const r = await runAudit({ prisma });
  assert.equal(r.ok, true);
  assert.equal(r.empleadosSoftDeleted, 0);
  assert.equal(r.totalHuerfanos, 0);
  assert.equal(r.tablas.usuarioPreferenciasPOS.total, 2);
  assert.equal(r.tablas.sessionToken.total, 1);
  assert.equal(r.tablas.webauthnCredential.total, 0);
});

test('runAudit — con empleados muertos cuenta huérfanos en cada tabla', async () => {
  const prisma = makePrismaStub({
    empleadosSoftDeleted: [42, 43],
    prefs:    [{ empleadoId: 42 }, { empleadoId: 1 }],
    sessions: [{ empleadoId: 42 }, { empleadoId: 43 }, { empleadoId: 1 }],
    webauthn: [{ empleadoId: 43 }],
  });
  const r = await runAudit({ prisma });
  assert.equal(r.empleadosSoftDeleted, 2);
  assert.equal(r.tablas.usuarioPreferenciasPOS.huerfanos, 1);
  assert.equal(r.tablas.usuarioPreferenciasPOS.total,     2);
  assert.equal(r.tablas.sessionToken.huerfanos,           2);
  assert.equal(r.tablas.sessionToken.total,               3);
  assert.equal(r.tablas.webauthnCredential.huerfanos,     1);
  assert.equal(r.tablas.webauthnCredential.total,         1);
  assert.equal(r.totalHuerfanos, 4);
  assert.deepEqual(r.tablas.usuarioPreferenciasPOS.sampleIds, [42]);
  assert.deepEqual(r.tablas.sessionToken.sampleIds.sort(), [42, 43]);
  assert.deepEqual(r.tablas.webauthnCredential.sampleIds, [43]);
});

test('runAudit — lanza si prisma faltante', async () => {
  await assert.rejects(() => runAudit({}), /prisma required/);
});

test('formatReport — produce línea con prefix [AUDIT:orphans] y campos clave', () => {
  const fake = {
    empleadosSoftDeleted: 5,
    totalHuerfanos: 7,
    tablas: {
      usuarioPreferenciasPOS: { huerfanos: 3, total: 20 },
      sessionToken:           { huerfanos: 2, total: 15 },
      webauthnCredential:     { huerfanos: 2, total: 8 },
    },
  };
  const line = formatReport(fake);
  assert.ok(line.startsWith('[AUDIT:orphans]'));
  assert.match(line, /empleados_soft_deleted=5/);
  assert.match(line, /total_huerfanos=7/);
  assert.match(line, /prefs=3\/20/);
  assert.match(line, /session=2\/15/);
  assert.match(line, /webauthn=2\/8/);
});
