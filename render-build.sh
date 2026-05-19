#!/usr/bin/env bash
# render-build.sh
#
# Build script para Render. Usar este path en el Render Dashboard:
#   Build Command:  bash render-build.sh
#   Start Command:  pnpm --filter erp-acr-backend start
#
# Migrado de `npm ci` → `pnpm install --frozen-lockfile` (Nov 2025) para
# hardening supply-chain (post-TanStack hack). pnpm 11 con allowBuilds
# explícito en pnpm-workspace.yaml bloquea postinstall scripts de
# transitivos no aprobados — defensa contra malware npm.

set -euo pipefail

echo "════════════════════════════════════════════════════════════════"
echo "  ACR ERP NOC · Build Render (pnpm 11)"
echo "════════════════════════════════════════════════════════════════"
echo "  Node version : $(node -v)"
echo "  npm  version : $(npm -v)"

# Habilitar pnpm via corepack (Render trae Node + corepack por default).
echo "→ Habilitando pnpm via corepack..."
corepack enable
corepack prepare pnpm@11 --activate

echo "  pnpm version : $(pnpm -v)"
echo

# Frozen-lockfile: NO modifica pnpm-lock.yaml. Si el lock no coincide con
# package.json, FALLA → previene drift silencioso en producción.
# Filter --prod NO: Prisma + scripts del backend pueden requerir devDeps
# transitivos. Si querés reducir tamaño en Render: agregar `--prod` cuando
# confirmes que ninguna dep dev del backend se necesita en runtime.
echo "→ pnpm install --frozen-lockfile (workspace recursive)..."
pnpm install --frozen-lockfile

# Frontend bundle NO se construye acá: Vercel lo sirve. Render solo expone
# el API Express. Build cross-cliente eliminado para desacoplar deploys.

# Prisma generate explícito (idempotente; backend.postinstall ya lo corre,
# pero declararlo acá hace el flow legible y resistente a cambios).
echo "→ Prisma generate..."
pnpm --filter erp-acr-backend exec prisma generate

# Aplicar migrations pendientes. Si una migration nueva falla, abort el
# deploy ANTES de que server.js arranque y sirva tráfico con schema viejo.
echo "→ Prisma migrate deploy..."
pnpm --filter erp-acr-backend exec prisma migrate deploy

echo
echo "✓ Build OK. Render arrancará con Start Command:"
echo "  pnpm --filter erp-acr-backend start"
