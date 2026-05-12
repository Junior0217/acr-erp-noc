# Deployment en Render

## Build Command (importante tras añadir Puppeteer)

```
npm install && npx puppeteer browsers install chrome
```

Por default Puppeteer descarga su Chromium en `postinstall`, pero en Render el cache puede no persistir entre deploys. Forzar `puppeteer browsers install chrome` garantiza el binario presente.

## Start Command

```
node server.js
```

## Variables de entorno requeridas

Mínimas:
- `DATABASE_URL`              (Supabase pooler)
- `DIRECT_URL`                (Supabase direct connection)
- `JWT_SECRET`                (mín 32 chars)
- `COOKIE_SECRET`             (mín 32 chars)
- `VAULT_KEY`                 (base64 32 bytes — `openssl rand -base64 32`)
- `CORS_ORIGIN`               (URL Vercel del frontend)
- `NODE_ENV=production`

Storage (assets de empresa):
- `SUPABASE_URL`              (https://<ref>.supabase.co)
- `SUPABASE_SERVICE_ROLE_KEY` (de Supabase Dashboard → Settings → API)
- `SUPABASE_BUCKET=empresa-assets`

PDFs server-side (Puppeteer): sin variables extras. Solo requiere el build command de arriba.

Opcional (alertas):
- `WHATSAPP_TOKEN`            (Meta Graph)
- `WHATSAPP_PHONE_ID`
- `WHATSAPP_TO`
- `AZUL_WEBHOOK_SECRET`       (HMAC del webhook de pagos)

## Recursos mínimos (Plan)

- **Starter ($7/mes)** recomendado. Razón: Puppeteer + Chromium consume ~250MB RAM al renderizar PDF. Free Tier (512MB) puede funcionar pero queda ajustado y duerme tras 15 min de inactividad → primer PDF tras dormir tarda ~45s (cold start + Chromium boot).
- **Standard ($25/mes)** si volumen > 50 PDFs/día.

## Verificación post-deploy

```
curl https://<tu-backend>.onrender.com/api/health
# debe responder { status: 'ok', dbConnected: true, version: '...' }
```

Generar un PDF de prueba (cotización existente):
```
curl -b "token=<wrapped>; csrf=<csrf>" \
     -H "X-CSRF-Token: <csrf>" \
     https://<tu-backend>.onrender.com/api/ventas/cotizaciones/<id>/pdf \
     -o cotizacion.pdf
# Tamaño típico: ~150-200KB. Header debe ser %PDF
```
