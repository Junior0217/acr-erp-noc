#!/usr/bin/env node
/**
 * check-null-bytes.cjs
 *
 * Falla si algún archivo staged de código fuente contiene un byte null (0x00).
 * Esos bytes hacen que git trate el archivo como BINARIO → rompen diffs, blame
 * y code-review. Origen típico: caracteres de control pegados LITERALES dentro
 * de un regex (p.ej. `/[<NUL>-<US>]/`) en vez de escapados (`/[\x00-\x1f]/`).
 *
 * Se invoca desde .githooks/pre-commit (core.hooksPath=.githooks). Idempotente,
 * sin dependencias. Si no hay git o no hay archivos staged, no bloquea.
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const EXT = /\.(js|jsx|ts|tsx|cjs|mjs)$/i;

let staged = [];
try {
  staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => EXT.test(f));
} catch {
  process.exit(0); // sin git / entorno raro → no bloquea
}

const offenders = [];
for (const f of staged) {
  try {
    if (fs.readFileSync(f).includes(0x00)) offenders.push(f);
  } catch { /* archivo movido/borrado entre stage y check — ignorar */ }
}

if (offenders.length) {
  console.error('\n✖ commit bloqueado: byte null (0x00) en archivo(s) de codigo:');
  for (const f of offenders) console.error('   - ' + f);
  console.error('\nSuele ser un caracter de control LITERAL en un regex. Usa escapes (\\x00) o limpia el byte.\n');
  process.exit(1);
}

process.exit(0);
