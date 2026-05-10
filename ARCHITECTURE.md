# ACR Networks ERP — Architecture Strategy

## Current State
Monolithic `backend/server.js` (~1700 LOC). All routes, middleware, schemas, and helpers in one file.
Works well for the current scale. Migration to Hybrid Feature Architecture happens when:
- File exceeds ~2000 LOC, OR
- A new module (Services, Billing) requires its own domain logic, OR
- A second developer joins and merge conflicts become frequent.

---

## Target: Hybrid Feature + Type Architecture

```
backend/
├── prisma/
│   └── schema.prisma
├── shared/
│   ├── permissions.map.js       # canonical permission keys
│   ├── crypto.js                # wrapJWT / unwrapJWT / encryptTOTP / decryptTOTP
│   ├── audit.js                 # auditReq helper
│   ├── schemas.js               # shared Zod schemas (passwordSchema, etc.)
│   └── middleware/
│       ├── verificarJWT.js      # auth middleware
│       ├── requerirPermiso.js   # RBAC guard factory
│       ├── protegerPropietario.js
│       └── csrf.js              # CSRF double-submit middleware
├── core/
│   ├── server.js                # express init, cors, helmet, cookie-parser, rate limiters
│   └── prisma.js                # PrismaClient singleton
└── features/
    ├── auth/
    │   ├── auth.routes.js       # GET /challenge, POST /login, GET /me, POST /logout
    │   ├── auth.service.js      # completarLogin, challenge logic
    │   └── totp/
    │       ├── totp.routes.js   # GET /2fa/setup, POST /2fa/enable, /disable, /verify
    │       └── totp.service.js  # encrypt/decrypt TOTP, twoFAStore Map
    ├── rrhh/
    │   ├── rrhh.routes.js       # POST/GET/PUT/DELETE /api/empleados
    │   └── rrhh.service.js      # bcrypt, Prisma calls
    ├── admin/
    │   ├── admin.routes.js      # /api/admin/empleados/:id/* + /api/roles
    │   └── admin.service.js     # role assignment, privilege escalation guard
    ├── crm/
    │   ├── crm.routes.js        # /api/clientes, /api/suplidores, /api/prospectos
    │   └── crm.service.js
    ├── inventario/
    │   ├── inventario.routes.js # /api/categorias, /api/productos, /api/movimientos
    │   └── inventario.service.js
    ├── servicios/
    │   ├── servicios.routes.js  # /api/planes, /api/servicios, /api/ordenes
    │   └── servicios.service.js
    ├── noc/
    │   ├── noc.routes.js        # /api/mapa-noc, /api/dashboard
    │   └── noc.service.js       # dashboard aggregation, cache logic
    └── asistencia/
        ├── asistencia.routes.js
        └── asistencia.service.js
```

---

## Entry Point (core/server.js)

```js
const app = express()
// global middleware (helmet, cors, cookie-parser, rate-limiter, csrf)

app.use('/api/auth',       require('../features/auth/auth.routes'))
app.use('/api/auth/2fa',   require('../features/auth/totp/totp.routes'))
app.use('/api/empleados',  require('../features/rrhh/rrhh.routes'))
app.use('/api/admin',      require('../features/admin/admin.routes'))
app.use('/api',            require('../features/crm/crm.routes'))
app.use('/api',            require('../features/inventario/inventario.routes'))
app.use('/api',            require('../features/servicios/servicios.routes'))
app.use('/api',            require('../features/noc/noc.routes'))
app.use('/api',            require('../features/asistencia/asistencia.routes'))

// global error handler
```

---

## Migration Strategy

**Phase 1 — Extract shared utilities** (no behavior change)
Move `wrapJWT`, `encryptTOTP`, `auditReq`, `verificarJWT`, etc. to `shared/`.
Server still one file, just importing from shared.

**Phase 2 — Extract by feature, one at a time**
Start with `auth` (most self-contained). Wire router into server. Run tests. Repeat per feature.

**Phase 3 — Replace server.js entry**
Once all features extracted, `server.js` becomes only `core/server.js` + feature mounts.

---

## Rules

- **Services own DB access.** Routes only parse HTTP and call services.
- **Middleware lives in `shared/`**, never duplicated per feature.
- **Prisma singleton** imported from `core/prisma.js` — never instantiated twice.
- **No circular imports.** Features import from `shared/` and `core/`, never from each other.
- **Zod schemas** defined in the feature's routes file (or `shared/schemas.js` for cross-cutting).
