# ACR Networks & Solutions — ERP NOC

> **Versión:** 2026-05 · **Stack:** React 18 + Node.js + PostgreSQL (Supabase) · [Repositorio privado]

---

## Tabla de Contenidos

| # | Sección |
|---|---------|
| 1 | [Arquitectura General](#1-arquitectura-general) |
| 2 | [Autenticación y Sesiones](#2-autenticación-y-sesiones) |
| 3 | [RBAC de Grano Fino](#3-rbac-de-grano-fino) |
| 4 | [Módulos del Sistema](#4-módulos-del-sistema) |
| 5 | [Motor de Facturación NCF](#5-motor-de-facturación-ncf) |
| 6 | [Polimorfismo JSONB en OTs](#6-polimorfismo-jsonb-en-ots) |
| 7 | [Cron Jobs Automáticos](#7-cron-jobs-automáticos) |
| 8 | [PDF Fiscal y Correos](#8-pdf-fiscal-y-correos) |
| 9 | [Seguridad y Hardening](#9-seguridad-y-hardening) |
| 10 | [Frontend y Lazy Loading](#10-frontend-y-lazy-loading) |
| 11 | [Dashboard KPIs en Vivo](#11-dashboard-kpis-en-vivo) |
| 12 | [Infraestructura y Deploy](#12-infraestructura-y-deploy) |
| 13 | [Variables de Entorno](#13-variables-de-entorno) |
| 14 | [MikroTik Sandbox Engine](#14-mikrotik-sandbox-engine) |
| 15 | [PWA — Soporte Móvil](#15-pwa--soporte-móvil) |
| 16 | [Migración desde WispHub / AdminOLT](#16-migración-desde-wisphub--adminolt) |

---

## 1. Arquitectura General

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND  React 18 + Vite + Tailwind CSS                        │
│  Páginas: Dashboard · CRM · Inventario · Ventas (Lazy-loaded)    │
│  Contexto: AuthContext (JWT + permisos en memoria)               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS · HttpOnly Cookie (JWT)
                            │ CSRF Double-Submit Token
┌───────────────────────────▼─────────────────────────────────────┐
│  BACKEND   Node.js 20 + Express 5                                │
│  Middleware stack:                                               │
│    helmet → cors → rate-limit → cookie-parser → CSRF → JWT      │
│  Módulos: auth · crm · inventario · catálogo · OT · facturación │
│           dashboard · admin · cron · PDF · health                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Prisma ORM 6 (connection pool)
┌───────────────────────────▼─────────────────────────────────────┐
│  BASE DE DATOS   PostgreSQL (Supabase)                           │
│  Tablas principales: Empleado · Rol · Cliente · Suplidor         │
│                      Producto · Kardex · Plan · Servicio         │
│                      OrdenTrabajo · ItemCatalogo · Factura       │
│                      ConfiguracionNCF · AuditLog · Prospecto     │
│  Índices especiales: GIN en OrdenTrabajo.metadatos               │
│                      Composite en Factura(clienteId,fechaEmision)│
└─────────────────────────────────────────────────────────────────┘
```

**Stack completo:**
- `express@5` · `@prisma/client@6` · `zod@4` · `jose` + `jsonwebtoken`
- `bcryptjs` · `otplib` (TOTP 2FA) · `node-cron` · `pdfkit` · `qrcode`
- `nodemailer` · `helmet` · `express-rate-limit` · `cookie-parser`

---

## 2. Autenticación y Sesiones

### Flujo de Login

```
POST /api/auth/login
  ├── bcrypt.compare(password, hash)
  ├── Si 2FA activo → devuelve challenge token (AES-256-GCM opaco)
  └── Si no 2FA → genera JWT de sesión → cookie HttpOnly

POST /api/auth/2fa/verify
  ├── Descifra challenge token
  ├── otplib.authenticator.verify(pin, secret)
  └── genera JWT de sesión → cookie HttpOnly

POST /api/auth/logout
  └── Invalida SessionToken en DB + borra cookie
```

### Tokens y Sesiones

| Token | Almacenamiento | TTL | Propósito |
|-------|---------------|-----|-----------|
| JWT de sesión | Cookie `HttpOnly Secure SameSite=Strict` | `JWT_EXPIRES` (env) | Autenticación de API |
| Challenge 2FA | Cookie temporal AES-256-GCM | 5 min | Paso intermedio 2FA |
| SessionToken | Tabla `SessionToken` en DB | Hasta `expiresAt` | Revocación individual |

**Payload JWT:** `{ sub: empleadoId, jti: uuid, permisos: string[] }`

### Anti-Fuerza Bruta

- `loginLimiter`: 5 intentos / 15 min / IP (solo fallos)
- `totpLimiter`: 5 intentos / 15 min / IP
- `billingLimiter`: 5 operaciones / 1 min / usuario autenticado

---

## 3. RBAC de Grano Fino

### Modelo

```
Empleado ←→ Rol (many-to-many vía _EmpleadoToRol)
Rol.permisos:            Json  ["ot:ver", "factura:emitir", ...]
Empleado.permisosExtra:  Json  ["crm:exportar"]            ← permisos directos
```

### Resolución de Permisos Efectivos

```js
permisosEfectivos = union(
  ...empleado.roles.map(r => r.permisos),
  empleado.permisosExtra
)
```

`sistema:owner` → bypass total (no llega a `requerirPermiso`).

### Protección de Columnas Confidenciales

`catalogo:ver_costos` controla si el backend incluye `costo` y `margen` en `GET /api/catalogo`. Sin el permiso, el campo se elimina del JSON **en el servidor** antes de enviarse. La ocultación en el frontend es solo UX.

### Mapa de Permisos

| Módulo | Claves disponibles |
|--------|--------------------|
| Sistema | `sistema:admin` |
| Dashboard | `dashboard:ver` |
| Inventario | `inventario:ver` `editar` `borrar` `exportar` `kardex` |
| Catálogo | `catalogo:ver` `ver_costos` `editar` `editar_precios` |
| Órd. Trabajo | `ot:ver` `crear` `editar` `cerrar` `asignar` |
| Facturación | `factura:ver` `emitir` `editar` `anular` `exportar` |
| CRM | `crm:ver` `crear` `borrar` `exportar` `editar_email` |
| RRHH | `rrhh:ver` `asistencia` `config_seguridad` |
| Reportes | `reportes:ver` `exportar` |
| Mapa NOC | `mapa:ver` |

---

## 4. Módulos del Sistema

### CRM
Clientes, suplidores y prospectos. Campos clave:
- `Cliente.tipoNcf` → determina el comprobante fiscal (`B01` Crédito Fiscal, `B02` Consumidor Final)
- `Cliente.itbis` → boolean, si aplica ITBIS 18% en facturas
- `Cliente.limiteCredito` / `diasCredito` → gestión de crédito

### Inventario
Productos con `sku`, `stockActual`, `categoriaId`. Kardex vía `MovimientoInventario`. Stock crítico (≤5 unidades) aparece en el Dashboard.

### Ventas
Ver [Sección 6](#6-polimorfismo-jsonb-en-ots) para OTs y [Sección 5](#5-motor-de-facturación-ncf) para facturas.

### RRHH
Empleados, asistencia (Entrada/Salida), roles y permisos. Todos los accesos al sistema son empleados con `passwordHash` y opcionalmente `twoFactorSecret`.

---

## 5. Motor de Facturación NCF

### ConfiguracionNCF

```
prefijo:          "B02"
tipoNcf:          "Consumidor Final"
secuenciaActual:  134
limite:           9999999
vencimiento:      2027-01-01
activo:           true
```

### Generación Atómica de NCF

```sql
-- Una sola operación: incrementa Y devuelve en un atomic UPDATE
UPDATE "ConfiguracionNCF"
SET    "secuenciaActual" = "secuenciaActual" + 1
WHERE  "tipoNcf"  = $tipoNcf
  AND  "activo"   = true
  AND  "secuenciaActual" < "limite"
  AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
RETURNING *
```

El **lock implícito de PostgreSQL** al hacer `UPDATE` garantiza que dos transacciones concurrentes no obtengan el mismo número. Si la tx falla después de este punto, el incremento se revierte (gap posible en la secuencia, nunca duplicado).

**Formatos:**
- NCF: `{prefijo}{seq8}` → `B0200000134`
- No. Factura: `FAC{año}{seq8}` → `FAC202600000134`

### Alerta de Agotamiento

Cuando `secuenciaActual / limite ≥ 0.90`, el endpoint `GET /api/dashboard` incluye una entrada en `ncfAlerts`. El Dashboard muestra un banner rojo con el tipo de NCF, porcentaje usado y comprobantes restantes.

---

## 6. Polimorfismo JSONB en OTs

`OrdenTrabajo` usa un campo `tipoOT String` como discriminador y `metadatos Json` como payload polimórfico, evitando tablas separadas por tipo de servicio.

### Tipos y Metadatos

| `tipoOT` | Metadatos típicos |
|----------|------------------|
| `ISP` | `{ ip, macAddress, router, diaCorte }` |
| `CCTV` | `{ cantidadCamaras, tipoGrabacion, ipNVR }` |
| `Reparacion` | `{ equipoTipo, falla, diagnostico }` |
| `CercoElectrico` | `{ voltaje, zonas, marca }` |
| `VentaDirecta` | `{ metodoPago, entrega }` |
| `General` | `{}` |

### Campo `estaFacturada`

```prisma
estaFacturada Boolean @default(false)
```

Marcado a `true` en la misma transacción de `POST /api/facturas`. Más eficiente que `_count.facturas === 0` para filtrar OTs ya facturadas.

### Índice GIN

```sql
-- backend/prisma/gin_index.sql
CREATE INDEX IF NOT EXISTS ot_metadatos_gin ON "OrdenTrabajo" USING GIN (metadatos);
```

Permite queries tipo `WHERE metadatos->>'diaCorte' = '15'` sin full-scan.

---

## 7. Cron Jobs Automáticos

Todos los crons usan `node-cron` con timezone `America/Santo_Domingo`.

### Auto-Facturador WISP (`billarOTsISP`)

| Propiedad | Valor |
|-----------|-------|
| Schedule | `5 0 * * *` (00:05 AM diario) |
| Función | `billarOTsISP()` en `server.js` |

**Lógica:**
1. Obtiene el día del mes actual.
2. Busca `OrdenTrabajo` con `tipoOT='ISP'`, `estado='Activo'` y `metadatos->>'diaCorte' = hoy`.
3. Para cada OT, dentro de una transacción independiente:
   - **Idempotencia**: verifica que no exista `Factura` para esta OT con `fechaEmision >= inicio del día`.
   - Genera NCF atómico.
   - Calcula subtotal + ITBIS + total.
   - Crea Factura en `Emitida` con `fechaVence = hoy + 30 días`.

**Garantías anti-duplicado:**

| Escenario | Protección |
|-----------|-----------|
| Restart después de correr | Check de idempotencia por OT+día |
| Dos instancias simultáneas | Lock de fila en `UPDATE ConfiguracionNCF` |
| Tx falla a mitad | `$transaction` revierte el NCF, gap posible, nunca duplicado |

### Auto-Mora (`billarMoras`)

| Propiedad | Valor |
|-----------|-------|
| Schedule | `10 0 * * *` (00:10 AM diario) |
| Función | `billarMoras()` en `server.js` |

**Lógica:** `updateMany` — todas las facturas con `estado='Emitida'` y `fechaVence < hoy` pasan a `Vencida` en una sola operación atómica.

---

## 8. PDF Fiscal y Correos

### Generación de PDF

**Endpoint:** `GET /api/facturas/:id/pdf` (requiere `factura:ver`)

El PDF es generado por la función `buildFacturaPDFBuffer(factura)` que retorna un `Buffer`. Estructura:

```
┌────────────────────────────────────────────────┐
│ ACR Networks & Solutions          [ NCF BOX ]  │
│ Proveedor WISP · CCTV · Redes     [QR DGII]   │
├────────────────────────────────────────────────┤
│ FACTURA                    [ BOX CLIENTE ]     │
│ No. Factura: FAC202600001                      │
│ Emisión / Vence / Estado                       │
├────────────────────────────────────────────────┤
│ # │ Descripción │ Cant │ P.Unit │ Total        │
│ ─────────────────────────────────────────────  │
│ 1 │ Plan WISP   │  1   │ RD$X  │ RD$X         │
├────────────────────────────────────────────────┤
│                       Subtotal: RD$ X          │
│                     ITBIS 18%: RD$ X           │
│                         TOTAL: RD$ X           │
├────────────────────────────────────────────────┤
│ ACR Networks · Documento electrónico válido    │
└────────────────────────────────────────────────┘
```

El **QR** enlaza a `https://dgii.gov.do/app/verificaNCF?ncf={ncf}` y es generado con `qrcode` (librería ya instalada). Si el NCF es nulo, el QR se omite sin error.

### Envío Automático por Email

Después de emitir una factura (`POST /api/facturas`), el servidor envía el PDF en un **fire-and-forget** via `setImmediate`:

```js
setImmediate(async () => {
  const pdfBuf = await buildFacturaPDFBuffer(factura)
  await sendFacturaPDF(factura, pdfBuf)
})
```

La función `sendFacturaPDF` usa `nodemailer` con SMTP configurable vía env vars. Si `SMTP_USER` no está definido o `cliente.email` está vacío, la función retorna silenciosamente (no bloquea ni falla la respuesta HTTP).

---

## 9. Seguridad y Hardening

| Capa | Implementación | Notas |
|------|---------------|-------|
| Headers HTTP | `helmet()` | CSP, X-Frame-Options, MIME sniffing |
| CORS | Lista blanca + `process.env.CORS_ORIGIN` | Fail-closed en producción |
| Rate limit global | 200 req / 15 min / IP | `express-rate-limit` |
| Rate limit login | 5 req / 15 min / IP (solo fallos) | `skipSuccessfulRequests: true` |
| Rate limit billing | 5 req / 1 min / usuario | Keyed by `req.user.sub` |
| Payload | `express.json({ limit: '50kb' })` | Evita DoS por JSON gigante |
| CSRF | Double-submit cookie `X-CSRF-Token` | Mutations solo |
| Contraseñas | `bcryptjs` (sin plaintext) | Hash en DB |
| 2FA | TOTP RFC 6238 (`otplib`) | Secret AES-256-GCM cifrado |
| JWT | Cookie `HttpOnly Secure SameSite=Strict` | No accesible por JS |
| Audit log | `AuditLog` en DB | Login, emitir factura, cambio estado |
| Sentry | Comentado, listo para activar | `npm install @sentry/node` |

---

## 10. Frontend y Lazy Loading

### Estructura de `src/pages/`

```
pages/
├── Ventas.jsx              ← Shell delgado (2.6 KB vs 73 KB original)
└── panels/
    ├── _shared.jsx         ← Constantes, utils, badges compartidos
    ├── PanelCatalogo.jsx   ← Catálogo de items
    ├── PanelOrdenes.jsx    ← OTs + NuevaOTModal + LineasPicker
    ├── PanelFacturas.jsx   ← Facturas + botones de estado
    └── PanelNCF.jsx        ← Configuración de secuencias NCF
```

### Lazy Loading

```jsx
// Ventas.jsx — cada panel es un chunk de JS separado
const PanelCatalogo = lazy(() => import('./panels/PanelCatalogo'))
const PanelOrdenes  = lazy(() => import('./panels/PanelOrdenes'))
const PanelFacturas = lazy(() => import('./panels/PanelFacturas'))
const PanelNCF      = lazy(() => import('./panels/PanelNCF'))

// El panel solo carga cuando se visita la pestaña por primera vez
<Suspense fallback={<TabFallback />}>
  {tab === 'catalogo' && <PanelCatalogo ... />}
  {tab === 'ordenes'  && <PanelOrdenes  ... />}
  ...
</Suspense>
```

**Beneficio:** La carga inicial del módulo Ventas baja de ~73 KB a ~2.6 KB de JS. Cada pestaña carga su chunk (30-50 KB) solo cuando se visita.

---

## 11. Dashboard KPIs en Vivo

`GET /api/dashboard` — cacheado **60 segundos** en memoria.

### Respuesta

```json
{
  "servicios": { "activos": N, "pendientes": N, "enInstalacion": N, "suspendidos": N, "cancelados": N },
  "ordenesPendientes": N,
  "stockCritico": [{ "id", "nombre", "sku", "stockActual" }],
  "ingresosMensualesEstimados": N,
  "clientes": { "total": N, "activos": N },
  "tecnicos": N,
  "billing": {
    "facturadoMes": N,
    "facturasEmitidasMes": N,
    "cobradoMes": N,
    "vencidasCount": N,
    "vencidasMonto": N,
    "otsPendientes": N,
    "otsEnProceso": N
  },
  "ncfAlerts": [
    { "tipoNcf": "B02", "restantes": 450000, "pct": 96 }
  ]
}
```

`ncfAlerts` es un array vacío `[]` cuando ninguna secuencia supera el 90%. Si tiene elementos, el Dashboard muestra un banner rojo con `BellRing` pulsante.

---

## 12. Infraestructura y Deploy

### Dockerfile (multi-stage)

```dockerfile
# Stage 1 — builder: instala deps y genera cliente Prisma
FROM node:20-alpine AS builder
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
RUN npx prisma generate

# Stage 2 — runner: imagen mínima
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/backend ./
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "server.js"]
```

**Build:**
```bash
docker build -t acr-erp .
docker run -p 3000:3000 --env-file backend/.env acr-erp
```

### CI/CD — GitHub Actions (`.github/workflows/deploy.yml`)

En cada push a `main` o `dev`:
1. **`backend-check`** — `node --check server.js` + `prisma generate`
2. **`frontend-build`** — `npm run build`

El pipeline bloquea merges si el servidor tiene errores de sintaxis o el frontend no compila.

### Health Check

`GET /api/health` (sin autenticación):
```json
{ "ok": true, "db": "up", "uptime": 3847 }
```

Compatible con Docker, load balancers y UptimeRobot.

---

## 13. Variables de Entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `DATABASE_URL` | ✅ | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | ✅ | Secreto para firma JWT y cifrado AES |
| `JWT_EXPIRES` | ✅ | TTL del token (ej. `8h`, `24h`) |
| `COOKIE_SECRET` | ✅ | HMAC signing de cookies |
| `PORT` | — | Puerto del servidor (default: `3000`) |
| `CORS_ORIGIN` | Prod | Dominios permitidos separados por coma |
| `SMTP_HOST` | Email | Host SMTP (ej. `smtp.gmail.com`) |
| `SMTP_PORT` | Email | Puerto SMTP (ej. `587`) |
| `SMTP_SECURE` | Email | `true` para TLS puerto 465 |
| `SMTP_USER` | Email | Correo remitente |
| `SMTP_PASS` | Email | Contraseña / App Password |
| `SENTRY_DSN` | Prod | DSN de Sentry para error tracking |

> **Nunca** subir `.env` al repositorio. Crear `.env.example` como plantilla pública.

---

---

## 14. MikroTik Sandbox Engine

### Flujo de control de morosidad

```
[Cron billarMoras 00:10 AST]          [PATCH /facturas/:id/estado → Pagada]
         │                                          │
         ▼                                          ▼
  prisma.factura.findMany              prisma.factura.update
  (Emitida + fechaVence < hoy)         (estado: 'Pagada')
         │                                          │
         ▼                                          ▼
  prisma.factura.updateMany            OT.tipoOT === 'ISP' ?
  (→ Vencida)                          OT.metadatos.ip exists ?
         │                                          │
         ▼                                          ▼
  setImmediate ──────────────────► syncMikrotik(ip, 'activo')
  for each ISP OT IP                          │
         │                           MIKROTIK_DRY_RUN=true ?
         ▼                                    │
  syncMikrotik(ip, 'moroso')         YES ─────┼─────► console.log [SANDBOX]
         │                           NO       │
  MIKROTIK_DRY_RUN=true ?                     ▼
         │                           RouterOSAPI.connect()
  YES ──►│──► console.log [SANDBOX]  /ip/firewall/address-list/remove
  NO     │                           (quita de lista morosos)
         ▼
  RouterOSAPI.connect()
  /ip/firewall/address-list/add
  list=morosos, address=ip
```

### Variables de entorno MikroTik

| Variable | Default | Descripción |
|---|---|---|
| `MIKROTIK_DRY_RUN` | `true` | `false` para activar modo real |
| `MIKROTIK_HOST` | `192.168.88.1` | IP del router MikroTik |
| `MIKROTIK_PORT` | `8728` | Puerto API RouterOS |
| `MIKROTIK_USER` | `admin` | Usuario API |
| `MIKROTIK_PASS` | — | Contraseña API |
| `MIKROTIK_LISTA_MOROSOS` | `morosos` | Nombre de la Address List de bloqueo |

### Regla de firewall (agregar una vez en el router)

```routeros
/ip firewall filter add \
  chain=forward \
  src-address-list=morosos \
  action=drop \
  comment="ERP-mora-auto" \
  place-before=0
```

---

## 15. PWA — Soporte Móvil

El frontend está configurado como Progressive Web App usando `vite-plugin-pwa`.

### Capacidades habilitadas

| Característica | Detalle |
|---|---|
| **Instalable** | "Añadir a pantalla de inicio" en Android/iOS |
| **Sin barra de URL** | `display: standalone` — se ve como app nativa |
| **Offline parcial** | Service Worker cachea assets + última respuesta del dashboard |
| **Actualización automática** | `registerType: autoUpdate` — nueva versión en background |

### Estrategias de cache

```
GET /api/dashboard   → NetworkFirst   (5s timeout → cache de 60s)
GET /api/catalogo    → StaleWhileRevalidate (cache 5 min, actualiza en background)
GET /api/clientes    → StaleWhileRevalidate
Assets JS/CSS/HTML   → CacheFirst (Workbox precache, versionado por hash)
```

### Iconos requeridos (crear antes del deploy)

```
frontend/public/
├── pwa-192x192.png     ← Logo ACR 192×192px
├── pwa-512x512.png     ← Logo ACR 512×512px (maskable)
└── apple-touch-icon.png ← 180×180px para iOS
```

> Generar con: [realfavicongenerator.net](https://realfavicongenerator.net) o `sharp` CLI.

---

## 16. Migración desde WispHub / AdminOLT

### Estrategia de transición suave (Parallel Run)

```
FASE 1 — PARALELO (actual)
─────────────────────────────────────────────────────────
  WispHub                    ACR ERP (este sistema)
  ─────────                  ──────────────────────
  Gestiona clientes          Registra clientes manualmente
  Cobra facturas             Emite facturas NCF propias
  Controla MikroTik          MIKROTIK_DRY_RUN=true
                             Logs en consola (audit trail)
  ─────────────────────────────────────────────────────
  ✅ Sin riesgo de servicio  ✅ Datos reales en ERP
  ✅ WispHub como fallback   ✅ Equipo aprende el sistema

FASE 2 — VALIDACIÓN (1-3 meses)
─────────────────────────────────────────────────────────
  1. Comparar datos ERP vs WispHub (clientes, facturas)
  2. Verificar logs SANDBOX vs acciones reales WispHub
  3. Activar MIKROTIK_DRY_RUN=false en horario de bajo tráfico
  4. Monitorear 48h con WispHub como fallback manual

FASE 3 — CORTE (cuando ERP sea la fuente de verdad)
─────────────────────────────────────────────────────────
  1. Exportar historial de pagos de WispHub → importar a Factura
  2. Activar cron billarOTsISP y billarMoras como único motor
  3. Desactivar módulos de WispHub uno a uno
  4. WispHub en modo lectura por 30 días adicionales
```

### Flujo completo de un cliente ISP en el ERP

```
[CRM: crear Cliente]
       │
       ▼
[Ventas: crear OT tipo ISP]
  metadatos: { ip, macAddress, router, diaCorte }
       │
       ▼
[Cron billarOTsISP — día 1 del mes 00:05 AST]
  → genera Factura con NCF automático
  → envía PDF por email (nodemailer)
       │
       ├── Pagada antes de fechaVence
       │         │
       │         ▼
       │   PATCH /facturas/:id/estado → Pagada
       │   syncMikrotik(ip, 'activo') [SANDBOX/LIVE]
       │
       └── No pagada → fechaVence < hoy
                 │
                 ▼
         Cron billarMoras — 00:10 AST
         Factura → Vencida
         syncMikrotik(ip, 'moroso') [SANDBOX/LIVE]
```

---

*Documentación mantenida junto al código. Actualizar en cada cambio de arquitectura.*
