# ACR Networks & Solutions — ERP NOC: Documentación Técnica

> Versión 2026-05. Documento vivo — actualizar junto con cada cambio de arquitectura.

---

## Índice

1. [Arquitectura General](#arquitectura-general)
2. [Módulo de Autenticación (Auth)](#módulo-de-autenticación-auth)
3. [RBAC de Grano Fino](#rbac-de-grano-fino)
4. [Módulo CRM](#módulo-crm)
5. [Módulo Inventario](#módulo-inventario)
6. [Módulo Ventas — Catálogo, Órdenes de Trabajo, Facturación](#módulo-ventas)
7. [Polimorfismo JSONB en Órdenes de Trabajo](#polimorfismo-jsonb-en-órdenes-de-trabajo)
8. [Motor de Facturación y NCF](#motor-de-facturación-y-ncf)
9. [Cron Job — Auto-Facturador WISP](#cron-job--auto-facturador-wisp)
10. [Seguridad y Hardening](#seguridad-y-hardening)
11. [Dashboard KPIs](#dashboard-kpis)
12. [Variables de Entorno](#variables-de-entorno)

---

## Arquitectura General

```
┌─────────────────────────────────────────────────┐
│  Frontend  React 18 + Vite + Tailwind CSS        │
│  (src/pages: Dashboard, CRM, Inventario, Ventas) │
└────────────────────┬────────────────────────────┘
                     │ HTTPS + HttpOnly Cookie (JWT)
┌────────────────────▼────────────────────────────┐
│  Backend   Node.js + Express 5                   │
│  Middlewares: helmet, cors, express-rate-limit,  │
│               cookie-parser, CSRF double-submit  │
└────────────────────┬────────────────────────────┘
                     │ Prisma ORM
┌────────────────────▼────────────────────────────┐
│  Base de Datos  PostgreSQL (Supabase)            │
│  Tablas clave: Empleado, Rol, Cliente, Producto, │
│  OrdenTrabajo, Factura, ConfiguracionNCF, AuditLog│
└─────────────────────────────────────────────────┘
```

**Stack:**
- `express` 5 · `@prisma/client` 6 · `zod` 4 · `jose` / `jsonwebtoken`
- `bcryptjs` · `otplib` (TOTP) · `node-cron` · `pdfkit` · `qrcode`

---

## Módulo de Autenticación (Auth)

### Flujo de login

1. `POST /api/auth/login` — valida email + contraseña (bcrypt). Devuelve un **challenge token** opaco (AES-256-GCM) si 2FA está activo, o genera el JWT de sesión directamente.
2. `POST /api/auth/2fa/verify` — verifica el PIN TOTP (6 dígitos, ventana ±30s). Genera JWT de sesión.
3. El JWT se escribe en una **cookie HttpOnly + Secure + SameSite=Strict**. No es accesible por JavaScript del frontend.
4. `POST /api/auth/logout` — invalida la `SessionToken` en DB y borra la cookie.

### Tokens

- **JWT de sesión**: payload `{ sub: empleadoId, jti: uuid, permisos: string[] }`. TTL configurable (`.env JWT_EXPIRES`).
- **SessionToken (DB)**: cada JWT tiene un registro en la tabla `SessionToken` con `jti`, `ip`, `userAgent`, `expiresAt`. Permite revocación individual o masiva.
- **Challenge token**: AES-256-GCM wrapping del JWT parcial. Válido solo para el paso 2FA.

### Anti-fuerza bruta

- `loginLimiter`: 5 intentos / 15 min por IP.
- `totpLimiter`: 5 intentos / 15 min por IP.

---

## RBAC de Grano Fino

### Modelo de datos

```
Empleado ←→ Rol (many-to-many)
Rol.permisos: Json (array de strings)
Empleado.permisosExtra: Json (array de strings)
```

### Resolución de permisos efectivos

```
permisosEfectivos = union(
  ...roles.map(r => r.permisos),
  empleado.permisosExtra
)
```

El permiso `sistema:owner` (bypass total) solo puede ser asignado a un empleado si ya existe en sus roles actuales — el backend rechaza escalar a owner si el asignador no tiene owner.

### Middleware `requerirPermiso(key)`

```js
// server.js
function requerirPermiso(key) {
  return (req, res, next) => {
    const p = req.user?.permisos ?? []
    if (p.includes('sistema:owner') || p.includes(key)) return next()
    res.status(403).json({ error: 'Sin permiso.' })
  }
}
```

### Mapa de permisos (`backend/shared/permissions.map.js`)

| Módulo | Clave | Descripción |
|--------|-------|-------------|
| Sistema | `sistema:admin` | Config, usuarios, roles |
| Dashboard | `dashboard:ver` | KPIs y métricas |
| Inventario | `inventario:ver/editar/borrar/exportar/kardex` | CRUD inventario |
| Catálogo | `catalogo:ver/ver_costos/editar/editar_precios` | Items de venta |
| Órd. Trabajo | `ot:ver/crear/editar/cerrar/asignar` | Ciclo de vida de OTs |
| Facturación | `factura:ver/emitir/editar/anular/exportar` | Motor NCF |
| CRM | `crm:ver/crear/borrar/exportar/editar_email` | Clientes y suplidores |
| RRHH | `rrhh:ver/asistencia/config_seguridad` | Personal |
| Reportes | `reportes:ver/exportar` | Inteligencia de negocio |
| Mapa NOC | `mapa:ver` | Infraestructura de red |

### Protección de columnas confidenciales

`catalogo:ver_costos` controla si el backend incluye el campo `costo` en la respuesta de `GET /api/catalogo`. Sin este permiso, el campo es eliminado del JSON antes de enviarse — la ocultación en frontend es UX únicamente.

---

## Módulo CRM

`GET/POST/PUT/DELETE /api/clientes` y `/api/suplidores`.

- **Clientes**: empresas o personas con servicios contratados. Tienen `tipoNcf` (determina el comprobante fiscal a emitir), `itbis` (boolean, si aplica ITBIS 18%), `limiteCredito`, `diasCredito`.
- **Suplidores**: proveedores de equipos y materiales.
- **Prospectos**: leads de potenciales clientes WISP. Estado: `Nuevo → Contactado → Calificado → Convertido`.

Acceso desde Ventas via query param: `/ventas?cliente=<uuid>&nombre=<nombre>` — pre-puebla el buscador de ClienteSearch y abre el modal de Nueva OT directamente.

---

## Módulo Inventario

Productos con `sku`, `stockActual`, `categoriaId`, `precio`.

- **Kardex**: tabla `MovimientoInventario` registra cada entrada/salida con referencia a `OrdenInstalacion`.
- **Stock Crítico**: productos con `stockActual ≤ 5` aparecen en el widget del Dashboard.
- **PlantillaEquipo**: define qué productos (y cantidades) se consumen al activar un Plan de servicio.

---

## Módulo Ventas

El módulo Ventas (`frontend/src/pages/Ventas.jsx`) agrupa tres sub-paneles en tabs:

1. **Catálogo** — Items facturables (`ItemCatalogo`): servicios, productos, mano de obra.
2. **Órdenes de Trabajo** — Ciclo completo de OTs.
3. **Facturación** — Facturas emitidas con filtros y acciones de estado.

### Flujo típico

```
CRM (cliente) → Nueva OT (modal) → Facturar → PDF
```

---

## Polimorfismo JSONB en Órdenes de Trabajo

`OrdenTrabajo` tiene un campo `tipoOT String` como discriminador y `metadatos Json` como payload polimórfico. Esto evita tener tablas separadas por tipo de servicio.

### Discriminadores y metadatos

| `tipoOT` | Metadatos típicos |
|----------|------------------|
| `ISP` | `{ ip, macAddress, router, diaCorte }` |
| `CCTV` | `{ cantidadCamaras, tipoGrabacion, ipNVR }` |
| `Reparacion` | `{ equipoTipo, falla, diagnostico }` |
| `CercoElectrico` | `{ voltaje, zonas, marca }` |
| `VentaDirecta` | `{ metodoPago, entrega }` |
| `General` | `{}` |

### Índice GIN (JSONB)

```sql
-- backend/prisma/gin_index.sql
CREATE INDEX IF NOT EXISTS ot_metadatos_gin ON "OrdenTrabajo" USING GIN (metadatos);
```

Aplicado via `npx prisma db execute`. Permite queries eficientes sobre campos JSONB sin full-scan.

### Ejemplo de query por campo JSONB

```sql
SELECT * FROM "OrdenTrabajo"
WHERE "tipoOT" = 'ISP'
  AND (metadatos->>'diaCorte')::int = 15
```

---

## Motor de Facturación y NCF

### Tabla `ConfiguracionNCF`

Configurada por tipo de NCF (ej. `B01` Crédito Fiscal, `B02` Consumidor Final):
- `prefijo`: ej. `B02`
- `secuenciaActual`: contador atómico
- `limite`: máximo permitido por la DGII
- `vencimiento`: fecha de expiración del rango

### Generación atómica de NCF

El endpoint `POST /api/facturas` usa un `UPDATE...RETURNING` dentro de una `prisma.$transaction`:

```sql
UPDATE "ConfiguracionNCF"
SET    "secuenciaActual" = "secuenciaActual" + 1
WHERE  "tipoNcf"  = $tipoNcf
  AND  "activo"   = true
  AND  "secuenciaActual" < "limite"
  AND  ("vencimiento" IS NULL OR "vencimiento" > NOW())
RETURNING *
```

El lock implícito de PostgreSQL al hacer `UPDATE` garantiza que dos transacciones concurrentes no obtengan el mismo número. Si la tx falla después de este punto, el `secuenciaActual` incrementado se revierte (posible gap, nunca duplicado).

**Formato NCF**: `{prefijo}{seq8}` → ej. `B0200000001`  
**Formato noFactura**: `FAC{año}{seq8}` → ej. `FAC202600000001`

---

## Cron Job — Auto-Facturador WISP

**Archivo**: `backend/server.js` → función `billarOTsISP`  
**Horario**: `5 0 * * *` — todos los días a las **00:05 AM** (timezone: `America/Santo_Domingo`)

### Lógica

1. Obtiene el día del mes actual (`hoy.getDate()`).
2. Busca todas las `OrdenTrabajo` con `tipoOT = 'ISP'`, `estado = 'Activo'` y `metadatos->>'diaCorte' = diaHoy`.
3. Para cada OT, en una transacción independiente:
   - **Idempotencia**: verifica que no exista ya una `Factura` con `ordenId = ot.id` y `fechaEmision >= inicio del día`. Si existe, salta la OT sin error.
   - Genera NCF con el `UPDATE...RETURNING` atómico.
   - Calcula `subtotal`, `itbis` y `total` desde las líneas de la OT.
   - Crea la `Factura` en estado `Emitida` con `fechaVence = hoy + 30 días`.

### Garantías anti-duplicado

| Escenario | Protección |
|-----------|-----------|
| Servidor se reinicia después de que corrió | La idempotencia check encuentra la factura ya creada |
| Dos instancias del servidor activas | El `UPDATE...RETURNING` tiene lock de fila en PostgreSQL |
| Tx falla a mitad | `prisma.$transaction` revierte el NCF increment — gap posible, nunca duplicado |
| La OT no tiene líneas | La función retorna sin crear factura |

---

## Seguridad y Hardening

| Capa | Implementación |
|------|---------------|
| Headers HTTP | `helmet()` — CSP, X-Frame-Options, X-Content-Type-Options |
| CORS | Lista blanca estricta (`localhost:5173` en dev) |
| Rate limiting global | 200 req / 15 min por IP |
| Rate limiting login | 5 req / 15 min, solo fallos |
| Rate limiting billing | 5 req / 1 min por usuario autenticado |
| Payload | `express.json({ limit: '50kb' })` |
| CSRF | Double-submit cookie (`X-CSRF-Token`) en mutaciones |
| Contraseñas | `bcryptjs`, sin almacenar plaintext |
| 2FA | TOTP (RFC 6238) con `otplib`, secret AES-encriptado |
| JWT | HttpOnly + Secure + SameSite=Strict cookie |
| Audit log | `AuditLog` en DB para eventos críticos |

---

## Dashboard KPIs

`GET /api/dashboard` — cacheado 60 segundos.

**Respuesta:**
```json
{
  "servicios": { "activos": N, "pendientes": N, "enInstalacion": N, ... },
  "ordenesPendientes": N,
  "stockCritico": [...],
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
  }
}
```

---

## Variables de Entorno

| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | URL de conexión PostgreSQL (Supabase) |
| `JWT_SECRET` | Secreto para firma de JWT y AES de challenge tokens |
| `JWT_EXPIRES` | TTL del JWT (ej. `8h`) |
| `COOKIE_SECRET` | Secreto para `cookie-parser` HMAC signing |
| `PORT` | Puerto del servidor (default: `3000`) |

> Nunca subir `.env` al repositorio. Usar `.env.example` como plantilla.
