# ACR Networks & Solutions - ERP NOC (React+Tailwind+Prisma)

## REGLA DE ENTREGA (Innegociable)

Al cerrar CUALQUIER vuelta de trabajo (refactor, feature, bugfix, doc, instalación de skill) que termine con `git commit + git push`, debes responder al usuario con un **resumen estructurado** que contenga, en este orden:

1. **Qué se hizo** — bullets cortos por archivo/módulo tocado (qué cambió + por qué).
2. **Verificación** — comandos ejecutados (`node --check`, build, tests) + resultado.
3. **Commit + push** — hash corto, branch destino, mensaje del commit, `origin/<branch>` actualizado.
4. **Próximos pasos** — 1-3 bullets accionables si quedó algo pendiente; si no, decir "nada pendiente".

Sin resumen, la tarea NO se considera entregada. Aplica incluso si el cambio es mínimo (1 línea). Si NO hubo push (porque fue solo exploración), decirlo explícito: "sin push, solo análisis".

## 5 Joyas del ERP (Skills + Stack adoptados)

Stack de productividad acordado. Cada joya tiene un rol fijo. Usar siempre que aplique antes de improvisar.

| # | Joya | Rol | Cómo se invoca | Estado |
|---|------|-----|---------------|--------|
| 1 | **The Architect** (substituto) | Planea, audita, construye | `Skill: improve-codebase-architecture` + `Skill: prototype` + `Skill: to-prd` (de mattpocock) | ✅ Vía mattpocock — original `Hainrixz/the-architect` no tiene `SKILL.md` válido |
| 2 | **Matt Pocock Skills** | Suite de razonamiento: TDD, diagnose, grill-with-docs, to-issues, zoom-out, handoff | `/diagnose`, `/tdd`, `/grill-with-docs`, etc. (todas viven en `.agents/skills/`) | ✅ 14 skills instaladas |
| 3 | **Cyber Neo** | Auditoría de seguridad (OWASP 2025 + CWE Top 25, secretos, SAST, SCA, cripto, supply-chain) | `/cyber-neo` o pedir "security audit" | ✅ Instalada |
| 4 | **Cult UI** (frontend) | Componentes Tailwind/shadcn-style + animaciones framer-motion | Copiar componente desde https://cult-ui.com/docs → pegar en `frontend/src/shared/components/ui/` → usar `cn()` de `@shared/utils/cn` | ✅ Runtime deps instaladas (`framer-motion`, `clsx`, `tailwind-merge`, `class-variance-authority`). Componentes se copian bajo demanda — ver `frontend/src/shared/components/ui/README.md` |
| 5 | **Claude Code Best Practices** | Patrón de uso del asistente (no es un paquete) | Ver bloque "Claude Code Best Practices" debajo | ✅ Documentado aquí |

### Claude Code Best Practices (cómo se usa Claude en este repo)

Reemplaza la skill "Aprende". Es el manual operativo de cómo el asistente debe trabajar contigo:

1. **CLAUDE.md es la única fuente de verdad** para reglas. Si una regla no está aquí, no existe. Cualquier petición de "recuerda esto siempre" se graba en este archivo, no en memoria volátil.
2. **Plan antes de codear** para tareas de >3 pasos. Usa `Skill: prototype` o `Skill: to-prd` cuando la decisión sea reversible-cara.
3. **TDD donde el negocio sea sensible** (fiscal, auth, caja). Usa `Skill: tdd` para forzar red → green → refactor.
4. **Diagnóstico disciplinado** ante bugs ambiguos. Usa `Skill: diagnose` (reproduce → minimiza → hipótesis → instrumenta → fix).
5. **Grill-with-docs antes de refactor grande.** Usa `Skill: grill-with-docs` para validar el plan contra `CONTEXT.md` + `docs/adr/` y actualizar docs inline.
6. **Cyber-neo antes de merge a main** si tocaste auth, vault, crypto, o supply-chain (deps nuevas).
7. **handoff cuando la sesión esté llena.** `Skill: handoff` empaqueta contexto comprimido para la próxima sesión.
8. **Respuestas concisas** (modo caveman cuando se pide); código completo (cero "// resto del código"); commits convencionales (sin Co-Authored-By Claude — ver "Reglas de commits").
9. **Sub-agents para exploración pesada.** Si el contexto va a explotar leyendo 10+ archivos, lanzar `Agent` con `subagent_type: Explore` antes de mover una línea.
10. **Cierre obligatorio**: aplicar la "REGLA DE ENTREGA" arriba — ningún push sin su resumen.

