#!/usr/bin/env node
/**
 * Hook PostToolUse · Auto-Check Backend.
 *
 * Si Claude edita o escribe un archivo en backend/**\/*.js, corre
 * `node --check <file>`. Si falla, sale con código 2 para que el
 * harness reporte error y Claude vea la salida.
 *
 * El path del archivo modificado viene en CLAUDE_FILE_PATH (variable
 * de entorno que inyecta el harness). Cross-platform: normaliza
 * separadores Windows.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');

const rawPath = process.env.CLAUDE_FILE_PATH || '';
if (!rawPath) process.exit(0);

const norm = rawPath.replace(/\\/g, '/');

// Solo aplica a JS dentro de backend/ (excluye node_modules y prisma/migrations
// SQL que ya están protegidos por el PreToolUse hook).
if (!norm.includes('/backend/'))            process.exit(0);
if (norm.includes('/node_modules/'))        process.exit(0);
if (!norm.endsWith('.js'))                  process.exit(0);
if (!fs.existsSync(rawPath))                process.exit(0);

const res = spawnSync('node', ['--check', rawPath], { stdio: 'inherit' });
if (res.status !== 0) {
  process.stderr.write(`\n[hook:post-check] node --check FAIL → ${rawPath}\n`);
  process.exit(2);
}
process.exit(0);
