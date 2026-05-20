# `frontend/src/shared/hooks/`

Hooks transversales reutilizables. Vivos aquí cuando dos o más features los consumen; si solo lo usa una feature, vive dentro de esa feature.

| Archivo | Rol | Cuándo usarlo |
|---|---|---|
| `useDebounce.js` | Estabiliza un valor que cambia rápido (typing, redimensionado). | Inputs con búsqueda en vivo, sliders, viewport resize. |
| `useOfflineStatus.js` | Booleano + listener a `navigator.onLine` + `online`/`offline` events. | UX offline, badges, banners de reconexión. |
| `usePreferenciasPOS.js` | Preferencias visuales del cajero (qué condiciones mostrar). **Multi-tab safe.** | Cualquier panel del POS que renderice condiciones o quiera reaccionar a cambios del cajero. |

---

## Patrón `usePreferenciasPOS` — sincronización multi-tab sin churn

El cajero abre múltiples tabs (POS + Catálogo + Cotizaciones). Cuando alterna un toggle en una tab, las otras deben verlo SIN cada una hacer su propio GET al backend. Cuatro mecanismos cooperan:

```
┌─────────────────────────────────────────────────────────────────────┐
│ TAB A: cajero alterna toggle "Mostrar Validez"                      │
│   ↓                                                                  │
│   actualizar({ mostrarValidez: false })                              │
│     │                                                                │
│     ├─→ Module cache (_cache) ← fuente única en runtime              │
│     ├─→ localStorage ('acr.preferenciasPOS.v1') ← warm-start         │
│     ├─→ BroadcastChannel.postMessage(next) ← otras tabs              │
│     └─→ debounce 600 ms → PUT /api/preferencias-pos ← backend       │
│                                                                      │
│ TAB B: recibe BroadcastChannel.onmessage(next)                       │
│   _setCache(next, { broadcast: false }) ← evita eco infinito         │
│     └─→ todos los _subscribers reciben setState(next)                │
└─────────────────────────────────────────────────────────────────────┘
```

### Decisiones clave

1. **Module-level singleton (`_cache`).** Una sola fuente de verdad por proceso. Cada `usePreferenciasPOS()` se suscribe vía `_subscribers.add(setState)`. Sin esto, N instancias = N states divergentes.

2. **Warm-start desde localStorage.** El estado inicial intenta `_cache → localStorage → DEFAULTS`. La UI nunca parpadea esperando el GET inicial; si la red está caída, el último valor persistido sigue siendo correcto.

3. **BroadcastChannel para tabs hermanas.** Solo navegador moderno (sin IE/Safari muy viejo). `_broadcast = false` es el sentinel "no disponible" para fallback silencioso. Si BroadcastChannel falla por sandbox/private-mode, el hook degrada a "tabs ven cambios solo tras refresh" — la app no rompe.

4. **Debounce 600 ms para PUT.** El cajero puede alternar 4 toggles seguidos; queremos UN solo PUT al final. El debounce vive a nivel de módulo (`_debounceTimer`, `_pendingPatch`), no por instancia — así dos tabs que escriben en paralelo no duplican PUT.

5. **`updateAgeOnGet: false` semántico.** Reload tras 30 min no rompe nada: `reload()` invalida `_initialFetch` y re-dispara `_bootstrapFetch()`.

### Telemetría asociada

Si BroadcastChannel o localStorage fallan, el hook **degrada en silencio**. Para que esos fallos sean visibles operacionalmente sin romper UX, integrar con el endpoint público:

```js
fetch('/api/telemetry', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify({ type: 'broadcast_channel_unavailable', href: location.href }),
})
```

Tipos válidos (validación server-side):
- `broadcast_channel_unavailable` — `BroadcastChannel` no existe (Safari < 15.4 / IE).
- `broadcast_channel_error` — postMessage throw (probable: sandboxed iframe).
- `localstorage_unavailable` — `localStorage` no se puede leer/escribir.
- `localstorage_quota` — DOMException QuotaExceededError.
- `preferencias_pos_load_fail` — GET inicial falló.
- `preferencias_pos_persist_fail` — PUT falló (cajero perdió internet).

El endpoint es público, rate-limited (60/min/IP), no persiste a BD; loguea en stderr para que Render/Datadog lo capture. Ver `backend/server.js:/api/telemetry`.

### Cómo extender este patrón a otro hook

Si necesitas un hook multi-tab safe (ej. `useCajaActiva`, `useEmpresaActiva`):

1. Copia la estructura de `_cache + _subscribers + _bootstrapFetch + _setCache`.
2. Define un `LS_KEY` y `BC_NAME` únicos.
3. Si el valor es sensible (claves, tokens), **NO** lo cachees en localStorage. Solo en módulo + BroadcastChannel.
4. Documenta los `type:` de telemetría que añadas — server.js debe whitelistarlos en `TELEMETRY_TYPES`.

### Tests

No hay test runner en el frontend (Vite + React). Si en el futuro se adopta Vitest, los tests de `usePreferenciasPOS` deberían cubrir:
- Warm-start desde LS sin GET (mock `fetch` no llamado).
- BroadcastChannel mensaje → todas las instancias actualizadas.
- Debounce: 5 cambios seguidos → 1 PUT.
- Failure paths: BroadcastChannel undefined, localStorage throws.