## Arquitectura Backend
Organización por Dominio (Layered LITE). Flujo estricto: router.js (solo HTTP y validación Zod) -> controller.js (orquestación) -> service.js (lógica de negocio pura, transacciones, auditoría) -> repo.js (queries de Prisma encapsuladas). No usar DAOs extras. Zod es el único DTO. Errores lanzan excepciones capturadas por un middleware central.

### Blueprint de Modularización (Directriz Estricta)

**REGLA INNEGOCIABLE:** Todo módulo nuevo o refactorizado DEBE vivir en `backend/modules/<dominio>/` (raíz del dominio, ej. `auth/`, o sub-dominio anidado, ej. `ventas/facturas/`). Cada módulo se compone de exactamente cinco archivos con responsabilidad única:

```
backend/modules/<dominio>/
  router.js       Solo rutas HTTP + middlewares de protección (verificarJWT,
                  requerirPermiso, rateLimit, CSRF). CERO lógica de negocio.
                  Recibe deps inyectadas via factory y delega a controller.
  controller.js   Pelea con HTTP: extrae req.body/params/query, valida via schema,
                  llama al service, mapea el resultado a res.status().json(). NO
                  toca Prisma, NO compone lógica, NO calcula.
  service.js      Lógica de negocio pura. Cálculos, transacciones de Prisma,
                  auditoría (auditReq), efectos colaterales (PDF, email, vault).
                  Recibe el repo + deps inyectados. NO sabe qué es Express, req
                  ni res. Lanza Error/Zod/Custom → capturado por middleware central.
  repo.js         Único punto donde se llama a prisma.<model>.<method>(). Cada
                  consulta vive como función nombrada y testeable. Encapsula
                  filtros, includes, paginación, soft-delete. NO valida, NO formatea.
  schema.js       Validadores Zod del dominio (request DTOs, response shape,
                  refinements). Re-usar emptyStr/nullStr/optIdent/optCedulaRD
                  de shared/helpers cuando aplique. Único DTO permitido.
```

**Reglas anexas (sin excepciones):**

