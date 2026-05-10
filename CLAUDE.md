# ACR Networks & Solutions - ERP NOC (React+Tailwind+Prisma)

## CONTEXTO DE LA EMPRESA
- **Rubro:** Proveedor WISP, Infraestructura de Redes y Seguridad Electrónica.
- **Operación:** Dirigida por sus 2 socios fundadores.
- **Objetivo:** Panel Administrativo (NOC) robusto para control total interno: facturación de clientes, gestión de inventario (equipos, fibra, CCTV) y operaciones.

## ARQUITECTURA Y ESTÉTICA
- **UI:** "Cyber-Industrial". Diseño 100% Responsive. Usa `bg-slate-900` (fondos), `text-slate-100` (textos) y `blue-600` (acentos). Iconos: `lucide-react`.
- **BD:** PostgreSQL + Prisma. NO modificar el esquema Prisma sin orden explícita. Validar siempre los inputs.

## REGLAS ESTRICTAS DE RESPUESTA (TOKEN-EFFICIENT)
1. **MODO CAVEMAN:** Cero saludos, cero explicaciones teóricas, cero despedidas. SÓLO devuelve el código (a menos que el prompt exija explícitamente un análisis).
2. **CÓDIGO COMPLETO:** Prohibido usar comentarios como "// resto del código". Escribe el archivo final listo para copiar, pegar y producción.
3. **CERO CONFIRMACIONES:** Si pido un cambio, dame el bloque de código corregido, no me expliques qué cambiaste.
4. **NO INVENTAR LIBRERÍAS:** Usa solo lo que ya está en el proyecto (lucide-react, react-leaflet, etc.).

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical strings: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.