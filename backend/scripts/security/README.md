# Scripts de mantenimiento de seguridad

Scripts manuales para auditoría y aplicación de migrations security cuando el
flujo automático de Render no aplica (ej. Render Dashboard sin `DIRECT_URL`
configurada, o servicio en modo Manual que ignora `render.yaml`).

⚠️ **Todos los scripts leen `DATABASE_URL` desde `backend/.env` via `dotenv`**.
El password jamás aparece en CLI ni en logs. Asegurate que `backend/.env`
apunte a la DB correcta antes de correr.

## `verify-schema-prod.cjs`

Audita el schema real contra lo que las migrations security esperan.
Lista migrations en `_prisma_migrations` + chequea existencia de objetos
(tablas, columnas, CHECK, triggers). Read-only.

```
node backend/scripts/security/verify-schema-prod.cjs
```

## `preflight-stock-check.cjs`

Pre-flight para la migration `20260518130000_stock_nonneg_check`. Cuenta
filas con `Producto.stockActual < 0` y `ItemCatalogo.stock < 0` antes de
que el CHECK constraint las normalice. Read-only.

```
node backend/scripts/security/preflight-stock-check.cjs
```

## `apply-security-migrations.cjs`

Aplica las 4 migrations security (`20260518130000`–`20260518160000`) vía
pooler Supabase, leyendo cada `migration.sql`, ejecutando statements
individuales con `prisma.$executeRawUnsafe` (compatible con pgbouncer
transaction-mode), y registrando en `_prisma_migrations` con checksum
SHA-256 real para que futuros `prisma migrate deploy` no fallen por
checksum mismatch.

**Idempotente**: skip si la migration ya está en `_prisma_migrations`.

```
node backend/scripts/security/apply-security-migrations.cjs
```

⚠️ Este script SOLO debe correrse cuando se confirme via
`verify-schema-prod.cjs` que las migrations security NO están aplicadas
y que `prisma migrate deploy` no puede correr (DIRECT_URL faltante, o IP
restringida del operador).