1. **Sin código spaghetti cross-layer.** router NUNCA llama directo a prisma; controller NUNCA llama directo a prisma; service NUNCA toca res/req. La cadena es unidireccional: router → controller → service → repo.
2. **Factory pattern obligatorio.** Cada archivo exporta `function create<Capa>({ deps })` para que dependencias (prisma, auditReq, services compartidos, limiters) sean inyectadas y los singletons (stores in-memory, throttles) se preserven entre tests y producción.
3. **Schemas en su sitio.** No declarar Zod inline en router/controller/service. Si un schema es transversal a varios módulos, vive en `backend/shared/schemas.js`; si es local, en `backend/modules/<dominio>/schema.js`.
4. **Index opcional.** Si el módulo necesita un `index.js` (orquestador de sub-routers), se usa SOLO para componer y exportar el factory raíz — ningún handler ni schema en `index.js`.
5. **Sub-módulos anidados.** Para dominios grandes (ej. `ventas/`), cada sub-dominio (`facturas/`, `cotizaciones/`, `pos/`) cumple el mismo molde de 5 archivos. El `index.js` del padre compone los hijos.
6. **Naming y tamaño.** Archivos en kebab-case (`pdf-generator.js`). Si `service.js` o `router.js` superan 600 líneas, split por sub-dominio. CERO funciones de >100 líneas dentro del mismo archivo.
7. **Tests adyacentes (opcional pero recomendado).** `__tests__/service.test.js` junto al archivo. service y repo son los únicos candidatos a unit test (puros + mockeables).
8. **REGLA SUPREMA:** Cualquier refactor que toque server.js o backend/modules/* DEBE migrar el código tocado al nuevo molde. Prohibido seguir agregando lógica al monolito legacy. Si un handler vive aún inline en server.js, su próxima edición exige extraerlo a su módulo correspondiente.

## CONTEXTO DE LA EMPRESA
- **Rubro:** Proveedor de Infraestructura de Redes y Seguridad Electrónica.
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

## REGLAS ESTRICTAS DE COMMITS (GIT)
1. **NUNCA AGREGAR `Co-Authored-By: Claude`** ni ninguna otra referencia a IA, Anthropic, asistentes o herramientas generativas en el mensaje de commit (ni en el subject, ni en el body, ni en el trailer). Cero firmas tipo `Co-Authored-By: Claude …`, `Generated with Claude Code`, emojis tipo 🤖, ni atajos similares.
2. **FORMATO ESTÁNDAR DE COMMIT CONVENCIONAL ÚNICAMENTE:** `<tipo>(<scope opcional>): <descripción imperativa breve>` (ej. `feat(pos): …`, `fix(crypto): …`, `chore(deps): …`, `refactor(api): …`, `docs(readme): …`). El cuerpo opcional describe el QUÉ y el POR QUÉ en bullets concisos, sin trailers de coautoría.
3. Aplica a TODOS los commits (locales, squash, merge messages, amends) y a TODOS los PRs creados desde esta carpeta.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical strings: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## REGLA DE SEGURIDAD (CYBER NEO ALWAYS-ON)

Antes de finalizar cualquier tarea o hacer un commit, debes auditar OBLIGATORIAMENTE tu propio código buscando vulnerabilidades OWASP Top 10, inyecciones SQL, fugas de PII, y fallos de control de acceso. Si detectas un riesgo, corrígelo silenciosamente antes de hacer push.

**Checklist mínimo por commit:**
1. **A01 Broken Access Control** — verifica que cada ruta tenga `verificarJWT`/`requerirPermiso`/`requerirNivel` correcto. Endpoints públicos: cero PII en response shape.
2. **A02 Cryptographic Failures** — bcrypt cost ≥ 10, AES-256-GCM con IV random, HMAC timing-safe (`crypto.timingSafeEqual`), tokens random 32+ bytes.
3. **A03 Injection** — Prisma parametrizado SIEMPRE. CERO `$queryRawUnsafe` con string-concat de input usuario. Zod-validar antes de tocar DB.
4. **A04 Insecure Design** — state machines explícitas, idempotencia, rate-limiters por superficie pública, audit-trail inmutable.
5. **A05 Security Misconfiguration** — cookies httpOnly + signed + secure + sameSite + partitioned (prod). CSP nonces dinámicos. CORS whitelist.
6. **A07 Identification/Auth Failures** — login response unificado (anti-enumeration), forgot-password 200 OK siempre, brute-force protection (loginLimiter/totpLimiter/backupCodeLimiter), 2FA TOTP + backup codes + WebAuthn.
7. **A08 Integrity Failures** — hash-chain AuditLog + AuditCaja (HMAC-SHA256 + prevHash), verifyHash en facturas (anti-tamper PDF), WebAuthn counter anti-clone.
8. **A09 Logging Failures** — auditReq en cada operación mutating. CERO password/hash/token en metadata.
9. **PII en logs/responses** — emails OK (ya en URL del request), telefonos parciales, cédula enmascarada en PDFs de cotización, NUNCA passwords/hashes/secrets.
10. **Path Traversal en uploads/downloads** — path = `${bucket}/${kind}/${UUID-DB}-${randomBytes}.${ext}` (cero `req.params` directo). MIME real por magic bytes.

Si encuentras una vulnerabilidad pre-existente fuera del scope del commit actual, NO la introduzcas en el changelog público — corrígela silenciosamente y deja una nota en el cuerpo del commit (`Cyber Neo silent fix: ...`).