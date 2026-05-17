import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Vendor splitting — chunks separados con hash inmutable. Cambios en un panel
// no invalidan el cache de leaflet / dnd / pdf. Headers `immutable` en Vercel
// hacen que el browser sólo baje el delta del panel modificado.
//
// Reglas de orden estrictas: react-router ANTES que react-dom (porque
// react-router incluye 'react'-internals que matchearían el segundo regex).
function vendorChunk(id) {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('react-router'))                              return 'vendor-react-router'
  if (id.includes('react-dom') || /node_modules[\\/](react|scheduler)[\\/]/.test(id)) return 'vendor-react'
  if (id.includes('@dnd-kit'))                                   return 'vendor-dnd'
  if (id.includes('leaflet.markercluster'))                      return 'vendor-leaflet-cluster'
  if (id.includes('leaflet') || id.includes('react-leaflet'))    return 'vendor-leaflet'
  if (id.includes('lucide-react'))                               return 'vendor-icons'
  if (id.includes('sonner'))                                     return 'vendor-toast'
  if (id.includes('marked'))                                     return 'vendor-markdown'
  if (id.includes('react-to-print'))                             return 'vendor-print'
  return 'vendor'
}

export default defineConfig({
  resolve: {
    alias: {
      '@':         path.resolve(__dirname, 'src'),
      '@features': path.resolve(__dirname, 'src/features'),
      '@shared':   path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    // Sube el chunk-size-warning a 600kB para reportes más realistas — los
    // vendor splits ya garantizan que ningún panel arrastra 1MB consigo.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: SW se actualiza solo cuando hay versión nueva (combinado con
      // skipWaiting + clientsClaim abajo). PWAUpdatePrompt sigue mostrando toast
      // pero el botón "Actualizar ahora" sólo confirma — la actualización ya
      // estaba descargándose en background.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // includeAssets se sirven en runtime (no en precache). Sólo listamos
      // archivos que existen en /public para evitar 404 fantasmas del SW.
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icons.svg'],
      manifest: {
        name: 'ACR Networks NOC',
        short_name: 'ACR NOC',
        description: 'Panel de Control NOC — ACR Networks & Solutions v2.1',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // Bump del cacheId cuando cambia estrategia de precache.
        // v6: dieta agresiva — sólo shell crítico en precache (<1MB),
        // todo lo demás cae a runtimeCaching on-demand.
        cacheId: 'acr-noc-v6-sub1mb-precache',
        // PRECACHE MÍNIMO (< 1MB): sólo HTML shell, CSS principal, JS de
        // entry + vendor-react + contexts críticos. Íconos PWA / logos /
        // chunks de panel se sirven via runtimeCaching (StaleWhileRevalidate).
        //
        // OBJETIVO: primer load = sólo lo indispensable para renderizar Login
        // y el shell. El resto se hidrata bajo demanda y queda cacheado en
        // visitas subsecuentes.
        globPatterns: [
          'index.html',
          'manifest.webmanifest',
          'assets/index-*.css',
          'assets/index-*.js',
          'assets/vendor-react-*.js',
          'assets/vendor-react-router-*.js',
          'assets/AuthContext-*.js',
          'assets/api-*.js',
          'assets/EmpresaContext-*.js',
          'assets/rolldown-runtime-*.js',
          'favicon.svg',
        ],
        skipWaiting: true,
        clientsClaim: true,
        navigateFallbackDenylist: [/^\/api\//, /^\/verify\//, /^\/portal\//, /^\/track\//],
        // Runtime caching: lo que NO está en precache se hidrata aquí. La
        // primera visita pega red para cada chunk lazy; visitas posteriores
        // sirven SWR (instantáneo + revalidación en background).
        runtimeCaching: [
          {
            // Dashboard: network-first (fresh data preferred, cache as fallback)
            urlPattern: /\/api\/dashboard/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-dashboard',
              expiration: { maxEntries: 1, maxAgeSeconds: 60 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            // Catalog / CRM lists: stale-while-revalidate (fast + eventual fresh)
            urlPattern: /\/api\/(catalogo|clientes|productos)/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'api-lists',
              expiration: { maxEntries: 20, maxAgeSeconds: 300 },
            },
          },
          {
            // Lazy chunks de panels y vendors pesados: StaleWhileRevalidate
            // sirve la caché instantáneo y refresca en background. La primera
            // visita pega red (~150-200kB c/u), la segunda es instantánea.
            urlPattern: /\/assets\/(vendor-(?!react)|Ventas|Inventario|CRM|Configuracion|Servicios|Reportes|Taller|Tienda|MiEmpresa|MapaNOC|Dashboard|CustomerPortal|PortalTracking|TrackTicket|CotizacionDGII|RRHH|VerifyDocument|EditorDescripcion|_shared|Compras|Contabilidad|panels|Panel|Formulario)-.*\.(js|css)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'lazy-chunks',
              expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Logos / imágenes de empresa / íconos PWA grandes: SWR con
            // expiración larga. Evita meter 350KB+ de PNGs en el precache.
            urlPattern: /\/(logo-acr|pwa-192x192|pwa-512x512|apple-touch-icon|icons)\.(png|svg)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'static-images',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Fuentes (woff2): cache-first inmutable.
            urlPattern: /\.(woff2|woff|ttf)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: { maxEntries: 8, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // Dev mode: show SW in dev server for testing install prompt
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
