/**
 * BACKUP DB — Stub para integración futura con S3 Object Lock.
 *
 * Misión inmediata: registrar la intención del backup + verificar que las
 * variables de entorno estén listas. La implementación real (pg_dump + upload)
 * se conecta cuando AWS_BACKUP_BUCKET y AWS credentials estén disponibles.
 *
 * Ejecutar:
 *   node backend/scripts/backup-db.js
 *   node backend/scripts/backup-db.js --check   (solo verifica config)
 *
 * Cron sugerido (Render): 0 3 * * *
 *
 * Diseño objetivo (cuando se conecte a S3):
 *   1. pg_dump --no-owner --no-acl $DIRECT_URL > /tmp/backup-YYYYMMDD.sql
 *   2. gzip /tmp/backup-YYYYMMDD.sql
 *   3. aws s3 cp /tmp/backup-YYYYMMDD.sql.gz s3://$AWS_BACKUP_BUCKET/acr-erp/
 *        --object-lock-mode COMPLIANCE
 *        --object-lock-retain-until-date <today+30d>
 *   4. rm /tmp/backup-YYYYMMDD.sql.gz
 *   5. Log + alerta a Carmelo si falla.
 */

const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')

function header(t) { console.log(`\n══ ${t} ══════════════════════════════════════`) }
function ok(m)     { console.log(`  ✓ ${m}`) }
function warn(m)   { console.log(`  ⚠ ${m}`) }
function fail(m)   { console.log(`  ✗ ${m}`) }

;(async () => {
  header('ACR BACKUP STUB')
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `acr-backup-${ts}.sql.gz`

  // 1. Verifica config
  const required = ['DATABASE_URL', 'DIRECT_URL']
  const optional = ['AWS_BACKUP_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']

  let configOk = true
  for (const k of required) {
    if (process.env[k]) ok(`${k} presente`)
    else { fail(`${k} FALTA — sin BD no hay backup`); configOk = false }
  }
  for (const k of optional) {
    if (process.env[k]) ok(`${k} presente`)
    else warn(`${k} ausente — upload S3 deshabilitado por ahora`)
  }

  // 2. Verifica conectividad
  const p = new PrismaClient()
  try {
    const r = await p.$queryRaw`SELECT now() AS ts, COUNT(*)::int AS empleados FROM "Empleado" WHERE "deletedAt" IS NULL`
    ok(`DB conectada · ${r[0].empleados} empleados activos · ${r[0].ts}`)
  } catch (e) {
    fail(`DB inaccesible: ${e.message}`)
    configOk = false
  } finally {
    await p.$disconnect()
  }

  if (!configOk) {
    fail('Backup abortado por config incompleta.')
    process.exit(1)
  }

  if (CHECK_ONLY) {
    console.log('\n--check OK. Sistema listo para correr backup real.')
    process.exit(0)
  }

  // 3. Stub de ejecución
  header('SIMULACION DE BACKUP')
  const stubDir = path.join(__dirname, '..', '.backup-logs')
  try { fs.mkdirSync(stubDir, { recursive: true }) } catch {}
  const logPath = path.join(stubDir, `${ts}.log`)
  const logLine =
    `[${new Date().toISOString()}] STUB · would dump → ${filename} ` +
    `· would upload to s3://${process.env.AWS_BACKUP_BUCKET ?? '(unset)'}/acr-erp/${filename} ` +
    `· retain 30 days (Object Lock COMPLIANCE)\n`
  try {
    fs.appendFileSync(logPath, logLine)
    ok(`Log escrito: ${logPath}`)
  } catch (e) { warn(`No se pudo escribir log: ${e.message}`) }

  ok(`Nombre destino: ${filename}`)
  ok(`Modo S3 Object Lock: COMPLIANCE 30 días (cuando se active)`)
  warn('IMPLEMENTACION PG_DUMP + S3 PENDIENTE — añadir credenciales AWS en .env')

  console.log('\n══ BACKUP STUB COMPLETO ═══════════════════════════════')
  process.exit(0)
})().catch(e => { console.error('\n[BACKUP ERROR]', e); process.exit(1) })
