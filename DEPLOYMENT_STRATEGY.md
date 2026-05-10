# ACR Networks ERP — Deployment Strategy

## Stack Summary
- **Frontend:** React + Vite (static SPA)
- **Backend:** Node.js + Express (REST API)
- **Database:** PostgreSQL via Supabase (already in production)
- **Auth:** JWT (JWE-equivalent) + HttpOnly signed cookies

---

## Recommended Platform: Split Deployment

### Frontend → Vercel (Free → Pro)
**Why:** Vercel is purpose-built for Vite/React SPAs.
- Zero-config deployment: push to `main` → live in 60 seconds
- Global CDN with edge caching
- Free custom domain + automatic TLS
- Free tier is production-grade for internal tools
- Upgrade path: Pro at $20/month adds analytics, password protection, preview URLs

**Deploy command:**
```bash
# vercel.json at frontend/
{
  "builds": [{ "src": "package.json", "use": "@vercel/static-build", "config": { "distDir": "dist" } }],
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

### Backend → Render (Free → Standard $7/month)
**Why:** Node.js services with persistent env vars, zero DevOps overhead.
- Free tier: spins down after 15 min inactivity (not ideal for production)
- **Standard $7/month:** always-on, 512MB RAM — sufficient for this workload
- Auto-deploy on push, managed TLS, health checks
- Built-in secret management (no `.env` files in git)

**Alternative: Railway ($5 base + usage)**
- Better for teams with multiple services
- Native Postgres addon (can replace Supabase if needed)
- Sleeps less aggressively than Render free tier

**Alternative: Fly.io (usage-based)**
- Best choice if you want containerized deployment with sub-100ms cold starts in the Caribbean region
- Closest region to Dominican Republic: `mia` (Miami) or `ewr` (Newark)

---

## Repository Structure for GitHub

```
erp-acr/                          ← mono-repo root
├── .github/
│   └── workflows/
│       ├── deploy-frontend.yml   ← Vercel auto-deploy on push to main
│       └── deploy-backend.yml    ← Render/Fly deploy hook
├── frontend/                     ← Vite React app
│   ├── src/
│   └── package.json
├── backend/                      ← Express API
│   ├── prisma/
│   ├── shared/
│   └── package.json
├── .gitignore
└── DEPLOYMENT_STRATEGY.md
```

**Branch strategy:**
- `main` → production (protected, requires PR)
- `dev` → staging environment
- `feature/*` → individual features, merge into `dev`

---

## Environment Variables

**Backend (Render/Fly — never committed to git):**
```
DATABASE_URL=postgresql://...supabase.com.../postgres
JWT_SECRET=<256-bit random string>
COOKIE_SECRET=<separate 256-bit random string>
NODE_ENV=production
PORT=3000
```

**Frontend (Vercel — build-time):**
```
VITE_API_URL=https://acr-noc-api.onrender.com
```

Update `frontend/src/utils/api.js` to use `import.meta.env.VITE_API_URL` as the base URL in production.

---

## CORS for Production

Update `server.js` corsOptions:
```js
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://noc.acrnetworks.do', 'https://acr-noc.vercel.app']
    : ['http://localhost:5173'],
  credentials: true,
}
```

---

## Cost Estimate at Launch

| Service | Tier | Monthly |
|---------|------|---------|
| Vercel (frontend) | Hobby (free) | $0 |
| Render (backend) | Standard | $7 |
| Supabase (DB) | Free (500MB) | $0 |
| Custom domain | (annual) | ~$1/mo |
| **Total** | | **~$8/month** |

Scale-up triggers:
- Supabase → Pro ($25/mo) when DB > 500MB or when you need daily backups
- Render → Standard+ ($25/mo) when CPU/RAM become bottlenecks
- Vercel → Pro ($20/mo) when you need team collaboration or password-protected previews

---

## 3 Mega-Automatizaciones Futuras

### 1. Facturación Automática Recurrente (Billing Engine)
**What:** A cron job (daily at 6 AM) that scans all `Servicio` records with `estado: Activo`, generates a `Factura` record for each client due for their monthly payment, sends a WhatsApp notification via Twilio or Meta Cloud API, and updates an `ultimaFactura` timestamp.

**Why it changes everything:** Eliminates the manual billing cycle. 80+ clients × 5 min each = 400+ minutes/month saved. Zero invoices missed. Integrates with NCF generation for DGII compliance.

**Stack:** `node-cron` + Prisma transaction + WhatsApp Business API. Add a `Factura` model to schema with `monto`, `periodo`, `estado: Pendiente|Pagada|Vencida`.

---

### 2. NOC Alerting Pipeline (Real-Time Network Monitoring)
**What:** A WebSocket server (Socket.io) that receives SNMP traps or Zabbix webhooks from your MikroTik/OLT infrastructure. When a client's ONT goes offline (link down event), it automatically:
1. Creates an `OrdenInstalacion` of type `ServicioTecnico`
2. Assigns it to the nearest available technician (by geolocation)
3. Sends a push notification to the tech's mobile (PWA)
4. Updates the client's `Servicio.estado` to `Suspendido`

**Why it changes everything:** Proactive SLA management. Detect outages before clients call. Average ISP response time drops from 2+ hours to under 20 minutes.

**Stack:** Socket.io + Zabbix/PRTG webhook endpoint + Web Push API (already have SW registered).

---

### 3. DGII Fiscal Compliance Automation (NCF + 606/607)
**What:** Auto-generate and submit the monthly `606` (purchases) and `607` (sales) formats required by Dirección General de Impuestos Internos (Dominican Republic). Pulls all `Factura` records for the month, formats them into the DGII XML/TXT spec, and uploads via the DGII API or generates the file for manual upload.

**Why it changes everything:** Eliminates the accountant's monthly 4-6 hour manual export. Zero penalties for late filing. Automatic NCF sequence management (B01, B02, B14, B15, B16). Critical for legal operation as ACR Networks scales beyond 5M DOP/year in revenue.

**Stack:** Prisma aggregation queries + DGII XML schema + `fast-xml-parser` + scheduled cron at day 20 of each month.
