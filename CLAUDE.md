# ACR Networks & Solutions - ERP NOC (React+Tailwind+Prisma)

## CONTEXTO DE LA EMPRESA
- **Rubro:** Proveedor WISP, Infraestructura de Redes y Seguridad Electrónica.
- **Operación:** Dirigida por sus 2 socios fundadores.
- **Objetivo:** Panel Administrativo (NOC) robusto para control total interno: facturación de clientes, gestión de inventario (equipos, fibra, CCTV) y operaciones.

## ARQUITECTURA Y ESTÉTICA
- **UI:** "Cyber-Industrial". Diseño 100% Responsive. Usa `bg-slate-900` (fondos), `text-slate-100` (textos) y `blue-600` (acentos). Iconos: `lucide-react`.
- **BD:** PostgreSQL + Prisma. NO modificar el esquema Prisma sin orden explícita. Validar siempre los inputs.

## ESTRUCTURA DEL PROYECTO (Hybrid C: features + shared)

### Frontend (`frontend/src/`)
```
App.jsx · main.jsx · index.css · App.css · assets/
features/
  auth/          Login.jsx
  dashboard/     Dashboard.jsx
  sales/         Ventas.jsx + panels/{PanelCatalogo, PanelOrdenes, PanelFacturas,
                 PanelCotizaciones, PanelPOS, PanelNCF, PanelAuditCaja,
                 PanelSecuencias, PanelApiEstado, PanelMiEmpresa, _shared}.jsx
  crm/           CRM.jsx + Formulario{Cliente,Prospecto,Suplidor}.jsx + MapPicker.jsx
  inventory/     Inventario.jsx + Formulario{Categoria,Producto}.jsx
  services/      Servicios.jsx + ConduceOrden, Formulario{Orden,Plan,Servicio}, FotosOT
  purchases/     Compras.jsx
  accounting/    Contabilidad.jsx
  hr/            RRHH.jsx
  workshop/      Taller.jsx
  reports/       Reportes.jsx
  map/           MapaNOC.jsx
  store/         Tienda.jsx
  company/       MiEmpresa.jsx
  settings/      Configuracion.jsx · CotizacionDGII.jsx · VerifyDocument.jsx
  portal/        CustomerPortal.jsx · PortalTracking.jsx · TrackTicket.jsx
shared/
  components/    ACRBranding, ACRLogo, CarritoSlideOver, EditorDescripcion,
                 ErrorBoundary, ImageDropzone, PdfPreviewDrawer, PWAUpdatePrompt,
                 SessionsWidget, VoiceDictationButton
  contexts/      Auth · Cart · Empresa
  hooks/         useDebounce · useOfflineStatus
  layouts/       AdminLayout
  utils/         api · exportCsv · pdf · portalApi
```

### Aliases Vite (vite.config.js → resolve.alias)
- `@`         → `src/`
- `@features` → `src/features/`
- `@shared`   → `src/shared/`

**Regla de imports:**
- Mismo feature → relativo (`./FormularioCliente`).
- Cross-feature → `@features/<otra-feature>/<archivo>`.
- Cualquier cosa de `shared/` → `@shared/<categoria>/<archivo>`.
- NUNCA `../../../../` profundo: si hace falta, es señal de mal anidado.

### Vendor chunk splitting (vite build.rollupOptions.manualChunks)
`vendor-react`, `vendor-react-router`, `vendor-dnd`, `vendor-leaflet`,
`vendor-icons`, `vendor-toast`, `vendor-pdf`, `vendor` (resto).
Cada chunk con hash inmutable → cambio en un panel solo invalida ese chunk.

### Backend (`backend/`)
```
server.js          Monolito (~9000 líneas) — NO splitear sin orden explícita
prisma/            schema.prisma + migrations/
services/          mikrotik, pdf-generator, pdf-templates
shared/            permissions.map.js
scripts/
  migrations/      asset-timeline, empresa-assets, empresa-perfil, hardening,
                   msp, ordenfoto, reconciliacion, production
  seeds/           mega, admin, enterprise, mock-data, reset-and-seed
  db-ops/          backup, hard-reset, wipe, reset-ecommerce
  security/        unlock-2fa, reset-2fa, fix-roles-and-users, setup-roles
  ops/             alerta-stock, reconciliar
```

**Ejecutar scripts:** `node backend/scripts/<categoria>/<archivo>.js`
(antes era `node backend/scripts/<archivo>.js` — los paths viejos están ROTOS).

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