/**
 * backend/shared/env.js — L1.3 Validación rígida de variables de entorno al boot.
 *
 * Schema Zod estricto que se valida UNA sola vez al cargar el módulo. Si
 * alguna variable crítica falta o tiene formato inválido, imprime un reporte
 * legible y termina el proceso con código 1 ANTES de aceptar el primer
 * request. Prefiere "no boot" a "boot inseguro".
 *
 * Importar TEMPRANO en server.js (antes de cualquier código que use process.env).
 *
 *   const env = require('./shared/env');
 *
 * Documentación de rotación: backend/scripts/security/README.md
 */

const { z } = require('zod');

const isProd = process.env.NODE_ENV === 'production';

const Url = z.string()
  .trim()
  .min(1, 'requerida')
  .refine((v) => /^(postgres(?:ql)?|https?):\/\//.test(v), 'debe ser una URL válida (postgres://, postgresql://, http(s)://)');

const Secret32 = z.string()
  .trim()
  .min(32, 'mínimo 32 caracteres (anti brute-force)');

const CorsList = z.string()
  .trim()
  .min(1, 'requerida — lista CSV de orígenes permitidos')
  .refine(
    (v) => v.split(',').map((s) => s.trim()).filter(Boolean).every((o) => /^https?:\/\/[^,\s]+$/.test(o)),
    'cada origen debe ser http(s)://host:port sin espacios ni comas internas',
  );

const schema = z.object({
  DATABASE_URL:  Url.describe('PostgreSQL connection string (Prisma client)'),
  DIRECT_URL:    Url.describe('PostgreSQL direct (sin pooler) — Prisma migrate'),
  JWT_SECRET:    Secret32.describe('HS256 firma de access tokens'),
  AUDIT_SECRET:  Secret32.describe('HMAC-SHA256 hash-chain AuditLog/AuditCaja'),
  CORS_ORIGIN:   CorsList.describe('Lista CSV de orígenes permitidos por cors()'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  process.stderr.write(
    '\n══════════════════════════════════════════════════════════════════════\n' +
    `[ENV BOOT FAIL] variables de entorno inválidas o ausentes (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}):\n` +
    issues +
    '\n──────────────────────────────────────────────────────────────────────\n' +
    'Política L1.3 (CLAUDE.md): el servidor NO arranca con credenciales\n' +
    'corruptas o ausentes. Verifica el archivo .env o el panel de variables\n' +
    'de Render Dashboard antes de re-desplegar. process.exit(1).\n' +
    '══════════════════════════════════════════════════════════════════════\n',
  );
  process.exit(1);
}

// Snapshot inmutable. Resto del código debe consumir `env.X` (no `process.env.X`)
// para garantizar que la validación se ejecutó.
const env = Object.freeze({
  ...parsed.data,
  isProd,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
});

if (!isProd) {
  // Eco silencioso para confirmar boot OK en dev. CERO secrets en el log.
  process.stdout.write(`[ENV BOOT OK] schema válido · ${Object.keys(parsed.data).length} vars verificadas\n`);
}

module.exports = env;
